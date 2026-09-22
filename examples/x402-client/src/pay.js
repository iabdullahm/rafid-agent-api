#!/usr/bin/env node
// npm run test:x402-payment
//
// Full x402 flow against the live Rafid Agent API:
//   1. Call the paid endpoint with no payment (same as `npm run test:x402-unpaid`) and show
//      the decoded 402 quote.
//   2. If a real-money network is quoted, require an explicit typed confirmation before
//      spending anything (skippable only via X402_CONFIRM_MAINNET=true).
//   3. Perform the real x402 payment using the official client SDK (@x402/fetch + @x402/evm),
//      signed by the wallet in X402_PAYER_PRIVATE_KEY.
//   4. Print the final API response, plus safe settlement details (never a signature or key).
import readline from "node:readline/promises";
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import {
  ANALYZE_URL, TEST_PAYLOAD, fetchUnpaidQuote, printUnpaidQuote, formatAssetAmount, networkLabel, isTruthyEnv
} from "./lib.js";

async function confirmOrAbort(networkId) {
  if (isTruthyEnv("X402_CONFIRM_MAINNET")) {
    console.log("\nX402_CONFIRM_MAINNET=true — skipping the interactive confirmation prompt.");
    return true;
  }
  const isRealMoney = networkId === "eip155:8453";
  console.log(
    isRealMoney
      ? "\n⚠️  You are about to make a real USDC payment on Base Mainnet to Rafid Agent API."
      : `\n⚠️  You are about to send a real x402 payment on ${networkId} to Rafid Agent API.`
  );
  console.log("This will sign and broadcast an on-chain transaction from your configured wallet.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Type "PAY" (all caps) to continue, or anything else to abort: ');
    return answer.trim() === "PAY";
  } finally {
    rl.close();
  }
}

async function main() {
  console.log("Rafid Agent API x402 client example — full payment flow");
  console.log(`POST ${ANALYZE_URL}`);
  console.log(`Payload: ${JSON.stringify(TEST_PAYLOAD)}`);

  console.log("\n--- Step 1/3: unpaid request (no wallet touched yet) ---");
  const quote = await fetchUnpaidQuote();
  if (quote.status !== 402) {
    console.error(`\nExpected HTTP 402 to get a payment quote, got ${quote.status}. Aborting — nothing to pay.`);
    console.error(JSON.stringify(quote.body, null, 2));
    process.exitCode = 1;
    return;
  }
  printUnpaidQuote(quote);
  const option = quote.decoded?.accepts?.[0];
  if (!option) {
    console.error("\nNo payment option in the server's response — aborting.");
    process.exitCode = 1;
    return;
  }

  const privateKey = process.env.X402_PAYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error(
      "\nX402_PAYER_PRIVATE_KEY is not set. This is required to actually pay (it is never " +
      "required for `npm run test:x402-unpaid`). Copy .env.example to .env and set it, then " +
      "re-run this command. Nothing has been sent."
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n--- Step 2/3: confirmation ---");
  const confirmed = await confirmOrAbort(option.network);
  if (!confirmed) {
    console.log("\nAborted — no payment was sent.");
    return;
  }

  console.log("\n--- Step 3/3: paying and retrying the request ---");
  const account = privateKeyToAccount(privateKey);
  console.log(`Paying from wallet: ${account.address}`);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: option.network, client: new ExactEvmScheme(account) }]
  });

  let response;
  try {
    response = await fetchWithPayment(ANALYZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TEST_PAYLOAD)
    });
  } catch (error) {
    console.error(`\nPayment failed before a response was received: ${error.message}`);
    console.error(
      "Common causes: the wallet has insufficient USDC (or ETH for gas) on Base Mainnet, " +
      "or the private key is malformed. No details of the payment attempt are printed here " +
      "beyond this message."
    );
    process.exitCode = 1;
    return;
  }

  const body = await response.json().catch(() => null);
  console.log(`\nFinal HTTP status: ${response.status}`);
  console.log("Final API response:");
  console.log(JSON.stringify(body, null, 2));

  const settlementHeader = response.headers.get("payment-response") || response.headers.get("x-payment-response");
  if (settlementHeader) {
    const settlement = decodePaymentResponseHeader(settlementHeader);
    console.log("\nSettlement (safe fields only — never a signature or payment proof):");
    console.log(`  Success:     ${settlement.success}`);
    console.log(`  Network:     ${networkLabel(settlement.network)}`);
    console.log(`  Transaction: ${settlement.transaction}`);
    if (settlement.amount) console.log(`  Amount:      ${formatAssetAmount(settlement.amount, option.asset)} (raw: ${settlement.amount})`);
    if (settlement.payer) console.log(`  Payer:       ${settlement.payer}`);
    if (!settlement.success) {
      console.log(`  Error:       ${settlement.errorReason ?? ""} ${settlement.errorMessage ?? ""}`.trim());
    }
  } else {
    console.log("\n(No PAYMENT-RESPONSE settlement header on this response.)");
  }

  if (!response.ok) {
    console.error(`\nRequest did not succeed (HTTP ${response.status}) — see the response body above.`);
    process.exitCode = 1;
  } else {
    console.log("\nDone. This request was paid for on-chain and executed by Rafid Agent API.");
  }
}

main().catch(error => {
  console.error(`\nUnexpected error: ${error.message}`);
  process.exitCode = 1;
});
