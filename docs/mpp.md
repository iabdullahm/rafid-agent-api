# MPP (Machine Payments Protocol) on Rafid: agent guide

This guide is for an AI agent, or the developer building one, that wants to pay for Rafid tools with MPP. Operator configuration is in the README section "MPP: Machine Payments Protocol".

## Protocol facts this implementation relies on

- MPP (https://mpp.dev, co-authored by Tempo and Stripe) uses the IETF **"Payment" HTTP authentication scheme**. On the wire:
  - The server sends `402` + `WWW-Authenticate: Payment id=…, realm=…, method=…, intent=…, request=…`.
  - The client answers with `Authorization: Payment <credential>`.
  - The server returns a `Payment-Receipt` header.
- **Intents.**
  - `charge` is a one-time payment. Rafid offers `tempo/charge` and optionally `evm/charge`.
  - `session` is a pay-as-you-go payment channel: `tempo/session`, TIP-1034. The payer deposits into an escrow, signs increasing cumulative vouchers, and the payee settles on-chain.
  - No other MPP method implements `session` today.
- Rafid uses the official SDK, `mppx`, for every protocol step. It never builds or parses challenges or credentials by hand.

## Charge from an agent

```ts
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const mppx = Mppx.create({ polyfill: false, methods: [tempo({ account: privateKeyToAccount(process.env.KEY as `0x${string}`) })] });
const res = await mppx.fetch("https://api.rafidsystem.com/api/v1/mpp/charge/oman_supplier_check", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ companyName: "Example Technical Services LLC" })
});
// 402 → mppx pays → retried automatically → 200 { success, data, payment, meta } + Payment-Receipt
```

## Session from an agent

1. `POST /api/v1/mpp/sessions` with `{ maxBudget, currency: "USD", allowedTools }`. `mppx.fetch` answers the open challenge by opening a channel. The suggested deposit equals `maxBudget`, capped by the client's `maxDeposit`. The response is `201` with `sessionId`.
2. `POST /api/v1/mpp/sessions/{sessionId}/tools/{tool}` with `Idempotency-Key: <unique per logical call>`. `mppx.fetch` answers each voucher challenge. Read `usage.remaining` from the response.
3. `GET /api/v1/mpp/sessions/{sessionId}` returns spend, remaining budget and `usageByTool`.
4. Close. `sessionManager.close()` (mppx) sends the payer's `close` credential; Rafid accepts it on any session route, closes the channel capturing exactly the metered spend, refunds the rest and returns a `Payment-Receipt`. Without a credential, `POST /api/v1/mpp/sessions/{sessionId}/close` stops the session and settles server-side when that can't over-capture (otherwise `settlement.status = pending_payer_close`).
5. Unpaid sessions expire after the challenge TTL plus a short grace and can never be opened afterwards. A client may hold only a few unpaid sessions at once (`429 MPP_TOO_MANY_PENDING_SESSIONS`).

Error codes an agent should handle:

| Code | HTTP | Meaning | What to do |
|---|---|---|---|
| `MPP_SESSION_BUDGET_EXCEEDED` | 402 | The call costs more than the remaining budget. The tool did not run. | Stop, or open a new session |
| `MPP_SESSION_EXHAUSTED` | 402 | The remaining budget can't pay for the cheapest allowed tool | Close the session |
| `MPP_SESSION_EXPIRED` | 410 | The session TTL has passed | Close the session, then open a new one |
| `MPP_SESSION_CLOSED` | 409 | The session was closed | Open a new session |
| `MPP_TOOL_NOT_ALLOWED` | 403 | The tool isn't in `allowedTools` | Use an allowed tool |
| `MPP_IDEMPOTENCY_CONFLICT` | 422 | The same key was reused for a different call | Use a fresh key |
| `MPP_IDEMPOTENCY_IN_PROGRESS` | 409 | A call with this key is still running | Retry later with the same key |
| `MPP_TOO_MANY_PENDING_SESSIONS` | 429 | Too many unpaid sessions from this client | Open one of them, or wait `Retry-After` |
| `MPP_SESSION_EXPIRED` (on open) | 410 | The session expired before its channel opened; nothing was metered | Close the returned `channelId` to recover the deposit; create a new session |
| `MPP_SETTLEMENT_UNCONFIRMED` | 502 | Settlement was broadcast but couldn't be confirmed | Don't pay again; check your wallet. Sessions are reconciled automatically |
| `MPP_SESSION_BUSY` | 409 | A call or a settlement attempt is in progress | Retry shortly |

## MCP agents

MCP handles tool discovery and invocation. MPP handles payment authorization and metering. The two stay separate.

- `/mcp` is the normal, free MCP server and is unchanged.
- `/mcp/mpp` is the MPP MCP transport binding. It is served only when the operator sets `MPP_MCP_ENABLED=true`.
  - `initialize` and `tools/list` behave exactly like `/mcp`.
  - A `tools/call` without payment fails with JSON-RPC error `-32042`. Its `data` is `{ httpStatus: 402, challenges: [...] }`.
  - Retry with `params._meta["org.paymentauth/credential"] = <credential>`. The result carries `_meta["org.paymentauth/receipt"]`.
  - `mppx/mcp/client`'s `McpClient.wrap(client, { methods: [tempo({ account })] })` handles all of this automatically.
- Session mode over MCP:
  1. Open the session over HTTP (step 1 above).
  2. On each `tools/call`, pass `_meta["com.rafidsystem/mpp-session"] = { sessionId, idempotencyKey }`.
  3. Answer the voucher challenge in `org.paymentauth/credential`.

  Budget, allowed tools and idempotency behave exactly as on the HTTP session route, because both call the same service.

## Operations

- **Status:** `GET /api/v1/mpp/status` returns `configured`, `provider.reachable` (a cached chain-id probe, never a payment), `database.ready`, `charge`, `session` and `network`.
- **Maintenance:** `GET /api/v1/mpp/internal/maintenance` with `Authorization: Bearer $CRON_SECRET` (or `MPP_MAINTENANCE_SECRET`). It expires overdue sessions, reconciles settlements and purges old unpaid rows. Schedule it with Vercel Cron or any scheduler. It is idempotent and safe to run concurrently.
- **Testnet end-to-end check:** `examples/mpp-client`, `npm run e2e:session`, against a deployment with `MPP_NETWORK=tempo-testnet`. See that folder's README.
