/**
 * End-to-end MPP SESSION test against a real Tempo TESTNET deployment of Rafid.
 *
 *   npm run e2e:session
 *
 * Refuses to run unless the target reports Tempo testnet (chain 42431). Never touches mainnet,
 * never prints the private key, and prints only public values (session id, channel id, tx hashes).
 *
 * Steps (every number in the final report is read back from the server or the chain):
 *   1. create a small session (402 → mppx opens a real payment channel → 201)
 *   2. two differently priced paid tool calls (each answered with a signed voucher)
 *   3. read usage (GET /sessions/:id)
 *   4. retry call #1 with the SAME Idempotency-Key → must be a replay, charge 0
 *   5. an over-budget call → must be refused before execution
 *   6. close with the payer's close credential (mppx sessionManager.close())
 *   7. read the session + the channel on-chain → settlement verified only if the on-chain
 *      settled amount equals Rafid's metered spend.
 */
import { sessionManager } from "mppx/client";
import { Session } from "mppx/tempo";
import { createClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { BASE_URL, json, requireKey } from "./lib.js";

const TESTNET_CHAIN_ID = 42431;
const BUDGET_USD = Number(process.env.E2E_BUDGET_USD ?? "0.05");
const CHEAP = { tool: "analyze_property", input: { propertyValue: 85000, annualRent: 7200, serviceCharge: 650, maintenanceCost: 400 } };
const MID = { tool: "compare_properties", input: { properties: [{ name: "A", propertyValue: 85000, annualRent: 7200 }, { name: "B", propertyValue: 100000, annualRent: 7000 }] } };
const EXPENSIVE = { tool: "analyze_oman_property", input: { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 } };

const MICROS = 1_000_000;
const usd = (micros: number) => (micros / MICROS).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const toMicros = (n: number) => Math.round(n * MICROS);
const failures: string[] = [];
const check = (ok: boolean, label: string) => { if (!ok) failures.push(label); return ok; };
const step = (n: number, text: string) => console.log(`\n[${n}] ${text}`);
class Stop extends Error {}
/** Ends the run with exit code 1 WITHOUT process.exit(): calling process.exit() right after
 *  fetch() trips a libuv assertion on Windows (UV_HANDLE_CLOSING). */
const stop = (...parts: unknown[]): never => { console.error(...parts); throw new Stop(); };

async function main() {

// ---- 0. Safety: testnet only -------------------------------------------------------------------
const status = (await json(await fetch(`${BASE_URL}/api/v1/mpp/status`))).data;
if (!status?.enabled || !status.modes?.includes("session")) {
  stop(`MPP session mode is not enabled on ${BASE_URL} (GET /api/v1/mpp/status → enabled=${status?.enabled}, modes=${JSON.stringify(status?.modes)}). Point RAFID_BASE_URL at a deployment with MPP_ENABLED=true, MPP_MODES=charge,session and MPP_NETWORK=tempo-testnet.`);
}
const chainId = status.network?.chainId ?? (status.testnet ? TESTNET_CHAIN_ID : null);
if (status.testnet !== true || chainId !== TESTNET_CHAIN_ID) {
  stop(`Refusing to run: ${BASE_URL} is not on Tempo testnet (testnet=${status.testnet}, chainId=${chainId}). This script never uses mainnet.`);
}
const account = privateKeyToAccount(requireKey());
const rpcUrl = process.env.TEMPO_TESTNET_RPC_URL || undefined;
const client = createClient({ chain: tempoModerato, transport: http(rpcUrl) });
const manager = sessionManager({
  account, client, maxDeposit: process.env.MPP_CLIENT_MAX_DEPOSIT ?? "1", allowedChainIds: [TESTNET_CHAIN_ID]
});
console.log(`Target:  ${BASE_URL} (Tempo testnet, chain ${TESTNET_CHAIN_ID})`);
console.log(`Payer:   ${account.address}`);

const postWith = (f: typeof fetch, path: string, body: unknown, headers: Record<string, string> = {}) =>
  f(BASE_URL + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const managerFetch = manager.fetch.bind(manager) as unknown as typeof fetch;

// ---- 1. create + open ----------------------------------------------------------------------------
step(1, `Create a ${BUDGET_USD} USD session and open the channel`);
const allowedTools = [CHEAP.tool, MID.tool, EXPENSIVE.tool];
const createdRes = await postWith(managerFetch, "/api/v1/mpp/sessions", { maxBudget: BUDGET_USD, currency: "USD", allowedTools });
const created = await json(createdRes);
if (createdRes.status !== 201 || !created.success) stop("Session open failed:", createdRes.status, JSON.stringify(created.error ?? created));
const sessionId: string = created.data.sessionId;
const channelId: string = created.data.payment?.channelId ?? manager.channelId;
console.log(`    session ${sessionId} → ${created.data.status}; channel ${channelId}; open tx ${created.data.payment?.authorizationReference ?? "(n/a)"}`);

// ---- 2. two paid calls at different prices -------------------------------------------------------
step(2, "Two paid tool calls at different prices");
const idem1 = `e2e-${CHEAP.tool}-${crypto.randomUUID()}`;
const call = async (t: { tool: string; input: unknown }, idem: string) => {
  const res = await postWith(managerFetch, `/api/v1/mpp/sessions/${sessionId}/tools/${t.tool}`, t.input, { "Idempotency-Key": idem });
  const body = await json(res);
  if (res.status !== 200 || !body.success) stop(`${t.tool} failed:`, res.status, JSON.stringify(body.error ?? body));
  console.log(`    ${t.tool}: charged ${body.usage.charge}, spent ${body.usage.spent}, remaining ${body.usage.remaining}`);
  return body.usage as { charge: number; spent: number; remaining: number };
};
const u1 = await call(CHEAP, idem1);
const u2 = await call(MID, `e2e-${MID.tool}-${crypto.randomUUID()}`);
const expectedMicros = toMicros(u1.charge) + toMicros(u2.charge);
check(u1.charge !== u2.charge, "the two calls had different prices");

// ---- 3. usage ------------------------------------------------------------------------------------
step(3, "Read usage");
const view = (await json(await fetch(`${BASE_URL}/api/v1/mpp/sessions/${sessionId}`))).data;
console.log(`    spent ${view.spent}, remaining ${view.remaining}, calls ${view.calls}, byTool ${JSON.stringify(view.usageByTool)}`);
check(toMicros(view.spent) === expectedMicros, "metered spend equals the sum of the two prices");
check(view.calls === 2, "two calls metered");

// ---- 4. idempotent retry (plain fetch, no payment credential at all) ----------------------------
step(4, "Retry call #1 with the same Idempotency-Key");
const replayRes = await postWith(fetch, `/api/v1/mpp/sessions/${sessionId}/tools/${CHEAP.tool}`, CHEAP.input, { "Idempotency-Key": idem1 });
const replay = await json(replayRes);
const afterReplay = (await json(await fetch(`${BASE_URL}/api/v1/mpp/sessions/${sessionId}`))).data;
const duplicateNotCharged = replayRes.status === 200 && replay.usage?.idempotentReplay === true && replay.usage?.charge === 0 && toMicros(afterReplay.spent) === expectedMicros && afterReplay.calls === 2;
console.log(`    HTTP ${replayRes.status}, Idempotent-Replay=${replayRes.headers.get("idempotent-replay")}, charge ${replay.usage?.charge}, spent still ${afterReplay.spent}`);
check(duplicateNotCharged, "duplicate request was not charged");

// ---- 5. over-budget ------------------------------------------------------------------------------
step(5, `Over-budget call (${EXPENSIVE.tool})`);
const overRes = await postWith(fetch, `/api/v1/mpp/sessions/${sessionId}/tools/${EXPENSIVE.tool}`, EXPENSIVE.input, { "Idempotency-Key": `e2e-over-${crypto.randomUUID()}` });
const over = await json(overRes);
const afterOver = (await json(await fetch(`${BASE_URL}/api/v1/mpp/sessions/${sessionId}`))).data;
const overBudgetRejected = over.error?.code === "MPP_SESSION_BUDGET_EXCEEDED" && afterOver.calls === 2 && toMicros(afterOver.spent) === expectedMicros && !afterOver.usageByTool?.[EXPENSIVE.tool];
console.log(`    HTTP ${overRes.status} ${over.error?.code}: required ${over.required}, remaining ${over.remaining}; calls still ${afterOver.calls}`);
check(overBudgetRejected, "over-budget call was rejected and the tool did not execute");

// ---- 6. close (payer close credential) -----------------------------------------------------------
step(6, "Close the session (payer close credential via mppx sessionManager.close())");
let closeTx: string | null = null;
let closePath = "payer-close";
try {
  const receipt = await manager.close();
  closeTx = (receipt as { txHash?: string } | undefined)?.txHash ?? null;
} catch (error) {
  closePath = "server-settle-fallback";
  console.log(`    sessionManager.close() failed (${error instanceof Error ? error.message : "error"}); falling back to POST /close`);
  const r = await json(await postWith(fetch, `/api/v1/mpp/sessions/${sessionId}/close`, {}));
  console.log(`    close → ${r.data?.status}, settlement ${JSON.stringify(r.data?.settlement)}`);
}

// ---- 7. settlement -------------------------------------------------------------------------------
step(7, "Verify settlement (server record + on-chain channel)");
const final = (await json(await fetch(`${BASE_URL}/api/v1/mpp/sessions/${sessionId}`))).data;
const onChain = await Session.Precompile.Chain.getChannelState(client as never, channelId as `0x${string}`)
  .then(s => ({ settled: BigInt(s.settled), deposit: BigInt(s.deposit) }))
  .catch((error: unknown) => { console.log(`    on-chain read failed: ${error instanceof Error ? error.message : "error"}`); return null; });
const onChainSettled = onChain ? Number(onChain.settled) : null;
const depositMicros = onChain ? Number(onChain.deposit) : toMicros(Number(view.payment?.channel?.deposit ?? 0));
const sessionClosed = final.status === "closed";
const settlementVerified = sessionClosed && final.settlement?.status === "settled" && onChainSettled === expectedMicros;
check(sessionClosed, "session is closed");
check(settlementVerified, "on-chain settled amount equals the metered spend and the server reports settled");

// ---- report --------------------------------------------------------------------------------------
const mark = (ok: boolean, yes: string, no: string) => (ok ? yes : no);
console.log(`
==================== MPP session E2E (Tempo testnet) ====================
Deposit:            ${usd(depositMicros)} USD (budget ${final.maxBudget} USD)
Tool calls:         ${final.calls} (${CHEAP.tool} ${u1.charge} + ${MID.tool} ${u2.charge})
Expected spend:     ${usd(expectedMicros)} USD
Metered spend:      ${final.spent} USD
Remaining:          ${final.remaining} USD
Duplicate:          ${mark(duplicateNotCharged, "NOT CHARGED", "CHARGED / UNEXPECTED")}
Over-budget:        ${mark(overBudgetRejected, "REJECTED (tool not executed)", "NOT REJECTED")}
Session:            ${mark(sessionClosed, "CLOSED", String(final.status).toUpperCase())}
Settlement:         ${mark(settlementVerified, "VERIFIED", "NOT VERIFIED")} (server: ${final.settlement?.status}; on-chain settled: ${onChainSettled === null ? "unknown" : usd(onChainSettled) + " USD"})
------------------------------------------------------------------------
Session id:         ${sessionId}
Channel id:         ${channelId}
Open tx:            ${final.payment?.authorizationReference ?? created.data.payment?.authorizationReference ?? "(n/a)"}
Close/settle tx:    ${closeTx ?? final.settlement?.reference ?? "(none)"}
Close path:         ${closePath}
========================================================================`);
if (failures.length) stop("FAILED checks:\n - " + failures.join("\n - "));
console.log("ALL CHECKS PASSED");
}

await main().catch(error => {
  if (!(error instanceof Stop)) console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
