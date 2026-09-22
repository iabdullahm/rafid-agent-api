#!/usr/bin/env node
// npm run test:x402-unpaid
//
// Demonstrates step 1 of the x402 flow only: calling the paid endpoint with NO payment and
// showing the machine-readable 402 quote the server returns. Requires no wallet, no private
// key, and never sends a transaction — safe to run any time, by anyone, with nothing in .env
// except (optionally) RAFID_API_URL.
import { ANALYZE_URL, TEST_PAYLOAD, fetchUnpaidQuote, printUnpaidQuote } from "./lib.js";

console.log(`Rafid Agent API x402 client example — unpaid request only (no wallet needed)`);
console.log(`POST ${ANALYZE_URL}`);
console.log(`Payload: ${JSON.stringify(TEST_PAYLOAD)}`);

const result = await fetchUnpaidQuote(ANALYZE_URL, TEST_PAYLOAD);

if (result.status !== 402) {
  console.log(`\nExpected HTTP 402, got ${result.status}. Response body:`);
  console.log(JSON.stringify(result.body, null, 2));
  console.log(
    `\nIf X402_ENABLED is currently false on the server, or the endpoint/network changed, ` +
    `this is expected — check GET ${new URL(ANALYZE_URL).origin}/api/v1/x402/status.`
  );
  process.exitCode = 1;
} else {
  printUnpaidQuote(result);
  console.log(`\nThis is exactly what an x402-aware client (see: npm run test:x402-payment) reads before paying.`);
}
