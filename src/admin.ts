import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CustomerStore } from "./db/store.js";
import { PostgresPropertyMarketRepository } from "./db/marketStore.js";
import { PostgresPartnerRepository } from "./db/partnerStore.js";
import { PostgresPartnerIngestionAuditRepository } from "./db/partnerAuditStore.js";
import { PostgresPartnerFeedCredentialRepository } from "./db/partnerFeedCredentialStore.js";
import { getOmanMarketDatabaseUrl } from "./domain/oman/config.js";
import { PARTNER_FEED_TYPES, PARTNER_FEED_FORMATS, isValidPartnerId, type PartnerFeedType, type PartnerFeedFormat } from "./domain/oman/partners.js";
import { SOURCE_TYPES, type SourceType } from "./domain/oman/types.js";
import { buildPartnerOnboardingPackage } from "./domain/oman/partnerPackage.js";
import { FEED_AUTH_TYPES, EnvSecretProvider, type FeedAuthType } from "./domain/oman/partnerFeedCredentials.js";
import { PartnerFeedRunner } from "./domain/oman/partnerFeedRunner.js";

const [command, ...args] = process.argv.slice(2);
const isPartnerCommand = !!command?.startsWith("partner:");

let store: CustomerStore | undefined;
let marketRepository: PostgresPropertyMarketRepository | undefined;

const USAGE = "Usage: migrate | customer:create NAME PER_MINUTE MONTHLY_QUOTA | key:issue CUSTOMER_ID LABEL | " +
  "key:revoke CUSTOMER_ID KEY_ID | customer:disable CUSTOMER_ID | customer:enable CUSTOMER_ID | usage CUSTOMER_ID | " +
  "partner:create PARTNER_ID PARTNER_NAME FEED_TYPE [SOURCE_TYPE] [DATA_LICENSE_REF] [CONTACT_REF] | " +
  "partner:list | partner:enable PARTNER_ID | partner:disable PARTNER_ID | partner:rotate-token PARTNER_ID | " +
  "partner:package PARTNER_ID [BASE_URL] | " +
  "partner:set-feed PARTNER_ID FEED_URL FEED_FORMAT(json|csv) SCHEDULE_ENABLED(true|false) [SCHEDULE_INTERVAL_MINUTES] | " +
  "partner:set-feed-credential PARTNER_ID AUTH_TYPE(bearer|api_key_header|none) [SECRET_ENV_VAR_NAME] [HEADER_NAME] | " +
  "partner:run-feed PARTNER_ID";

