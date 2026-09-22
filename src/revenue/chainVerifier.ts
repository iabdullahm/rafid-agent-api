import type { RevenueSettlement } from "./types.js";

/**
 * Optional, standalone on-chain verification abstraction for a settled x402 payment — spec
 * section 10 ("SettlementChainVerifier"). This is deliberately NOT wired into any revenue
 * endpoint or the settlement-capture path (src/revenue/settlementCapture.ts): the revenue ledger
 * must function purely from facilitator-confirmed settlement (the x402 SDK's own settle
 * response), exactly as the spec requires, whether or not a chain verifier is ever configured or
 * called. This module exists so an operator (or a future reconciliation job) CAN independently
 * confirm a settled row against the chain itself, on demand — a second, optional check, never a
 * dependency of the first.
 *
 * Verifies, for one settlement row:
 *   1. the transaction exists on chain (and succeeded on-chain, not just that a hash was returned)
 *   2. the RPC endpoint's chain id matches the settlement's recorded network
 *   3. a USDC ERC-20 Transfer log in that transaction's receipt carries the expected atomic amount
 *   4. that Transfer's recipient matches this deployment's configured receiving wallet (payToAddress)
 *
 * Configuration is entirely environment-variable driven (see getChainVerifierConfig() below) —
 * no blockchain-explorer API key is ever hardcoded here, matching the spec's explicit
 * instruction. When no RPC endpoint is configured, createSettlementChainVerifier() returns
 * ManualSettlementChainVerifier, whose verify() always reports status "not_configured" rather
 * than silently no-opping as if verification passed — an operator must configure CHAIN_RPC_URL
 * (and, per network, the matching USDC contract address) to get a real answer. This is the
 * expected state for the first implementation: "may be optional/manual if a reliable RPC/
 * provider is not configured" (spec section 10).
 */

export type ChainVerificationStatus = "verified" | "mismatch" | "not_found" | "not_configured" | "error";

export interface ChainVerificationChecks {
  transactionExists: boolean | null;
  networkMatches: boolean | null;
  amountMatches: boolean | null;
  recipientMatches: boolean | null;
}

export interface ChainVerificationResult {
  status: ChainVerificationStatus;
  checks: ChainVerificationChecks;
  /** Human-readable explanation — never a proof, signature, or secret. */
  detail: string;
}

export interface SettlementChainVerifier {
  verify(settlement: RevenueSettlement): Promise<ChainVerificationResult>;
}

const NOT_RUN: ChainVerificationChecks = { transactionExists: null, networkMatches: null, amountMatches: null, recipientMatches: null };

/** The default verifier whenever no RPC endpoint is configured (see createSettlementChainVerifier
 *  below). Never claims a settlement is verified — the revenue ledger and every internal revenue
 *  endpoint are already fully functional using only facilitator-confirmed settlement data; this
 *  is simply honest about the fact that no independent on-chain check has been performed. */
export class ManualSettlementChainVerifier implements SettlementChainVerifier {
  async verify(_settlement: RevenueSettlement): Promise<ChainVerificationResult> {
    return {
      status: "not_configured",
      checks: NOT_RUN,
      detail: "No on-chain RPC endpoint is configured (CHAIN_RPC_URL) — this settlement was accepted from facilitator-confirmed settlement data only, per the revenue ledger's normal operation. Configure CHAIN_RPC_URL and a USDC contract address to enable independent on-chain verification."
    };
  }
}

/** USDC's standard decimal precision — see settlementCapture.ts's identical constant and doc
 *  comment for why this is safe to assume across this codebase's supported networks. Redeclared
 *  here rather than imported so this optional, rarely-loaded module has no dependency on the
 *  always-loaded settlement-capture path. */
const USDC_DECIMALS = 6;

/** keccak256("Transfer(address,address,uint256)") — the standard ERC-20 Transfer event topic.
 *  This is a public, universal Ethereum standard constant (not a secret, not an API key, not
 *  specific to any deployment or provider), identical for every ERC-20 token on every EVM chain. */
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Minimal shape this verifier needs from an Ethereum JSON-RPC `eth_getTransactionReceipt`
 *  result — only the fields actually read below, not the full spec. */
