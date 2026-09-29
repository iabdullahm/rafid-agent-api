import { randomInt } from "node:crypto";
import { buildJsonRpcCaller, type JsonRpcCall } from "../../revenue/chainVerifier.js";
import type { ExternalPaymentStore } from "./store.js";

/**
 * USDC-on-Base top-up: unique-amount correlation strategy + independent on-chain verification.
 *
 * USDC TRANSACTION CORRELATION STRATEGY (read this before changing anything here) ------------
 *
 * This deployment has exactly ONE configured receiving wallet (TOPUP_RECEIVING_ADDRESS — the same
 * shared-address model x402 already uses for its own settlements, see billing/x402.ts) and no
 * HD-wallet / per-customer address derivation, and this layer must never handle a private key
 * (see the spec's explicit prohibition). That rules out the strongest correlation mechanism —
 * "give every customer their own receiving address" — as genuinely unsupported by this
 * deployment's wallet setup, not merely unimplemented.
 *
 * Plain ERC-20 transfers on Base carry no memo/reference field the recipient can rely on (unlike
 * some other rails), so "amount + recipient" alone is NOT a safe correlation key — the spec
 * explicitly calls this out, since two customers topping up the same round number ($10, say)
 * would be indistinguishable.
 *
 * The approach implemented here — amount tagging — is the safest one this deployment's actual
 * wallet setup supports without inventing unsupported metadata: pickUniqueUsdcAmountTag() adds a
 * small, unique, sub-cent offset (1 to 9,999 micro-USD — $0.000001 to $0.009999) to the
 * customer's requested amount, and rafid_topup_intents enforces at the database level
 * (rafid_topup_intents_open_amount_uniq) that at most one OPEN intent may claim a given exact
 * tagged amount at a time. The customer must then send EXACTLY that tagged amount. Combined with:
 *   1. a topupId the customer must present at confirm time, itself bound to their authenticated
 *      billing account (see http.ts's requireBillingKey usage on the confirm route) — so a
 *      confirm call can only credit the account that created the intent, never a different one;
 *   2. a global uniqueness constraint on the on-chain transaction hash itself
 *      (rafid_external_payments_tx_hash_uniq) — a cryptographically unique identifier of the
 *      REAL transfer, so no two credits can ever come from the same on-chain event;
 *   3. independent on-chain verification of the actual transferred amount (never trusting the
 *      client-supplied amount — see verifyUsdcTransfer() below);
 * this is a verifier-supported design, not a "trust the client" one.
 *
 * KNOWN LIMITATION (documented, not hidden): this does not cryptographically prove WHO sent the
 * funds — there is no signature binding a specific customer to a specific transfer, only "the
 * exact tagged amount that only this customer's open intent currently claims arrived at the
 * shared wallet". Two failure modes follow from that: (a) a topup intent's tagged amount is only
 * unique while it stays OPEN and unexpired (30-60 minute window — see config.ts's
 * TOPUP_EXPIRY_MINUTES) — after expiry the same tagged amount can be reissued to a new intent, so
 * a very late transfer using an expired intent's exact amount will not match anything open and is
 * routed to manual review rather than guessed at (see service.ts's confirmUsdcTopup() late-payment
 * handling); (b) if a customer's topupId and its exact tagged amount both leaked to a third party
 * before the legitimate customer paid, that third party could front-run the credit by submitting
 * their own transfer of that amount first. Topup intents are never listed publicly and are
 * short-lived, which bounds this risk, but it is not eliminated — a future iteration with a real
 * per-customer deposit address (a custodial or smart-contract-wallet integration that still never
 * exposes a private key to this codebase) would close it. This limitation is called out again in
 * the final report rather than being quietly designed around.
 */

const MIN_TAG_MICROS = 1;
const MAX_TAG_MICROS = 9_999;
const MAX_TAG_ATTEMPTS = 25;

/** Adds a unique sub-cent tag to `requestedAmountAtomic` (micro-USD) so the exact on-chain
 *  transfer amount correlates to exactly one open intent for this recipient. Retries against
 *  ExternalPaymentStore.isAmountOpen() to avoid a collision with another currently-open intent;
 *  the database's own unique index (rafid_topup_intents_open_amount_uniq) is the final backstop
 *  if two requests race between this check and the insert. */
export async function pickUniqueUsdcAmount(store: ExternalPaymentStore, recipient: string, requestedAmountAtomic: number): Promise<number> {
  for (let attempt = 0; attempt < MAX_TAG_ATTEMPTS; attempt++) {
    const tag = randomInt(MIN_TAG_MICROS, MAX_TAG_MICROS + 1);
    const candidate = requestedAmountAtomic + tag;
    if (!(await store.isAmountOpen(recipient, candidate))) return candidate;
  }
  throw new Error("Could not find a collision-free top-up amount after several attempts — too many open USDC top-up intents for this recipient");
}

export type UsdcVerificationOutcome = "confirmed" | "pending" | "failed" | "not_found" | "wrong_network" | "wrong_recipient" | "wrong_amount" | "wrong_token" | "error";

