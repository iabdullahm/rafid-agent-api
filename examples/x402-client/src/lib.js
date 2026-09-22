// Shared helpers for the Rafid Agent API x402 example client. This file never touches a
// wallet or private key by itself — only pay.js does, and only after the confirmation gate.
import "dotenv/config";
import { decodePaymentRequiredHeader } from "@x402/core/http";

export const RAFID_API_URL = (process.env.RAFID_API_URL || "https://api.rafidsystem.com").replace(/\/+$/, "");
export const ANALYZE_PATH = "/api/v1/x402/property/analyze";
export const ANALYZE_URL = RAFID_API_URL + ANALYZE_PATH;

// The exact payload specified for this example. This client never invents or edits pricing —
// price is entirely decided server-side (see GET /api/v1/pricing) and every amount printed
// below comes straight from the server's own PAYMENT-REQUIRED / PAYMENT-RESPONSE headers.
export const TEST_PAYLOAD = Object.freeze({
  propertyValue: 85000,
  annualRent: 7200,
  serviceCharge: 650,
  maintenanceCost: 400
});

// Display-only lookup, so the console output can show "$0.01 USDC" next to the raw atomic
// amount the server quoted, for the handful of networks Rafid Agent API currently supports.
// This is NEVER consulted to decide what to pay: the real payment (in pay.js, via
// @x402/fetch + @x402/evm) always pays the exact asset address and atomic amount the server
// returns in real time, regardless of whether this table recognizes that asset.
const KNOWN_ASSETS = {
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": { symbol: "USDC", decimals: 6, network: "Base Mainnet" },
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e": { symbol: "USDC", decimals: 6, network: "Base Sepolia (testnet)" }
};

/**
 * Formats a raw atomic token amount (a decimal-string integer, e.g. "10000") into a human
 * amount using this file's display-only asset table, falling back to the raw units for an
 * asset it doesn't recognize instead of guessing.
 */
export function formatAssetAmount(atomicAmount, assetAddress) {
  const known = KNOWN_ASSETS[assetAddress];
  if (!known) return `${atomicAmount} raw atomic units of ${assetAddress}`;
  const value = Number(atomicAmount) / 10 ** known.decimals;
  let amountStr = value.toFixed(known.decimals);
  if (amountStr.includes(".")) amountStr = amountStr.replace(/0+$/, "").replace(/\.$/, "");
  return `$${amountStr} ${known.symbol}`;
}

export function networkLabel(network) {
  if (network === "eip155:8453") return "Base Mainnet (eip155:8453) — REAL money";
  if (network === "eip155:84532") return "Base Sepolia (eip155:84532) — testnet, no real value";
  return network;
}

/**
 * Calls the paid endpoint with NO payment header at all, expects a 402, and decodes the
 * PAYMENT-REQUIRED response header into the machine-readable payment requirements the x402
 * v2 protocol defines. Never touches a wallet. Throws if the server doesn't respond with the
 * 402 + header shape this client expects (surfaced as a compatibility problem, not silently
 * swallowed).
 */
export async function fetchUnpaidQuote(url = ANALYZE_URL, payload = TEST_PAYLOAD) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const status = response.status;
  const header = response.headers.get("payment-required");
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (status !== 402) {
    return { status, header: null, decoded: null, body };
  }
  if (!header) {
    throw new Error(
      `Server returned 402 but no PAYMENT-REQUIRED header — this client expects the x402 v2 ` +
      `protocol's header-based declaration. Response body: ${JSON.stringify(body)}`
    );
  }
  const decoded = decodePaymentRequiredHeader(header);
  return { status, header, decoded, body };
}

/** Prints the decoded PAYMENT-REQUIRED declaration in the exact shape the task asked for:
 *  HTTP status, network, asset, amount, payTo — plus the full raw decoded object for anyone
 *  who wants to see everything the server actually sent. */
export function printUnpaidQuote({ status, decoded }) {
  console.log(`\nHTTP status: ${status} Payment Required\n`);
  if (!decoded) {
    console.log("(No PAYMENT-REQUIRED header — see the error above.)");
    return;
  }
  const option = decoded.accepts?.[0];
  console.log("Decoded PAYMENT-REQUIRED:");
  if (option) {
    console.log(`  Network:  ${networkLabel(option.network)}`);
    console.log(`  Asset:    ${option.asset}`);
    console.log(`  Amount:   ${formatAssetAmount(option.amount, option.asset)} (raw: ${option.amount})`);
    console.log(`  Pay to:   ${option.payTo}`);
    console.log(`  Scheme:   ${option.scheme}`);
  } else {
    console.log("  (accepts[] was empty — nothing to summarize)");
  }
  console.log("\nFull decoded payload:");
  console.log(JSON.stringify(decoded, null, 2));
}

/** Truthy env-var check, tolerant of "true"/"1"/"yes" (case-insensitive). */
export function isTruthyEnv(name) {
  return ["true", "1", "yes"].includes(String(process.env[name] ?? "").toLowerCase());
}
