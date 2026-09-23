# API credits client example

Pay for Rafid Agent API tools **without a crypto wallet**: a Rafid API key (`raf_live_…`) is
charged each tool's listed USD price from its account's subscription allowance and/or prepaid
credit balance. No dependencies — Node 24 runs the `.ts` files directly.

```bash
cp .env.example .env          # set RAFID_API_KEY (and RAFID_BASE_URL for a local server)
npm run balance               # credits, subscription allowance, usage, recent transactions
npm run call                  # research_company ($0.15) — shows the balance before/after
IDEMPOTENCY_KEY=order-42 npm run call   # run twice: the second call is replayed, not charged
```

Example output:

```text
POST /intelligence/research-company → HTTP 200
tool:            research_company
rail:            api_credits
charged:         $0.15
balance (server): $9.85
transaction:     txn_4f0c…
balance:         $10.00 → $9.85
```

With too little credit the API answers `402 insufficient_credits` with the price, your balance
and the other enabled payment options (e.g. x402). See `docs/billing.md` in the repository for
the full billing model, and `examples/x402-client` / `examples/mpp-client` for wallet-based rails.