export interface UsdcVerificationResult {
  outcome: UsdcVerificationOutcome;
  confirmations: number | null;
  /** The ACTUAL on-chain transferred amount, in USDC atomic units (never the amount the client
   *  claimed) — present whenever a matching Transfer log was found, regardless of outcome, so a
   *  mismatch can be reported precisely (see reconciliation.ts's amount_mismatch). */
  actualAmountUsdcAtomic: string | null;
  detail: string;
}

interface MinimalReceipt {
  status: string | null;
  blockNumber: string | null;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const padAddressTopic = (address: string): string => "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/**
 * Independently verifies a customer-submitted transaction hash against the chain itself — the
 * client-supplied amount/recipient/network are NEVER trusted; every one of these is re-derived
 * from the RPC response. Mirrors revenue/chainVerifier.ts's EvmRpcSettlementChainVerifier
 * (transaction-receipt + ERC-20 Transfer-log inspection), adapted to top-ups: a top-up needs an
 * EXACT tagged amount match (not "at least the requirement," never a range) and a confirmation
 * count (a settlement is checked once, well after the fact; a top-up may be checked moments after
 * broadcast, while still unconfirmed).
 */
export async function verifyUsdcTransfer(input: {
  rpcCall: JsonRpcCall;
  transactionHash: string;
  expectedChainId: number;
  usdcContract: string;
  expectedRecipient: string;
  expectedAmountUsdcAtomic: number;
  requiredConfirmations: number;
}): Promise<UsdcVerificationResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) {
    return { outcome: "not_found", confirmations: null, actualAmountUsdcAtomic: null, detail: "transactionHash is not a well-formed 32-byte hex hash" };
  }
  let receipt: MinimalReceipt | null;
  let chainIdHex: string;
  let currentBlockHex: string;
  try {
    [receipt, chainIdHex, currentBlockHex] = (await Promise.all([
      input.rpcCall("eth_getTransactionReceipt", [input.transactionHash]),
      input.rpcCall("eth_chainId", []),
      input.rpcCall("eth_blockNumber", [])
    ])) as [MinimalReceipt | null, string, string];
  } catch (error) {
    return { outcome: "error", confirmations: null, actualAmountUsdcAtomic: null, detail: `RPC call failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (Number(chainIdHex) !== input.expectedChainId) {
    return { outcome: "wrong_network", confirmations: null, actualAmountUsdcAtomic: null, detail: `RPC endpoint is on chain ${Number(chainIdHex)}, expected ${input.expectedChainId}` };
  }
  if (!receipt) {
    return { outcome: "not_found", confirmations: null, actualAmountUsdcAtomic: null, detail: "No transaction receipt found yet — it may still be in the mempool or the hash may be wrong" };
  }
  const transferLog = receipt.logs.find(l =>
    l.address.toLowerCase() === input.usdcContract.toLowerCase() &&
    l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
    l.topics.length >= 3
  );
  if (!transferLog) {
    const wrongTokenTransfer = receipt.logs.some(l => l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC);
    return { outcome: wrongTokenTransfer ? "wrong_token" : "not_found", confirmations: null, actualAmountUsdcAtomic: null, detail: wrongTokenTransfer ? "This transaction transferred a different token, not the configured USDC contract" : "This transaction contains no ERC-20 Transfer event" };
  }
  const actualRecipientTopic = transferLog.topics[2]!.toLowerCase();
  const expectedRecipientTopic = padAddressTopic(input.expectedRecipient);
  let actualAmountUsdcAtomic: string | null = null;
  try { actualAmountUsdcAtomic = BigInt(transferLog.data).toString(); } catch { /* leave null; reported below */ }
  if (receipt.status !== "0x1") {
    return { outcome: "failed", confirmations: null, actualAmountUsdcAtomic, detail: "The transaction reverted on-chain" };
  }
  if (actualRecipientTopic !== expectedRecipientTopic.toLowerCase()) {
    return { outcome: "wrong_recipient", confirmations: null, actualAmountUsdcAtomic, detail: "This transfer's recipient does not match the configured receiving address" };
  }
  if (actualAmountUsdcAtomic === null || actualAmountUsdcAtomic !== String(input.expectedAmountUsdcAtomic)) {
    return { outcome: "wrong_amount", confirmations: null, actualAmountUsdcAtomic, detail: `Transferred ${actualAmountUsdcAtomic ?? "an unparseable amount"} (atomic USDC), expected exactly ${input.expectedAmountUsdcAtomic}` };
  }
  const confirmations = receipt.blockNumber ? Number(currentBlockHex) - Number(receipt.blockNumber) + 1 : 0;
  if (confirmations < input.requiredConfirmations) {
    return { outcome: "pending", confirmations, actualAmountUsdcAtomic, detail: `${confirmations}/${input.requiredConfirmations} confirmations so far` };
  }
  return { outcome: "confirmed", confirmations, actualAmountUsdcAtomic, detail: `Confirmed with ${confirmations} confirmations` };
}

export { buildJsonRpcCaller, type JsonRpcCall };
