# Onboarding the First Real Oman Property-Data Partner

This is the operational checklist for taking Rafid's first commercial property-data partner from
agreement to production. It assumes the Partner Data Feed layer and the Partner Operations layer
(this document, `partner:package`, `partner:rotate-token`, the ingestion audit log, partner health
monitoring and staleness policy) are already deployed.

Every step below is something an operator does once per partner, using the `npm run admin --`
CLI and the internal monitoring endpoints — none of it requires code changes per partner.

## 1. Agree data rights / license

Before creating anything in Rafid, confirm in writing (a signed agreement, a data-sharing MOU,
or equivalent) that the partner has the right to share the property data they intend to feed in,
and that Rafid has the right to use it for market analysis. Record a short reference to that
agreement (a contract number, a document link) — you'll enter it as the partner's
`dataLicenseReference` in the next step. Do not create the partner record until this is settled.

## 2. Create the partner

```
npm run admin -- partner:create <partner-id> "<Partner Display Name>" <csv|json|http_feed> partner_feed "<data license reference>" "<internal contact reference>"
```

This prints the new partner record **and the partner's bearer token, exactly once**. Copy the
token immediately into your organization's secret manager — it cannot be retrieved again (only
rotated, which invalidates it and issues a new one).

## 3. Generate the onboarding package

```
npm run admin -- partner:package <partner-id> [https://your-deployment-host]
```

This writes `partner-packages/<partner-id>/` containing `README.md`, `sample.csv`,
`sample.json`, `schema.json` and `curl-example.txt` — everything the partner's engineering team
needs to integrate, and **never their real token** (the README uses a `<PARTNER_TOKEN>`
placeholder). This directory is git-ignored; treat it as a temporary staging area, not a permanent
record.

## 4. Securely deliver the token

Send the onboarding package (or point the partner at its contents) through your normal secure
document-sharing channel, and deliver the bearer token separately, through a channel appropriate
for a credential (a secrets-sharing tool, a password manager's sharing feature — never plain
email or chat). Never commit the token to source control, a ticket, or a shared doc alongside the
onboarding package.

## 5. Send a test batch

Ask the partner (or run yourself, using `sample.json`/`sample.csv` from the package) a small test
submission against `POST /api/v1/market-data/import` with the `X-Partner-Token` header. Confirm
you get back HTTP 200 with the expected `imported`/`updated`/`rejected` counts.

## 6. Verify accepted / rejected records

Check the response body's `rejections` array (`{row, code, message}`) against what you expected.
If anything was unexpectedly rejected, walk through the codes with the partner (`schema.json` in
their onboarding package lists the full set) — a validation issue at this stage is far cheaper to
fix than after a production feed is live.

## 7. Verify provenance

Confirm the ingested records are attributable to this partner and nothing else — every accepted
record is forcibly attributed server-side to the authenticated partner's `partnerId`/`sourceType`/
`sourceName`, regardless of what the partner's file itself claimed, so this step is really a sanity
check on the endpoint/token you used rather than something that can silently go wrong. Query
`GET /api/v1/internal/market-data/partners/<partner-id>/quality` and confirm `recordCount`
reflects the test batch.

## 8. Confirm `analyze_oman_property` uses `partner_feed`

Run `analyze_oman_property` for an area/property type the test batch covers and confirm the
response's `provenance` includes an entry with `sourceType: "partner_feed"` and
`sourceName` equal to the partner's registered name.

## 9. Confirm no demo flag when only partner data contributes

If `OMAN_PROPERTY_DATA_MODE` is `"database"` or `"composite"`, confirm that when the comparable
pool for a given query is drawn entirely from this partner's records, the response carries no
demo/manual-benchmark indication (no `manual_benchmark` sourceType in `provenance`, and any
demo-dataset disclaimer the API surfaces elsewhere is absent). A mix of partner and demo data
should still honestly show both source types.

## 10. Monitor the first 24 hours

Watch `GET /api/v1/internal/market-data/partners` (protected by `X-Internal-Api-Key`) for this
partner's `recordsAcceptedLast24h`, `rejectionRateLast7d`, and `stale` fields. A meaningfully
non-zero `rejectionRateLast7d` in the first day is worth a follow-up with the partner before it
becomes routine. Also spot-check the ingestion audit trail (`PartnerIngestionAuditRepository`) for
unexpected `errorCode`s or a `durationMs` that looks unhealthy.

## 11. Enable the production schedule

Once the above is clean, have the partner switch from manual test submissions to their real
production cadence (a cron job, a scheduled export, a webhook-triggered push — whatever their
`feedType` implies). No further action is needed on Rafid's side: the partner's existing token
keeps authenticating, ingestion, attribution, scoring, and staleness/quality monitoring all
continue exactly as already verified above.

---

### Ongoing operations reference

- **Rotate a token** (suspected compromise, routine rotation policy, offboarding an integrator
  who had access to it): `npm run admin -- partner:rotate-token <partner-id>` — invalidates the
  old token immediately and prints the new one once.
- **Disable a partner** (pausing a feed, ending an agreement):
  `npm run admin -- partner:disable <partner-id>` — the partner's token stops authenticating
  immediately; their previously-ingested records are unaffected.
- **Re-enable**: `npm run admin -- partner:enable <partner-id>`.
- **Staleness**: a partner with no accepted record newer than `PARTNER_FEED_STALE_DAYS` (default
  7) is reported `stale: true` in the health endpoint — a monitoring signal only; it never blocks
  ingestion or affects any other partner's staleness or the market as a whole.
