# Launching the First Live, Automated Partner Feed

This is the operational runbook for turning an already-onboarded partner (see
`docs/FIRST_PARTNER_ONBOARDING.md`) into a **scheduled, automated** feed via the Production Feed
Runner — the layer that periodically fetches a partner's HTTPS JSON/CSV endpoint itself, instead of
the partner (or an operator) pushing data in manually.

Nothing here changes how manual ingestion (`POST /api/v1/market-data/import`), `analyze_oman_property`,
or x402 pricing work. The feed runner is a scheduling and fetching layer on top of the exact same
ingestion pipeline every other data path already uses — see `src/domain/oman/partnerFeedRunner.ts`'s
doc comment.

## 1. Create the partner

If this partner doesn't exist yet, follow `docs/FIRST_PARTNER_ONBOARDING.md` steps 1-2 first:

```
npm run admin -- partner:create <partner-id> "<Partner Display Name>" http_feed partner_feed "<data license reference>" "<internal contact reference>"
```

Use `feedType http_feed` for a partner whose data Rafid will pull on a schedule (as opposed to
`csv`/`json`, which describe a partner who pushes files to Rafid manually or via the ingestion API).

## 2. Generate the token/package (if not already done)

```
npm run admin -- partner:package <partner-id> [https://your-deployment-host]
```

Only needed if this partner will *also* be able to push data manually via their bearer token. A
purely scheduled-feed partner still gets a token at creation time (every partner does), but doesn't
necessarily need the onboarding package if they'll never call the ingestion API themselves.

## 3. Agree the feed URL and authentication with the partner

Confirm with the partner:

- The exact HTTPS URL Rafid should poll (must be `https://` — plain HTTP is rejected by default;
  see the security model below).
- The response format: a JSON array (or `{"records": [...]}`), or CSV with a header row — same
  shape either endpoint of the manual ingestion API already accepts.
- How Rafid should authenticate to *them*: no authentication, a bearer token (`Authorization:
  Bearer <token>`), or an API key in a custom header (e.g. `X-Api-Key`).

## 4. Configure the secret

