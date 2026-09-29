// Node x402 client for Rafid's pay-per-call routes.
// The private key is read only by this local client process and is never sent to Rafid.
// Use a dedicated wallet with USDC on Base and a strict spend limit in production.

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = "https://api.rafidsystem.com";
const NETWORK = "eip155:8453";

function createX402HttpClient() {
  const privateKey = process.env.X402_CLIENT_PRIVATE_KEY;
  if (!privateKey?.startsWith("0x")) {
    throw new Error("Set X402_CLIENT_PRIVATE_KEY in the client environment; never put it in a request or in Vercel server variables.");
  }

  const account = privateKeyToAccount(privateKey);
  const coreClient = new x402Client();
  registerExactEvmScheme(coreClient, {
    signer: account,
    networks: [NETWORK],
    schemeOptions: { 8453: { rpcUrl: process.env.BASE_RPC_URL } },
  });
  return { client: new x402HTTPClient(coreClient), payer: account.address };
}

async function callWithX402(path, body) {
  const url = `${BASE_URL}/api/v1/x402${path}`;
  const { client, payer } = createX402HttpClient();

  const first = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (first.status !== 402) return { payer, response: await first.json() };

  const paymentRequired = client.getPaymentRequiredResponse(
    (name) => first.headers.get(name),
    await first.json(),
  );
  const paymentPayload = await client.createPaymentPayload(paymentRequired);

  const second = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...client.encodePaymentSignatureHeader(paymentPayload) },
    body: JSON.stringify(body),
  });
  const result = await second.json();
  if (!second.ok) throw new Error(`x402 paid request failed (${second.status}): ${JSON.stringify(result)}`);
  return { payer, transaction: client.getPaymentSettleResponse((name) => second.headers.get(name))?.transaction, response: result };
}

// Example (run with X402_CLIENT_PRIVATE_KEY and BASE_RPC_URL set locally):
// const result = await callWithX402("/oman/property/analyze", {
//   governorate: "Muscat", area: "Al Mouj", propertyType: "apartment",
//   bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000
// });

export { callWithX402 };