try {
  let result: unknown;
  if (isPartnerCommand) {
    // Partner Data Feed administration (Section 4) — a separate database from the customer/
    // billing store above: OMAN_MARKET_DATABASE_URL (falling back to DATABASE_URL), the same
    // connection every production market-data read/write already uses. migrate() is idempotent
    // and applies both the market-record schema and the partner schema (versions 1 and 2 — see
    // src/db/marketStore.ts's MIGRATIONS array), so a fresh deployment's first `partner:create`
    // just works without a separate `migrate` step.
    const marketUrl = getOmanMarketDatabaseUrl();
    if (!marketUrl) { process.stderr.write("DATABASE_URL (or OMAN_MARKET_DATABASE_URL) is required\n"); process.exit(1); }
    marketRepository = new PostgresPropertyMarketRepository(marketUrl);
    await marketRepository.migrate();
    const partnerRepository = new PostgresPartnerRepository(marketRepository.pool);

    if (command === "partner:create" && args.length >= 3) {
      const [partnerId, partnerName, feedType, sourceTypeArg, dataLicenseReference, contactReference] = args;
      if (!(PARTNER_FEED_TYPES as readonly string[]).includes(feedType!)) throw new Error(`feedType must be one of ${PARTNER_FEED_TYPES.join(", ")}`);
      const sourceType = (sourceTypeArg ?? "partner_feed") as SourceType;
      if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) throw new Error(`sourceType must be one of ${SOURCE_TYPES.join(", ")}`);
      result = await partnerRepository.create({
        partnerId: partnerId!, partnerName: partnerName!, feedType: feedType as PartnerFeedType, sourceType,
        dataLicenseReference: dataLicenseReference || null, contactReference: contactReference || null
      });
    } else if (command === "partner:list" && args.length === 0) {
      result = await partnerRepository.list();
    } else if (command === "partner:enable" && args.length === 1) {
      await partnerRepository.setEnabled(args[0]!, true); result = { enabled: true };
    } else if (command === "partner:disable" && args.length === 1) {
      await partnerRepository.setEnabled(args[0]!, false); result = { disabled: true };
    } else if (command === "partner:rotate-token" && args.length === 1) {
      // Section 2: invalidate the old token immediately, issue exactly one new token, print it
      // once — mirrors partner:create's own "print the generated secret once, to the operator
      // only" discipline (see the comment on process.stdout.write below).
      result = await partnerRepository.rotateToken(args[0]!);
    } else if (command === "partner:package" && args.length >= 1) {
      // Section 1: generates the onboarding package's files to disk under
      // partner-packages/<partnerId>/ (see .gitignore) — never includes the real partner token
      // (buildPartnerOnboardingPackage() is a pure function; see partnerPackage.ts).
      const partnerId = args[0]!;
      if (!isValidPartnerId(partnerId)) throw new Error(`Partner id "${partnerId}" is not a valid partner id`);
      const partner = await partnerRepository.findById(partnerId);
      if (!partner) throw new Error(`Partner "${partnerId}" not found`);
      const pkg = buildPartnerOnboardingPackage(partner, { baseUrl: args[1] });
      const outDir = resolvePath(`partner-packages/${partnerId}`);
      mkdirSync(outDir, { recursive: true });
      for (const [filename, content] of Object.entries(pkg)) writeFileSync(resolvePath(outDir, filename), content, "utf8");
      result = { partnerId, outputDirectory: outDir, files: Object.keys(pkg) };
    } else if (command === "partner:set-feed" && args.length >= 4) {
      // Production Feed Runner (Section 1): the operational way to set the Section 1 config
      // fields — a full replace of the schedule config, mirroring setEnabled()'s "one explicit
      // value" simplicity (see PartnerFeedConfigInput's own doc comment in partners.ts).
      const [partnerId, feedUrl, feedFormat, scheduleEnabledArg, intervalArg] = args;
      if (!(PARTNER_FEED_FORMATS as readonly string[]).includes(feedFormat!)) throw new Error(`FEED_FORMAT must be one of ${PARTNER_FEED_FORMATS.join(", ")}`);
      if (scheduleEnabledArg !== "true" && scheduleEnabledArg !== "false") throw new Error("SCHEDULE_ENABLED must be true or false");
      const scheduleIntervalMinutes = intervalArg ? Number(intervalArg) : null;
      if (scheduleIntervalMinutes !== null && (!Number.isFinite(scheduleIntervalMinutes) || scheduleIntervalMinutes <= 0)) throw new Error("SCHEDULE_INTERVAL_MINUTES must be a positive number");
      result = await partnerRepository.setFeedConfig(partnerId!, {
        feedUrl: feedUrl || null, feedFormat: feedFormat as PartnerFeedFormat,
        scheduleEnabled: scheduleEnabledArg === "true", scheduleIntervalMinutes
      });
    } else if (command === "partner:set-feed-credential" && args.length >= 2) {
      // Section 1: "Do NOT store authentication secrets directly on PropertyDataPartner" — this
      // stores only the credential's SHAPE (auth type, header name, secret env-var-name
      // REFERENCE); the actual secret value is never an argument to this command, only the name
      // of the environment variable holding it (see partnerFeedCredentials.ts's doc comment).
      const [partnerId, authTypeArg, secretRef, headerName] = args;
      if (!(FEED_AUTH_TYPES as readonly string[]).includes(authTypeArg!)) throw new Error(`AUTH_TYPE must be one of ${FEED_AUTH_TYPES.join(", ")}`);
      const authType = authTypeArg as FeedAuthType;
      if (authType !== "none" && !secretRef) throw new Error(`SECRET_ENV_VAR_NAME is required for authType "${authType}"`);
      if (authType === "api_key_header" && !headerName) throw new Error('HEADER_NAME is required for authType "api_key_header"');
      const credentialRepository = new PostgresPartnerFeedCredentialRepository(marketRepository.pool);
      result = await credentialRepository.setCredential(partnerId!, { authType, secretRef: secretRef || null, headerName: headerName || null });
    } else if (command === "partner:run-feed" && args.length === 1) {
      // Section 6: a single, on-demand feed run — useful for testing the first real partner
      // before enabling its schedule. Output is deliberately restricted to the safe summary
      // fields below: never the resolved credential headers, never a raw fetched record.
      const partnerId = args[0]!;
      const ingestionAuditRepository = new PostgresPartnerIngestionAuditRepository(marketRepository.pool);
      const credentialRepository = new PostgresPartnerFeedCredentialRepository(marketRepository.pool);
      const runner = new PartnerFeedRunner({
        partnerRepository, marketRepository, ingestionAuditRepository, credentialRepository,
        secretProvider: new EnvSecretProvider()
      });
      const outcome = await runner.runPartnerFeed(partnerId);
      result = {
        partner: partnerId, httpStatus: outcome.httpStatus, recordsReceived: outcome.recordsReceived,
        recordsAccepted: outcome.recordsAccepted, recordsRejected: outcome.recordsRejected,
        recordsUpdated: outcome.recordsUpdated, durationMs: outcome.durationMs, auditId: outcome.auditId,
        ok: outcome.ok, errorCode: outcome.errorCode
      };
    } else {
      throw new Error(USAGE);
    }
  } else {
    const url = process.env.DATABASE_URL;
    if (!url) { process.stderr.write("DATABASE_URL is required\n"); process.exit(1); }
    store = new CustomerStore(url);
    if (command === "migrate" && args.length === 0) { await store.migrate(); result = { migrated: true }; }
    else if (command === "customer:create" && args.length === 3) result = await store.createCustomer({ name: args[0]!, requestsPerMinute: Number(args[1]), monthlyQuota: Number(args[2]) });
    else if (command === "key:issue" && args.length === 2) result = await store.issueKey(args[0]!,args[1]!);
    else if (command === "key:revoke" && args.length === 2) { await store.revokeKey(args[0]!,args[1]!); result = { revoked: true }; }
    else if (command === "customer:disable" && args.length === 1) { await store.setActive(args[0]!,false); result = { disabled: true }; }
    else if (command === "customer:enable" && args.length === 1) { await store.setActive(args[0]!,true); result = { enabled: true }; }
    else if (command === "usage" && args.length === 1) result = await store.usage(args[0]!);
    else throw new Error(USAGE);
  }
  // key:issue, partner:create and partner:rotate-token deliberately output the newly generated
  // secret once, to the operator only.
  process.stdout.write(JSON.stringify(result,null,2) + "\n");
} catch {
  process.stderr.write("Admin command failed. Check arguments, customer/key/partner IDs, DATABASE_URL and migrations. See docs/customers.md.\n");
  process.exitCode = 1;
} finally {
  await store?.close();
  await marketRepository?.close();
}
