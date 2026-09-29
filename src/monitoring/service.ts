import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { BillingEngine } from "../billing/unified/engine.js";
import { requireBillingKey, fail } from "../billing/unified/http.js";
import { capabilities } from "../domain/capabilities.js";

export const monitoringPath = "/api/v1/account/monitoring";
export const monitoringCronPath = "/api/internal/monitoring/run-due";
const cadence = z.enum(["weekly", "monthly"]);
const kind = z.enum(["company_risk", "supplier", "property_price", "negative_news"]);
const createInput = z.object({ kind, tool: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()), cadence, webhookUrl: z.string().url().max(2048).optional() }).strict();

const sql = `
CREATE TABLE IF NOT EXISTS monitoring_jobs (
 id text PRIMARY KEY, account_id text NOT NULL, api_key_id text NOT NULL, kind text NOT NULL,
 tool_name text NOT NULL, input jsonb NOT NULL, cadence text NOT NULL CHECK (cadence IN ('weekly','monthly')),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','canceled')),
 webhook_url text, next_run_at timestamptz NOT NULL, last_run_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monitoring_jobs_due_idx ON monitoring_jobs(status,next_run_at);
CREATE TABLE IF NOT EXISTS monitoring_runs (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES monitoring_jobs(id), status text NOT NULL,
 result jsonb, error text, changed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monitoring_runs_job_idx ON monitoring_runs(job_id,created_at DESC);`;

function addCadence(date: Date, value: "weekly" | "monthly") { const d = new Date(date); if (value === "weekly") d.setUTCDate(d.getUTCDate() + 7); else d.setUTCMonth(d.getUTCMonth() + 1); return d; }
function sign(secret: string, body: string) { return "sha256=" + createHmac("sha256", secret).update(body).digest("hex"); }

export class MonitoringService {
  readonly pool: Pool;
  constructor(databaseUrl: string, private readonly engine: BillingEngine, private readonly webhookSecret: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 5 }); }
  async migrate() { await this.pool.query(sql); }
  async close() { await this.pool.end(); }
  async create(accountId: string, apiKeyId: string, raw: unknown) {
    const v = createInput.parse(raw); const c = capabilities.find(x => x.name === v.tool);
    if (!c || !["company_risk_report", "supplier_due_diligence_report", "property_investment_report"].includes(v.tool)) throw new Error("unsupported_monitoring_tool");
    const id = "mon_" + randomUUID().replaceAll("-", ""); const next = new Date();
    await this.pool.query("INSERT INTO monitoring_jobs(id,account_id,api_key_id,kind,tool_name,input,cadence,webhook_url,next_run_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, accountId, apiKeyId, v.kind, v.tool, JSON.stringify(v.input), v.cadence, v.webhookUrl ?? null, next]);
    return { id, accountId, apiKeyId, kind: v.kind, tool: v.tool, cadence: v.cadence, status: "active", nextRunAt: next.toISOString(), webhook: Boolean(v.webhookUrl) };
  }
  async list(accountId: string) { const r = await this.pool.query("SELECT * FROM monitoring_jobs WHERE account_id=$1 AND status <> 'canceled' ORDER BY created_at DESC", [accountId]); return r.rows.map(row => row); }
  async results(accountId: string, id: string) { const own = await this.pool.query("SELECT id FROM monitoring_jobs WHERE id=$1 AND account_id=$2", [id, accountId]); if (!own.rowCount) throw new Error("monitoring_not_found"); const r = await this.pool.query("SELECT * FROM monitoring_runs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 100", [id]); return r.rows; }
  async runDue() {
    const jobs = (await this.pool.query("SELECT * FROM monitoring_jobs WHERE status='active' AND next_run_at <= now() ORDER BY next_run_at LIMIT 50")).rows; let ran = 0;
    for (const job of jobs) {
      const locked = await this.pool.query("UPDATE monitoring_jobs SET next_run_at=$2,last_run_at=now() WHERE id=$1 AND status='active' AND next_run_at <= now() RETURNING *", [job.id, addCadence(new Date(), job.cadence)]); if (!locked.rowCount) continue;
      const key = (await this.engine.store.listApiKeys(job.account_id)).find(k => k.id === job.api_key_id); if (!key) continue;
      const account = await this.engine.store.getAccount(job.account_id); if (!account) continue;
      const runId = "run_" + randomUUID().replaceAll("-", ""); let result: unknown = null; let status = "succeeded"; let error: string | null = null; let authorization: Awaited<ReturnType<BillingEngine["authorize"]>> | null = null;
      try { authorization = await this.engine.authorize({ toolName: job.tool_name, account, key, rails: ["subscription", "api_credits"], subscriptionFallback: true, requestId: runId }); if (authorization.kind !== "authorized") throw new Error(authorization.kind); const tool = capabilities.find(c => c.name === job.tool_name)!; result = await tool.execute(job.input); await this.engine.settle(authorization.authorization); } catch (e) { if (authorization?.kind === "authorized") await this.engine.release(authorization.authorization, "monitoring execution failed").catch(() => {}); status = "failed"; error = e instanceof Error ? e.message : "monitoring_run_failed"; }
      const body = JSON.stringify({ id: runId, monitoringId: job.id, status, result, error, occurredAt: new Date().toISOString() }); await this.pool.query("INSERT INTO monitoring_runs(id,job_id,status,result,error) VALUES($1,$2,$3,$4,$5)", [runId, job.id, status, result ? JSON.stringify(result) : null, error]);
      if (job.webhook_url) { try { await fetch(job.webhook_url, { method: "POST", headers: { "content-type": "application/json", "x-rafid-signature": sign(this.webhookSecret, body) }, body, signal: AbortSignal.timeout(10000) }); } catch {} }
      ran++;
    } return { ran };
  }
}

export function createMonitoringRoutes(deps: { service: MonitoringService; engine: BillingEngine; limiter: RequestHandler; cronSecret: string }) {
  const r = Router(); const auth = requireBillingKey(deps.engine); const account = (res: any) => res.locals.billingAccount.id;
  r.use(monitoringPath, deps.limiter, auth);
  r.post(monitoringPath, express.json({ limit: "256kb" }), async (req, res, next) => { try { res.status(201).json({ success: true, data: await deps.service.create(account(res), res.locals.billingKey.id, req.body) }); } catch (e) { next(e); } });
  r.get(monitoringPath, async (req, res, next) => { try { res.json({ success: true, data: await deps.service.list(account(res)) }); } catch (e) { next(e); } });
  r.get(monitoringPath + "/:id/results", async (req, res, next) => { try { res.json({ success: true, data: await deps.service.results(account(res), String(req.params.id)) }); } catch (e) { next(e); } });
  r.post(monitoringCronPath, async (req, res, next) => { if (!deps.cronSecret || req.header("authorization") !== `Bearer ${deps.cronSecret}`) return fail(res, 401, "unauthorized", "Monitoring cron authorization required"); try { res.json({ success: true, data: await deps.service.runDue() }); } catch (e) { next(e); } });
  return r;
}
