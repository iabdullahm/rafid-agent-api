/**
 * Client for Oman's National Centre for Statistics and Information (NCSI) Open Data Portal API
 * ("ODPAPI"), used to enrich `analyze_oman_property` with official market context (see
 * src/domain/oman/officialContext.ts). This is the ONLY network integration this capability adds
 * — it talks to NCSI's own documented, public REST API, never a scraped web page.
 *
 * Verified against the live service before writing this client (2026-09-21):
 *  - The published Swagger/OpenAPI document at
 *    https://map.ncsi.gov.om/ODPAPI/swagger/v1/swagger.json describes an "Explore Api" v1 with
 *    `servers: [{ url: "/ODPAPI" }]` and no security scheme (no API key/auth header required),
 *    exposing exactly the endpoints implemented below (Select/Where/order_by/offset/limit/language
 *    query parameters, matching the ODSQL-style convention common to open-data portals of this
 *    kind).
 *  - The catalog/records endpoints themselves (`GET /catalog/datasets`,
 *    `GET /catalog/datasets/{id}`, `GET /catalog/datasets/{id}/records`) returned HTTP 500 for
 *    every request attempted during discovery, including a syntactically valid request for a
 *    deliberately nonexistent dataset id (which a healthy API would 404 on, not 500) — i.e. the
 *    live backend appears to be temporarily broken today, not merely rate-limited or requiring
 *    parameters we omitted. `api.ncsi.gov.om` (the second URL given for this integration) serves
 *    only a bare Swagger UI shell with no working spec or data routes at any commonly-used path.
 *  - Because of this, no dataset id or response field name could be verified against live data
 *    (see this capability's completion report for the full discovery log). This client is built
 *    strictly from the verified OpenAPI *contract*, not from a guessed or remembered response
 *    shape — see officialContext.ts for how record fields are mapped (via an operator-supplied
 *    field map, never hardcoded field names).
 *
 * Design notes:
 *  - Every request is a safe (read-only) GET. Network errors and 5xx responses are retried a
 *    small, bounded number of times with a short backoff; 4xx responses are never retried (they
 *    indicate a bad request, not a transient failure).
 *  - `fetchImpl` is injectable (defaults to the global `fetch`) purely so tests can supply a
 *    deterministic mock without monkey-patching global state or depending on live NCSI
 *    availability — required by this project's testing rules (Section 11: "Do not make normal
 *    test execution depend on live NCSI availability").
 */

export type NcsiErrorKind = "timeout" | "network_error" | "http_error" | "malformed_response";

export class NcsiApiError extends Error {
  readonly kind: NcsiErrorKind;
  readonly status?: number;
  constructor(kind: NcsiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "NcsiApiError";
    this.kind = kind;
    this.status = status;
  }
}

export interface NcsiListDatasetsQuery {
  select?: string;
  where?: string;
  orderBy?: string;
  offset?: number;
  limit?: number;
  language?: "en" | "ar";
}

export interface NcsiListRecordsQuery extends NcsiListDatasetsQuery {}

export interface NcsiDatasetSummary {
  /** The field NCSI's own payload uses to identify a dataset — read defensively (see
   *  extractDatasetId) since the exact key name has not been verified against a live response. */
  datasetId: string | null;
  title: string | null;
  description: string | null;
  /** The untouched raw object for this dataset entry, for callers that need a field this summary
   *  does not surface. */
  raw: Record<string, unknown>;
}

export interface NcsiListDatasetsResult {
  datasets: readonly NcsiDatasetSummary[];
  /** Untouched raw response body, in case pagination/total-count metadata lives somewhere this
   *  client does not yet parse. */
  raw: unknown;
  retrievedAt: string;
}

export interface NcsiRecordsPage {
  records: readonly Record<string, unknown>[];
  raw: unknown;
  retrievedAt: string;
}

export interface NcsiClientConfig {
  baseUrl: string;
  timeoutMs: number;
  /** Number of retries after the first attempt for a network error or 5xx response. Default 2
   *  (i.e. up to 3 attempts total). */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS_MIN = 500;

export class NcsiClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: NcsiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? 2;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async listDatasets(query: NcsiListDatasetsQuery = {}): Promise<NcsiListDatasetsResult> {
    const retrievedAt = new Date().toISOString();
    const raw = await this.request("/catalog/datasets", toParams(query));
    return { datasets: extractDatasetSummaries(raw), raw, retrievedAt };
  }

