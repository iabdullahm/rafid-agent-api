/**
 * Deduplication strategy for the revenue ledger — see revenue/types.ts's RevenueLedger.record()
 * doc comment for why this must never double-count. Preferred key: `network + transactionHash`,
 * since a real on-chain transaction hash is globally unique per network and is the strongest
 * available signal that two observations are the exact same settlement (e.g. a client retry that
 * re-triggers this codebase's own res.on("finish") observation for a request whose payment had
 * already settled, or — in a hypothetical future — a facilitator webhook redelivery). Fallback,
 * for the rare row with no transaction hash at all (a settlement_failed row whose payment never
 * reached broadcast — see settlementCapture.ts): `requestId + toolName`, which is already unique
 * per HTTP request in this codebase (api/app.ts's request-id middleware assigns a fresh
 * randomUUID() to every request), so it can never collide across two different requests even
 * though it carries no on-chain identity of its own.
 *
 * Both branches are namespaced (`tx:`/`req:`) so a pathological transactionHash value could never
 * be crafted to collide with a requestId in the fallback branch, or vice versa.
 */
export function buildSettlementDedupeKey(args: {
  network: string;
  transactionHash: string | null;
  requestId: string;
  toolName: string;
}): string {
  if (args.transactionHash) return `tx:${args.network}:${args.transactionHash}`;
  return `req:${args.requestId}:${args.toolName}`;
}
