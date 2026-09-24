import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { ApiError } from "../src/utils/errors.js";
import { capabilities } from "../src/domain/capabilities.js";
import { buildOpenapi } from "../src/api/openapi.js";
import type { LogEvent } from "../src/utils/logging.js";
const key = "test-only-not-a-real-credential-12345";
const config = loadConfig({ RAFID_API_KEYS: key + ",test-only-second-key-123456789", LOG_LEVEL: "silent" });
test("configuration fails closed and validates flags", () => {
  for (const env of [{}, { RAFID_API_KEYS: "short" }, { RAFID_API_KEYS: key, PORT: "bad" }, { RAFID_API_KEYS: key, X402_ENABLED: "true" }, { RAFID_API_KEYS: key, X402_ENABLED: "yes" }]) assert.throws(() => loadConfig(env));
  assert.equal(loadConfig({}, { requireApiKeys: false }).apiKeys.length, 0);
  assert.equal(loadConfig({ API_KEY: key }).apiKeys[0], key);
});
test("REST: auth, all services, discovery, errors, and log redaction", async t => {
  const logs: LogEvent[] = [];
  const app = createApp(config, { logger: event => logs.push(event) });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, apiKey = key, contentType = "application/json") => fetch(base + path, {
    method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  for (const path of ["/", "/health", "/api/v1/health", "/openapi.json", "/docs"]) assert.equal((await fetch(base + path)).status, 200);
  const discovery = await (await fetch(base + "/", { headers: { Accept: "application/json" } })).json();
  assert.deepEqual({ docs: discovery.data.docs, openapi: discovery.data.openapi, health: discovery.data.health }, {
    docs: "/docs", openapi: "/openapi.json", health: "/api/v1/health"
  });
  const docs = await fetch(base + "/docs");
  assert.match(docs.headers.get("content-type") ?? "", /text\/html/);
  assert.match(docs.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  const docsHtml = await docs.text();
  assert.match(docsHtml, /SwaggerUIBundle/);
  assert.match(docsHtml, /url: "\/openapi\.json"/);
  for (const c of capabilities) {
    for (const prefix of ["/api/v1", "/v1"]) {
      const response = await post(prefix + c.path, c.example);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true); assert.deepEqual(body.data, await c.execute(c.example));
      assert.equal(body.meta.requestId, response.headers.get("x-request-id"));
      assert.ok(c.output.safeParse(body.data).success);
    }
    for (const badKey of ["", "wrong"]) assert.equal((await post("/api/v1" + c.path, c.example, badKey)).status, 401);
  }
  assert.equal((await post("/api/v1/property/analyze", capabilities[0].example, "test-only-second-key-123456789")).status, 200);
  for (const [body, status, code, contentType] of [
    [{ propertyValue: 0, annualRent: 10 }, 400, "INVALID_INPUT", "application/json"],
    ["{private-malformed", 400, "INVALID_JSON", "application/json"],
    ["x".repeat(34000), 413, "PAYLOAD_TOO_LARGE", "application/json"],
    ["text", 415, "UNSUPPORTED_MEDIA_TYPE", "text/plain"]
  ] as const) {
    const response = await post("/api/v1/property/analyze", body, key, contentType);
    assert.equal(response.status, status);
    const result = await response.json(); assert.equal(result.error.code, code); assert.equal(result.success, false);
    assert.ok(result.meta.requestId);
  }
  assert.equal((await fetch(base + "/private-customer-name?secret=private-query")).status, 404);
  const serialized = JSON.stringify(logs);
  for (const sensitive of [key, "private-customer-name", "private-query", "private-malformed", "85000"]) assert.ok(!serialized.includes(sensitive));
  assert.ok(logs.some(l => l.endpoint === "/api/v1/property/analyze" && l.status === 200));
});
test("billing and rate limit seams: identity propagation, validation before authorization, safe internal errors", async t => {
  let calls = 0;
  const app = createApp(config, { billing: { async authorize(context) {
    calls++; assert.equal(context.customerId, "configured-key-0"); assert.equal(context.capability, "analyze_property");
    throw new Error("private-payment-secret");
  } } });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v1/property/analyze`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400); assert.equal(calls, 0);
  const response = await post(capabilities[0].example); assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes("private-payment-secret")); assert.equal(calls, 1);
  const limited = createApp(config, { rateLimiter: (_req, _res, next) => next(new ApiError(429, "RATE_LIMITED", "Request quota exceeded")) }).listen(0, "127.0.0.1");
  t.after(() => { limited.closeAllConnections(); limited.close(); });
  await once(limited, "listening");
  const a = limited.address(); assert.ok(a && typeof a !== "string");
  assert.equal((await fetch(`http://127.0.0.1:${a.port}/api/v1/property/analyze`, { method: "POST", headers: { "X-API-Key": key } })).status, 429);
});
test("OpenAPI covers aliases, strict inputs, output schemas, auth and errors", () => {
  const paths = buildOpenapi().paths as Record<string, any>;
  for (const c of capabilities) {
    const op = paths["/api/v1" + c.path].post;
    assert.equal(op.operationId, c.name);
    assert.equal(op.requestBody.content["application/json"].schema.additionalProperties, false);
    assert.deepEqual(op.security, [{ ApiKeyAuth: [] }]);
    for (const code of ["200", "400", "401", "413", "415", "429", "500"]) assert.ok(op.responses[code].content["application/json"].schema);
    assert.ok(paths["/v1" + c.path].post.deprecated);
  }
  assert.equal(paths["/api/v1/health"].get.security.length, 0);
  assert.ok(paths["/docs"].get.responses["200"].content["text/html"]);
  const openapi = buildOpenapi() as any;
  assert.equal(openapi.components.securitySchemes.ApiKeyAuth.name, "X-API-Key");
  for (const path of ["/property/analyze", "/property/compare", "/maintenance/estimate"]) {
    const operation = paths["/api/v1" + path].post;
    assert.ok(operation.requestBody.content["application/json"].examples.default.value);
    assert.ok(operation.responses["200"].content["application/json"].examples.default.value);
  }
});