**Never put the partner's feed credential value in the database, a CLI argument, or a config
file.** Set it as an environment variable on the machine/service that will run
`npm run partner:feeds` and `partner:run-feed` (e.g. `RAFID_PARTNER_<NAME>_TOKEN=...` in Vercel's
project environment variables, a GitHub Actions repository secret, or the Windows Task Scheduler
service account's environment). Then point the partner's credential configuration at that
variable's *name*, never its value:

```
npm run admin -- partner:set-feed-credential <partner-id> bearer RAFID_PARTNER_<NAME>_TOKEN
npm run admin -- partner:set-feed-credential <partner-id> api_key_header RAFID_PARTNER_<NAME>_TOKEN X-Api-Key
npm run admin -- partner:set-feed-credential <partner-id> none
```

Then configure the feed URL/format itself (schedule left off for now — step 11 turns it on):

```
npm run admin -- partner:set-feed <partner-id> https://partner.example.com/rafid-feed.json json false
```

## 5. Test with `partner:run-feed`

Run a single, on-demand feed attempt:

```
npm run admin -- partner:run-feed <partner-id>
```

This prints only `{partner, httpStatus, recordsReceived, recordsAccepted, recordsRejected,
recordsUpdated, durationMs, auditId, ok, errorCode}` — **never the resolved credential header or
any raw record**. A non-2xx HTTP status, a timeout, an SSRF rejection (wrong/misconfigured feed
host), a content-type mismatch, or a parse failure all come back as a normal, safe JSON result with
`ok: false` and a specific `errorCode` (`HTTP_401`, `TIMEOUT`, `SSRF_REJECTED`,
`UNEXPECTED_CONTENT_TYPE`, `PARSE_ERROR`, `CREDENTIAL_ERROR`, ...) — nothing is ever thrown or
printed for a routine feed failure. Iterate with the partner until this returns `ok: true` with the
expected `recordsAccepted`.

## 6. Inspect the audit log

Every `partner:run-feed` attempt (successful or not) writes one row to the same
`PartnerIngestionAuditRepository` the manual ingestion endpoint uses — `auditId` from the previous
step's output identifies it. Query it however you already inspect Partner Operations audit data;
it holds only safe counts, timing, and an error code — never a header, token, or record body.

## 7. Inspect data quality

```
curl -H "X-Internal-Api-Key: $MARKET_DATA_INTERNAL_API_KEY" https://your-deployment-host/api/v1/internal/market-data/partners/<partner-id>/quality
```

Confirm `averageDataQualityScore`, `percentageAbove80`, and the missing-field rates look
reasonable for this partner's data.

## 8. Verify provenance

Confirm accepted records are attributed correctly — attribution is always forced server-side from
the authenticated partner record (never from the feed body itself), exactly like manual ingestion,
so this is a sanity check on which partner/feed you tested rather than something that can silently
drift:

```
curl -H "X-Internal-Api-Key: $MARKET_DATA_INTERNAL_API_KEY" https://your-deployment-host/api/v1/internal/market-data/partners/<partner-id>/quality
```

## 9. Run `analyze_oman_property`

Run the public `analyze_oman_property` capability for an area/property type the test feed covers
and confirm `provenance` includes an entry with `sourceType: "partner_feed"` and `sourceName`
equal to this partner's registered name — exactly as in the manual onboarding runbook's step 8.

## 10. Verify no demo flag when only partner data contributes

Same check as manual onboarding's step 9: when the comparable pool for a query is drawn entirely
from this partner's scheduled-feed records, the response must carry no demo/manual-benchmark
indication.

## 11. Enable the schedule

Once `partner:run-feed` is clean and steps 6-10 all check out, turn the schedule on (re-sending the
feedUrl/feedFormat from step 4 unchanged, per `partner:set-feed`'s "always supply every field
together" contract):

```
npm run admin -- partner:set-feed <partner-id> https://partner.example.com/rafid-feed.json json true 60
```

The last argument is the interval in minutes between scheduled attempts (60 above = hourly).

Then wire up an external scheduler to run `npm run partner:feeds` on a cadence at least as frequent
as your shortest partner interval — **this command runs one scheduling pass and exits; it is not,
and must never become, an always-running process.** It identifies every enabled partner whose
schedule is due, runs each safely (one partner's failure never blocks another's — see Section 7 of
the feed runner's design), and prints a safe summary:
`{"attempted": N, "successful": N, "failed": N, "results": [...]}`.

Suitable schedulers:

- **Vercel Cron** — a `crons` entry in `vercel.json` hitting a small serverless function that
  shells out to (or directly imports and calls) the same logic `npm run partner:feeds` runs, since
  Vercel Cron triggers HTTP requests, not shell commands. Alternatively, run it from GitHub Actions
  against the same deployment's database.
- **GitHub Actions** — a workflow with a `schedule:` trigger that checks out the repo and runs
  `npm run partner:feeds`, with `DATABASE_URL` and every partner credential's environment variable
  supplied as repository/environment secrets.
- **Windows Task Scheduler** — a scheduled task running `npm run partner:feeds` from the deployed
  checkout on a Windows host, with the required environment variables set on the service account
  or in a `.env` file the task's working directory picks up.
- **External cron** (a traditional Linux cron entry, a managed cron service) — identical to GitHub
  Actions, just triggered differently.

## 12. Monitor the first 24 hours

Watch the extended health fields on `GET /api/v1/internal/market-data/partners`
(`X-Internal-Api-Key`-protected, unchanged endpoint from the Partner Operations layer, now carrying
five additional fields):

- `lastFeedAttemptAt` / `lastFeedSuccessAt` — should both be advancing roughly every
  `scheduleIntervalMinutes`.
- `consecutiveFailures` — should stay at 0. Any nonzero value after the first scheduled run is
  worth investigating immediately (check the audit log's `errorCode` for that partner).
- `feedHealth` — `"healthy"` is the expected steady state. `"degraded"` means
  `consecutiveFailures >= 3` (something is actively broken — network, credentials, or the
  partner's endpoint itself). `"stale"` means the feed hasn't produced an accepted record inside
  `PARTNER_FEED_STALE_DAYS` even though it isn't currently erroring — worth a check-in with the
  partner. Feed health for one partner never affects any other partner's health, or
  `analyze_oman_property`'s availability globally.
- `nextDueAt` — sanity-check this against your scheduler's actual cadence.

---

### Security model summary (for the person configuring the scheduler/secrets)

- **SSRF protection** (`src/domain/oman/feedSecurity.ts`): every feed URL — and every redirect
  target, re-validated before being followed — must be `https://`, must not resolve to localhost,
  a private/loopback/link-local/reserved IP (checked both as a literal and via DNS resolution), and
  may optionally be restricted to an explicit hostname allowlist.
- **Retries** (`src/domain/oman/feedRetry.ts`): only a timeout, a connection/network error, or an
  HTTP 502/503/504 is retried, with bounded exponential backoff, up to 3 attempts total. A 400,
  401, 403, 404, or any validation/parse failure is never retried.
- **Credentials** (`src/domain/oman/partnerFeedCredentials.ts`): never stored on the partner
  record and never stored as a raw value anywhere — only a reference to an environment variable
  name, resolved to the actual secret only in memory, for the duration of one outbound fetch.
- **Data safety**: existing idempotent upsert rules, rejection semantics, and per-row validation
  are entirely unchanged — the feed runner calls the exact same `importMarketRecords()` every other
  ingestion path uses, never a parallel implementation. A rejected batch never deletes existing
  records.
