# RapidAPI Marketplace staging integration — release gate

Scope: `rafid-agent-marketplace` only. Never edit the `main` branch, existing `rafid-agent-api` Vercel project, or RapidAPI v0.1.0 Base URL (`https://api.rafidsystem.com`) until all acceptance tests pass.

## Current evidence
- Independent project `rafid-agent-marketplace` deployed READY; health 200.
- Isolated PostgreSQL migration v1 applied; REST key admitted `company_due_diligence` and logged successful 200.
- Capability route: `POST /api/v1/risk/company-due-diligence`.
- These tests **do not** establish a RapidAPI gateway request or RapidAPI billing event.
- Current service lacks live registry/sanctions/news providers. Insufficient evidence must not be marketed as a completed verification.

## Required implementation (on this branch only)
1. Add a distinct, allowlisted RapidAPI-only route, e.g. `POST /rapidapi/v1/risk/company-due-diligence`; do not repurpose existing `X-API-Key` REST routes or automatically expose the remaining catalog.
2. Require `X-RapidAPI-Proxy-Secret`, comparing to a separate encrypted Vercel environment secret, using a timing-safe comparison. Reject absent/mismatched secret **before execution or consumption**. Do not trust `X-RapidAPI-User` or `X-RapidAPI-Subscription` without valid proxy secret. Strip secrets from logs. Never treat consumer-supplied `X-RapidAPI-Key` as backend verification.
3. Choose a billing source of truth: RapidAPI charges and enforces subscription quotas through its own gateway; Rafid logs executions and costs for reconciliation, but does not independently charge the same request in USDC, credits, Stripe, L402 or MPP. Retain disabled rails.
4. Implement durable request idempotency with PostgreSQL unique key scoped by RapidAPI subscriber identity and explicit idempotency token (not IP or company name). Atomic claim, fingerprint conflict detection (409), concurrent requests, durable final outcome/replay; retries with the same key must not execute twice. Note: local idempotency cannot promise RapidAPI will not meter two gateway HTTP requests; determine that from RapidAPI provider policies and testing.
5. Protect direct endpoint access, test missing/wrong/correct gateway secret, conflicting payload, exact replay, concurrent replay, DB failure, separate users with same idempotency key, and logs free of secrets.
6. Expose only the documented due-diligence endpoint in a **test-only RapidAPI version / private listing** pointing to the new project. Do not change version 0.1.0's existing Base URL. Confirm plan/BASIC pricing, requests/overage behavior and whether failed/replayed requests count from RapidAPI analytics. No public paid launch until proven.

## Required release evidence
- New branch tests green (unit, integration, DB, concurrency), reviewed deployment READY.
- Gateway-sourced invocation passes with provider proxy secret; direct spoof without secret rejected.
- Exactly one backend execution and ledger entry per logical idempotency key.
- Independent RapidAPI usage/billing reconciliation in a test subscription.
- Live due diligence providers configured and factual data coverage demonstrated.
- Explicit approval before changing production RapidAPI Base URL or publishing paid plans.
