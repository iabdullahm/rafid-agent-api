# Rafid Agent API — x402 client example

A small, standalone example client that demonstrates paying Rafid Agent API per call over the
[x402 protocol](https://www.x402.org/) — no account, no API key, just an on-chain USDC payment.
It is not part of the Rafid Agent API server; it's a separate Node.js project you run locally
against the deployed API.

It calls:

```
POST https://rafid-agent-api.vercel.app/api/v1/x402/property/analyze
```

with this fixed example payload:

```json
{ "propertyValue": 85000, "annualRent": 7200, "serviceCharge": 650, "maintenanceCost": 400 }
```

Two scripts, two different risk levels:

| Script | Needs a wallet? | Spends real money? |
|---|---|---|
| `npm run test:x402-unpaid` | No | No — never touches a wallet |
| `npm run test:x402-payment` | Yes | Yes, on Base Mainnet — asks for confirmation first |

## Setup

```bash
npm install
cp .env.example .env
```

Open `.env` and, if you want to run the paid script, set `X402_PAYER_PRIVATE_KEY` to the
private key of a wallet you control that holds a small amount of real USDC on Base Mainnet
(and a little ETH, if the scheme you're using needs gas — the "exact" scheme this API uses is
typically gasless for the payer, since the facilitator submits the on-chain transaction, but
keep a little ETH there anyway just in case). `RAFID_API_URL` already defaults to the
production API, so you only need to set it if you're pointing at a different deployment.

**Never commit `.env`.** It's already in `.gitignore`. Never paste your private key anywhere
else, including into a support request — whoever has that key can spend everything in that
wallet. Use a wallet funded with only a few dollars, dedicated to testing this.

## 1. Unpaid request — no wallet required

```bash
npm run test:x402-unpaid
```

This sends the request with **no** payment at all and shows you exactly what an x402-aware
client sees before it decides to pay:

- the HTTP status (`402 Payment Required`)
- the decoded `PAYMENT-REQUIRED` header (network, asset, amount, `payTo`, scheme)
- the full raw decoded payload, for inspection

Safe to run any time, by anyone. It never reads `X402_PAYER_PRIVATE_KEY` and never signs
anything.

## 2. Real payment — spends real USDC on Base Mainnet

```bash
npm run test:x402-payment
```

This runs the same unpaid check first (step 1 above), then:

1. Refuses to continue if `X402_PAYER_PRIVATE_KEY` isn't set — nothing is sent.
2. Shows a safety banner:
   > You are about to make a real USDC payment on Base Mainnet to Rafid Agent API.

   and asks you to type `PAY` (all caps) to continue. Anything else aborts with nothing sent.
   Set `X402_CONFIRM_MAINNET=true` in `.env` only if you want to skip this prompt (for a
   scripted run you've already reviewed) — leave it unset to always be asked.
3. Signs and sends the payment using the official x402 client SDK (`@x402/fetch` +
   `@x402/evm`'s `ExactEvmScheme`, from the same `x402` package family the server uses) and
   retries the request with the resulting `X-PAYMENT` header.
4. Prints the final API response (the actual `analyze_property` result), plus — if the server
   returned one — the decoded settlement information: success, network, transaction hash,
   and amount. It never prints a signature, private key, or raw payment proof.

This client never decides what to pay: the exact asset address and atomic amount always come
from the server's own `PAYMENT-REQUIRED` response, read fresh on every run.

## How this maps to the two access models

Rafid Agent API keeps two independent ways in: a traditional `X-API-Key` route
(`/api/v1/property/analyze`) and this pay-per-call x402 route
(`/api/v1/x402/property/analyze`). This example only exercises the x402 route — see the main
project's README for the API-key route.

## Troubleshooting

- **`Expected HTTP 402, got ...`** — the server isn't currently gating that route with x402
  (`X402_ENABLED` may be `false`, or the network/config changed). Check
  `GET https://rafid-agent-api.vercel.app/api/v1/x402/status` for the live, factual state
  before assuming this example is broken.
- **Payment fails with an insufficient-funds-style message** — your wallet needs a small
  amount of real USDC on Base Mainnet. Double-check you're on the right network; the unpaid
  quote in step 1 always tells you which one the server expects.
- **`X402_PAYER_PRIVATE_KEY is not set`** — expected for `test:x402-unpaid`; required only for
  `test:x402-payment`.

## Step-by-step: completing the first $0.01 Rafid x402 payment

1. `cd examples/x402-client && npm install`
2. `cp .env.example .env`
3. Get (or create) a Base Mainnet wallet you're comfortable spending a small real amount
   from, and fund it with a little real USDC (a dollar or two is plenty for testing).
4. Export that wallet's private key and paste it into `.env` as `X402_PAYER_PRIVATE_KEY`
   (0x-prefixed). Leave `X402_CONFIRM_MAINNET` unset so you're asked to confirm.
5. Run `npm run test:x402-unpaid` first — confirm it shows `network: eip155:8453`, `asset` a
   USDC contract address, `amount` around $0.01, and `payTo` the address you expect Rafid
   Agent API to receive at (cross-check against `GET /api/v1/x402/status` on the API itself).
6. Run `npm run test:x402-payment`. Read the safety banner. Type `PAY` only once you're sure.
7. Watch the output: it prints the final API response (the calculated property metrics) and,
   if present, the settlement's transaction hash — look that transaction hash up on
   [BaseScan](https://basescan.org) to see the real on-chain USDC transfer.
8. That's it — the first real Rafid Agent API x402 payment is complete.