  async getDatasetInfo(datasetId: string, query: { select?: string } = {}): Promise<{ raw: unknown; retrievedAt: string }> {
    const retrievedAt = new Date().toISOString();
    const raw = await this.request(`/catalog/datasets/${encodeURIComponent(datasetId)}`, toParams(query));
    return { raw, retrievedAt };
  }

  async getDatasetRecords(datasetId: string, query: NcsiListRecordsQuery = {}): Promise<NcsiRecordsPage> {
    const retrievedAt = new Date().toISOString();
    const raw = await this.request(`/catalog/datasets/${encodeURIComponent(datasetId)}/records`, toParams(query));
    return { records: extractRecords(raw), raw, retrievedAt };
  }

  private async request(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: NcsiApiError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(200 * attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url.toString(), { method: "GET", signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) {
          const err = new NcsiApiError("http_error", `NCSI API returned HTTP ${response.status} for ${path}`, response.status);
          if (response.status >= RETRYABLE_STATUS_MIN && attempt < this.maxRetries) { lastError = err; continue; }
          throw err;
        }
        try {
          return await response.json();
        } catch {
          throw new NcsiApiError("malformed_response", `NCSI API response for ${path} was not valid JSON`);
        }
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof NcsiApiError) throw err;
        const isAbort = err instanceof Error && err.name === "AbortError";
        const wrapped = isAbort
          ? new NcsiApiError("timeout", `NCSI API request to ${path} timed out after ${this.timeoutMs}ms`)
          : new NcsiApiError("network_error", `NCSI API request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < this.maxRetries) { lastError = wrapped; continue; }
        throw wrapped;
      }
    }
    // Unreachable in practice (the loop always returns or throws), but keeps TypeScript satisfied
    // and gives a sensible error if maxRetries is ever set to a negative number.
    throw lastError ?? new NcsiApiError("network_error", `NCSI API request to ${path} failed with no attempts made`);
  }
}

function toParams(query: NcsiListDatasetsQuery | NcsiListRecordsQuery): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {};
  if (typeof query.select === "string") params.Select = query.select;
  if (typeof query.where === "string") params.Where = query.where;
  if (typeof query.orderBy === "string") params.order_by = query.orderBy;
  if (typeof query.offset === "number") params.offset = query.offset;
  if (typeof query.limit === "number") params.limit = query.limit;
  if (typeof query.language === "string") params.language = query.language;
  return params;
}

/** NCSI's actual dataset-listing envelope shape has not been verified against live data (see this
 *  file's header) — every candidate key here is a defensive guess at common open-data-portal
 *  conventions (a bare array, or `{ datasets: [...] }` / `{ results: [...] }` / `{ data: [...] }`),
 *  tried in order. Anything not matching one of these shapes yields an empty list rather than a
 *  crash, so a genuinely unexpected envelope surfaces as "no datasets found", never a fabricated
 *  guess at one. */
function extractDatasetSummaries(raw: unknown): NcsiDatasetSummary[] {
  const list = extractArray(raw, ["datasets", "results", "data", "items"]);
  return list.map(entry => {
    const record = isRecord(entry) ? entry : {};
    return {
      datasetId: extractDatasetId(record),
      title: firstString(record, ["title", "Title", "name", "dataset_id", "label"]),
      description: firstString(record, ["description", "Description", "summary"]),
      raw: record
    };
  });
}

function extractRecords(raw: unknown): Record<string, unknown>[] {
  const list = extractArray(raw, ["records", "results", "data", "items"]);
  return list.map(entry => (isRecord(entry) ? entry : { value: entry }));
}

function extractArray(raw: unknown, candidateKeys: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    for (const key of candidateKeys) {
      const value = raw[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function extractDatasetId(record: Record<string, unknown>): string | null {
  return firstString(record, ["dataset_id", "datasetId", "id", "Id", "ID"]);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
