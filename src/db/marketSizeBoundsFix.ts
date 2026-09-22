/**
 * Migration version 5 (see marketStore.ts's MIGRATIONS array) — widens the `property_market_records
 * .size_sqm` CHECK constraint from its original flat `<= 5000` (marketSchema.ts's version 1) to
 * `<= 10000`.
 *
 * Discovered during the Al Mouj Muscat partner-sales import (2026-09-21): the application-level
 * size validator (src/domain/oman/importPipeline.ts's SIZE_BOUNDS_BY_PROPERTY_TYPE) was widened in
 * an earlier production-readiness pass to villa: { min: 50, max: 10000 } specifically to accept a
 * handful of legitimate ultra-luxury Zunairah villas (e.g. unit ZU-685, 6,366.94 sqm) — but the
 * DATABASE schema's own CHECK constraint was never updated to match, and stayed at the original
 * flat `<= 5000`. Because upsertMarketRecords() writes an entire import batch inside one
 * transaction, a single row exceeding 5000 sqm anywhere in the batch rolled back the WHOLE import
 * — not just that row — with no partial data ever landing (verified: Postgres transactions are
 * all-or-nothing, and this was confirmed by the "Market import failed" error surfacing before any
 * row committed).
 *
 * This constraint is a broad, deliberately non-precise backstop — per-property-type precision
 * (apartment 1500, townhouse 2000, villa 10000) is enforced once, at the application layer
 * (importPipeline.ts), exactly as size/bedroom/furnished comparable-selection logic is centralized
 * in comparables.ts rather than duplicated in the database (see marketRepository.ts's own doc
 * comment on that principle). The DB constraint only needs to be at least as permissive as the
 * widest per-type application bound (villa's 10000) so it can never reject a row the application
 * validator already accepted as legitimate.
 *
 * `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (not a single unconditional ADD) makes this safe
 * to re-run defensively even outside the normal migration-ledger idempotency guard.
 */
export const marketSizeBoundsFix = `
ALTER TABLE property_market_records DROP CONSTRAINT IF EXISTS property_market_records_size_sqm_check;
ALTER TABLE property_market_records ADD CONSTRAINT property_market_records_size_sqm_check CHECK (size_sqm > 0 AND size_sqm <= 10000);
`;
