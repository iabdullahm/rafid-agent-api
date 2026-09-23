# Rafid MPP client examples

These are example agents that pay Rafid tools over **MPP (Machine Payments Protocol)** using the official [`mppx`](https://github.com/wevm/mppx) SDK. They are separate from the Rafid server.

| Script | What it shows |
|---|---|
| `npm run charge` | One-time MPP charge for one `analyze_oman_property` call: unpaid 402 quote → pay → 200 + `Payment-Receipt` |
| `npm run session` | Create a $10 session → `analyze_oman_property` → `oman_supplier_check` → read remaining budget → close |
| `npm run e2e:session` | **Tempo testnet only.** Real end-to-end session check: open → 2 paid calls → usage → idempotent retry (not charged) → over-budget call (rejected, tool not run) → payer close → settlement verified on-chain. Exits non-zero on any failed check |
| `npm run bulk-supplier-check` | A procurement agent screens suppliers under one session, stops automatically when the remaining budget can't pay for another $0.50 check, then closes and settles |

```bash
cd examples/mpp-client
npm install
cp .env.example .env    # set MPP_CLIENT_PRIVATE_KEY (a dedicated, low-balance payer wallet)
npm run charge
```

Notes:

- The payer key stays in this process. mppx signs locally and only the credential (`Authorization: Payment …`) is sent. Never commit `.env`.
- **These scripts spend real funds when the target deployment runs on Tempo mainnet** (`MPP_NETWORK=tempo`). For testing, point `RAFID_BASE_URL` at a deployment configured with `MPP_NETWORK=tempo-testnet` and fund the payer from Tempo's testnet faucet.
- Session budgets are escrowed in a payment channel. Rafid meters only successful calls and settles exactly that amount. The unused deposit returns to you when the channel closes (`npx mppx sessions close <channel-id>`).
- Check the target first: `curl <base>/api/v1/mpp/status`.

## Testnet end-to-end session check

Requirements:

- The target deployment runs `MPP_ENABLED=true`, `MPP_MODES` including `session`, and `MPP_NETWORK=tempo-testnet`. The script checks `GET /api/v1/mpp/status` and refuses anything that isn't Tempo testnet (chain 42431).
- The payer wallet (`MPP_CLIENT_PRIVATE_KEY`) is funded from the Tempo testnet faucet.

```bash
cd examples/mpp-client
npm install
cp .env.example .env   # RAFID_BASE_URL=<testnet deployment>, MPP_CLIENT_PRIVATE_KEY=<testnet-only key>
npm run e2e:session
```

The report prints only public values (session id, channel id, tx hashes), never the key. `Settlement: VERIFIED` is printed only when the server reports `settled` **and** the channel's on-chain settled amount equals the metered spend.
