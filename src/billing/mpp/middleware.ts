import express, { type Request, type RequestHandler, type Response } from "express";
import type { MppResult } from "./service.js";

/**
 * Express glue for the MPP rail: body parsing and response writing. Everything here is
 * transport-level; payment/billing decisions live in service.ts.
 */

const jsonParser = express.json({ limit: "32kb" });
const parsersByLimit = new Map<string, RequestHandler>();

/** JSON bodies only (415 otherwise) — an empty body is allowed where `optional` (e.g. close).
 *  `limitFor` (optional) picks a per-request body limit — e.g. the called tool's own
 *  requestBodyLimit — instead of the 32kb default. */
export function mppJsonBody(options: { optional?: boolean; limitFor?: (req: Request) => string | undefined } = {}): RequestHandler {
  return (req, res, next) => {
    const limit = options.limitFor?.(req);
    const parser = limit ? (parsersByLimit.get(limit) ?? parsersByLimit.set(limit, express.json({ limit })).get(limit)!) : jsonParser;
    const hasBody = Number(req.header("content-length") ?? "0") > 0 || req.header("transfer-encoding") !== undefined;
    if (!hasBody && options.optional) { req.body = {}; next(); return; }
    if (!req.is("application/json")) {
      res.status(415).json({ success: false, error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Use application/json" }, meta: { requestId: res.locals.requestId } });
      return;
    }
    parser(req, res, next);
  };
}

/** The full URL the caller reached (behind Vercel's TLS termination, like app.ts's getOrigin). */
export function requestUrl(req: Request): string {
  const proto = (req.header("x-forwarded-proto") ?? req.protocol).split(",")[0];
  return `${proto}://${req.get("host")}${req.originalUrl.split("?")[0]}`;
}

/** The MPP credential: `Authorization: Payment …`, or `Payment-Authorization` (the SDK's
 *  alternative header for deployments where Authorization carries app auth). */
export function paymentAuthorization(req: Request): string | undefined {
  const a = req.header("authorization");
  if (a && /^Payment\s/i.test(a)) return a;
  const p = req.header("payment-authorization");
  if (p) return /^Payment\s/i.test(p) ? p : `Payment ${p}`;
  return a;
}

export function requestIdOf(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
}

export function sendMppResult(res: Response, result: MppResult): void {
  for (const [k, v] of result.headers) res.setHeader(k, v);
  if (result.status === 402) res.type("application/json");
  res.status(result.status).json(result.body);
}