interface MinimalTransactionReceipt {
  status: string | null; // "0x1" success, "0x0" failure, null if not yet mined
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/** A minimal JSON-RPC caller: `(method, params) => result`. Injectable so this class can be
 *  fully unit-tested against a mocked provider — see tests/revenue.test.ts — without ever making
 *  a real network call. The default implementation (buildJsonRpcCaller below) POSTs to the
 *  configured CHAIN_RPC_URL. */
export type JsonRpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function buildJsonRpcCaller(rpcUrl: string): JsonRpcCall {
  return async (method, params) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "JSON-RPC error");
    return body.result;
  };
}

/** Extracts the numeric chain id from a CAIP-2 network identifier (e.g. "eip155:8453" -> 8453).
 *  Returns null for a non-EVM/unrecognized format rather than throwing — this verifier only
 *  supports EVM (eip155) networks, matching this codebase's only configured payment scheme
 *  (@x402/evm's ExactEvmScheme — see settlementCapture.ts's doc comment). */
function eip155ChainId(network: string): number | null {
  const match = /^eip155:(\d+)$/.exec(network);
  return match ? Number(match[1]) : null;
}

function padAddressTopic(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/**
 * Real (optional) EVM implementation: reads a transaction receipt from a configured JSON-RPC
 * endpoint and checks it against the settlement row. Never called from the settlement-capture or
 * revenue-aggregation path — see this module's doc comment. Construct via
 * createSettlementChainVerifier(), not directly, so configuration stays centralized.
 */
export class EvmRpcSettlementChainVerifier implements SettlementChainVerifier {
  constructor(
    private readonly rpcCall: JsonRpcCall,
    private readonly usdcContractByNetwork: Readonly<Record<string, string>>
  ) {}

  async verify(settlement: RevenueSettlement): Promise<ChainVerificationResult> {
    if (!settlement.transactionHash) {
      return { status: "not_found", checks: NOT_RUN, detail: "This settlement row has no transaction hash to verify." };
    }
    const expectedChainId = eip155ChainId(settlement.network);
    if (expectedChainId === null) {
      return { status: "error", checks: NOT_RUN, detail: `Unsupported network format for on-chain verification: ${settlement.network}` };
    }
    const usdcContract = this.usdcContractByNetwork[settlement.network];
    if (!usdcContract) {
      return { status: "not_configured", checks: NOT_RUN, detail: `No USDC contract address configured for network ${settlement.network} — set CHAIN_USDC_CONTRACT_<NETWORK>.` };
    }

    let receipt: MinimalTransactionReceipt | null;
    let actualChainIdHex: string;
    try {
      [receipt, actualChainIdHex] = (await Promise.all([
        this.rpcCall("eth_getTransactionReceipt", [settlement.transactionHash]),
        this.rpcCall("eth_chainId", [])
      ])) as [MinimalTransactionReceipt | null, string];
    } catch (error) {
      return { status: "error", checks: NOT_RUN, detail: `RPC call failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!receipt) {
      return { status: "not_found", checks: { ...NOT_RUN, transactionExists: false }, detail: `No receipt found for transaction ${settlement.transactionHash} on the configured RPC endpoint.` };
    }
    const transactionExists = receipt.status === "0x1";
    const networkMatches = Number(actualChainIdHex) === expectedChainId;

    let amountMatches: boolean | null = null;
    let recipientMatches: boolean | null = null;
    const expectedRecipientTopic = padAddressTopic(settlement.payToAddress);
    const transferLog = receipt.logs.find(l =>
      l.address.toLowerCase() === usdcContract.toLowerCase() &&
      l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
      l.topics.length >= 3
    );
    if (transferLog) {
      recipientMatches = transferLog.topics[2]!.toLowerCase() === expectedRecipientTopic.toLowerCase();
      if (settlement.amountAtomic !== null) {
        try {
          const onChainAtomic = BigInt(transferLog.data).toString();
          amountMatches = onChainAtomic === settlement.amountAtomic;
        } catch {
          amountMatches = false;
        }
      }
    } else {
      recipientMatches = false;
      amountMatches = settlement.amountAtomic !== null ? false : null;
    }

    const checks: ChainVerificationChecks = { transactionExists, networkMatches, amountMatches, recipientMatches };
    const allKnownChecksPass = [transactionExists, networkMatches, amountMatches, recipientMatches]
      .filter((c): c is boolean => c !== null)
      .every(Boolean);
    const status: ChainVerificationStatus = allKnownChecksPass ? "verified" : "mismatch";
    return {
      status, checks,
      detail: status === "verified"
        ? `Transaction ${settlement.transactionHash} confirmed on-chain: succeeded, correct network, USDC transfer to the configured Rafid wallet${amountMatches !== null ? " for the expected amount" : ""}.`
        : `On-chain check(s) failed or could not be fully confirmed for transaction ${settlement.transactionHash} — see checks.`
    };
  }
}

/** How the USDC contract address per network is configured — env var driven, no hardcoded
 *  address baked into source (a USDC contract address isn't a secret, but keeping it in
 *  configuration lets this verifier support a network this codebase adds later without a code
 *  change). Example: CHAIN_USDC_CONTRACT_EIP155_8453=0x833589... for Base mainnet. The env var
 *  name is derived from the CAIP-2 network id with non-alphanumeric characters replaced by "_". */
function usdcContractEnvVarName(network: string): string {
  return `CHAIN_USDC_CONTRACT_${network.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface ChainVerifierConfig {
  rpcUrl: string | null;
  /** Populated lazily per-network from CHAIN_USDC_CONTRACT_<NETWORK> — see
   *  usdcContractEnvVarName() above. Read once at startup via readUsdcContractsFromEnv(). */
  usdcContractByNetwork: Readonly<Record<string, string>>;
}

/** Reads every CHAIN_USDC_CONTRACT_* variable present in env, keyed back to the CAIP-2 network id
 *  it configures a contract for. No blockchain-explorer API key or contract address is ever
 *  hardcoded here — both come entirely from configuration, per the spec's explicit instruction. */
function readUsdcContractsFromEnv(env: NodeJS.ProcessEnv, knownNetworks: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const network of knownNetworks) {
    const value = env[usdcContractEnvVarName(network)];
    if (value) result[network] = value;
  }
  return result;
}

/** Networks this codebase might plausibly configure X402_NETWORK to — used only to look up which
 *  CHAIN_USDC_CONTRACT_* env vars to read; verify() itself works for any eip155 network whose
 *  contract address was configured, not just these. */
const KNOWN_EVM_NETWORKS = ["eip155:8453", "eip155:84532", "eip155:1", "eip155:11155111"] as const;

export function getChainVerifierConfig(env: NodeJS.ProcessEnv = process.env): ChainVerifierConfig {
  return {
    rpcUrl: env.CHAIN_RPC_URL?.trim() || null,
    usdcContractByNetwork: readUsdcContractsFromEnv(env, KNOWN_EVM_NETWORKS)
  };
}

/**
 * Builds the verifier this deployment should use: a real EvmRpcSettlementChainVerifier when
 * CHAIN_RPC_URL is configured, otherwise the honest ManualSettlementChainVerifier stub. Never
 * throws — an unconfigured or misconfigured environment simply means on-chain verification isn't
 * available yet, not a startup failure (the revenue ledger itself never depends on this).
 */
export function createSettlementChainVerifier(config: ChainVerifierConfig = getChainVerifierConfig()): SettlementChainVerifier {
  if (!config.rpcUrl) return new ManualSettlementChainVerifier();
  return new EvmRpcSettlementChainVerifier(buildJsonRpcCaller(config.rpcUrl), config.usdcContractByNetwork);
}
