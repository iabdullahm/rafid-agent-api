# RapidAPI subscriptions: phase two (isolated staging)
 
## Scope
Only `rafid-agent-marketplace`, PostgreSQL database `rafid-agent-marketplace-db`, branch `marketplace/company-due-diligence-staging`.
Original `rafid-agent-api` and public RapidAPI API version/Base URL must not change.

## Authenticated proof
- Custom production domain `marketplace.rafidsystem.com` accessible past Vercel Authentication.
- Missing `X-RapidAPI-Proxy-Secret` returns application 401.
- Correct secret returns intentional 503 `RAPIDAPI_NOT_READY`.
- 503 is a release gate, **not** a successful charged request or operational gateway integration.

## Release architecture
- RapidAPI owns subscription purchase, payment collection, plan entitlement and gateway metering.
- Marketplace verifies `X-RapidAPI-Proxy-Secret` before trusting RapidAPI subscriber headers.
- Backend stores one durable request per `subscriber_id + idempotency_key`, with fingerprint of canonical validated input + capability.
- Atomic uniqueness, deterministic 409 for idempotency-key reuse with changed payload, 202/409 pending for concurrent duplicate, response replay for completed identical request. Failed / abandoned in-flight requests require a reviewed retry-and-recovery policy.
- Log a separate non-monetary execution ledger for reconciliation. **Never call** internal `billing.authorize`, x402, L402, MPP, or credits for RapidAPI gateway usage. Distinguish provider gateway metering from backend execution deduplication: one backend execution does NOT guarantee RapidAPI meters one request.
- Maintain strict allowlist of supported capabilities, currently `company_due_diligence`.
- Reject calls lacking explicit `Idempotency-Key` and a verified gateway subscriber identity. Never derive key from request body or IP.
- Return evidence-coverage status; avoid promising full sanctions / registry diligence while live providers are disabled.

## Current implementation status
- Dedicated PostgreSQL migration SQL prepared in `migrations/002_rapidapi_idempotency.sql`.
- Migration not yet applied; gateway endpoint remains fail closed at HTTP 503.
- No paid requests enabled, no RapidAPI billing claims made.

## Go-live gates
1. Apply migration to Marketplace Neon only and verify schema in Neon Query.
2. Implement and unit/integration-test atomic claim, finish, replay, concurrency, payload conflict and stale in-flight recovery in isolated branch.
3. Test real gateway traffic and subscription/overage behavior in a private RapidAPI version against the Marketplace custom domain; avoid changing existing base URL.
4. Verify provider reporting, request counts, duplicate retry metering and refunds if applicable.
5. Enable factual diligence data sources and publish truthful coverage limitations.
6. Security review, rollback rehearsal, and explicit approval before paid subscriptions.
