# MVP implementation review — 2026-09-19

## Initial state

The complete supplied project consisted of package/configuration files, four source files and a small assertion script. It already had shared calculation functions, three REST handlers, three local MCP tools, basic API-key middleware, an OpenAPI skeleton and an unused x402 example. There was no installed dependency tree, lockfile, build command or Git metadata in the supplied workspace.

Main issues: direct calculator calls accepted invalid input, REST/MCP validation differed and was duplicated, missing keys silently disabled HTTP authentication, `.env` was not loaded by the commands, output/error shapes were inconsistent, schemas and auth were missing from OpenAPI, maintenance constants were unexplained, and tests covered only happy paths. Optional x402 dependencies were installed despite payment not being connected. The original source was reviewed before edits; no pre-change build success/failure is claimed.

## Changes

- `package.json`, `package-lock.json`, `tsconfig.build.json`: reproducible installation, compiled start commands, Node 24 requirement, environment loading, typecheck/build/test commands. Kept Express, Zod and MCP SDK v2. Removed unused optional payment dependencies.
- `src/services/property.ts`, `src/domain/financial.ts`: retained original formulas and age-based maintenance defaults, added service-level validation, canonical response fields, explicit assumptions and finite payback handling. Negative net income remains valid. `src/calculators.ts` preserves existing imports.
- `src/schemas/inputs.ts`, `outputs.ts`: strict shared contracts, numeric bounds, comparison cardinality/unique names, alias-conflict checks, maintenance assumption overrides and machine-readable output schemas.
- `src/domain/capabilities.ts`: one registry for service dispatch, tool names, endpoint paths, descriptions, schemas and examples.
- `src/api/app.ts`, `src/server.ts`: isolated app factory and process listener, canonical `/api/v1` routes, legacy route aliases, consistent envelopes, correlation IDs, bounded JSON bodies, content-type checks, safe errors and shutdown handling.
- `src/middleware/auth.ts`, `src/config/env.ts`: mandatory HTTP keys, multiple configured keys, legacy API_KEY fallback, digest-based constant-time comparisons and validated startup configuration. No real keys were created or embedded.
- `src/utils/errors.ts`, `logging.ts`: sanitized public failures and metadata-only logs; unmatched URL paths, request bodies, headers and query strings are excluded.
- `src/mcp/server.ts`, `src/mcp.ts`: shared services/schemas, structuredContent plus JSON text, output contracts, read-only annotations, safe service errors and stderr logging. Local stdio has no HTTP authentication or billing.
- `src/api/openapi.ts`: generated OpenAPI 3.1 inputs/outputs, envelopes, examples, authentication, status codes, canonical routes, discovery/liveness and deprecated aliases. Cross-field refinements remain runtime rules and are described in the API documentation.
- `src/billing/catalog.ts`: separate indicative prices and injectable REST billing boundary. x402 remains disabled; explicitly enabling it fails startup. Removed `src/x402.example.ts` rather than retaining unused payment wiring.
- `tests/*.test.ts`: replaced the happy-path assertion script with 32 service/configuration/HTTP/OpenAPI/MCP tests, including authentication, invalid inputs, negative income, age boundaries, log privacy, billing/rate-limit injection, malformed/oversized bodies and structured MCP results.
- `.env.example`, `.gitignore`, `README.md`: safe configuration template, ignored secrets/generated artifacts, setup and all three REST examples, direct-node MCP setup, formulas, compatibility changes, production limitations and next five priorities.

## Compatibility and limits

Legacy `/v1` paths and financial field aliases remain, but **all REST business results now use `data` inside an envelope**. Unrecognized fields and conflicting maintenance aliases now fail validation. Anonymous HTTP startup is intentionally removed. Maintenance remains a value/age/unit-count heuristic; property type and area are not modeled. Money uses the original two-decimal JavaScript rounding convention, not a decimal settlement ledger.

There is an injectable rate-limit boundary, not a deployed/distributed rate limiter. Keys and principal IDs are configuration-local. Billing does not charge, verify or settle payments. Remote MCP, persistent customer/usage storage, licensed market data and production deployment remain future work.

## Verification

- TypeScript typecheck and production build pass.
- 32 tests pass, including a real compiled MCP subprocess and HTTP requests on loopback ports.
- Runtime dependency audit reports zero known vulnerabilities at review time; this is not a full security audit.
- Source/configuration scan found no credential-shaped secrets; `.env.example` contains empty credential fields. No Git history was present to inspect, so no historical secret-cleanliness claim is made.

Highest-value next work, in order: durable customer/key management and abuse limits; usage ledger and one billing integration; deployment/operations and CI; authenticated remote MCP; calibrated/licensed Oman/GCC property intelligence. See README for acceptance scope.
