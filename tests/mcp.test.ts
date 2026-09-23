import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { capabilities } from "../src/domain/capabilities.js";
test("compiled MCP stdio: initialize, discovery, structured results, validation", { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ["dist/mcp.js"], { env: { ...process.env, LOG_LEVEL: "silent", X402_ENABLED: "false" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data.toString(); });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0;
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) { pending.get(message.id)?.resolve(message); pending.delete(message.id); }
  });
  child.on("error", error => { for (const p of pending.values()) p.reject(error); pending.clear(); });
  child.on("exit", () => { for (const p of pending.values()) p.reject(new Error("MCP exited: " + stderr)); pending.clear(); });
  t.after(() => { lines.close(); child.stdin.end(); child.kill(); });
  const call = async (method: string, params: unknown) => {
    const current = ++id;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<any>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("MCP response timeout: " + stderr)), 5000);
        pending.set(current, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
      });
    } finally { clearTimeout(timer!); pending.delete(current); }
  };
  const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "rafid-tests", version: "1.0.0" } });
  assert.equal(init.result.serverInfo.name, "rafid-agent-api");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await call("tools/list", {});
  // Free Preview (src/preview/) adds exactly one generic "preview_capability" tool alongside
  // the per-capability tools built straight from the registry — not a second tool list.
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), [...capabilities.map(c => c.name), "preview_capability"].sort());
  for (const c of capabilities) {
    const tool = listed.result.tools.find((x: any) => x.name === c.name);
    assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.outputSchema);
    // MCP tool descriptions must be built from the shared capability registry, not a second
    // copy of the prose: both the factual description and the recommendation-layer
    // "when to use" sentence should appear verbatim.
    assert.ok(tool.description.includes(c.description));
    assert.ok(tool.description.includes(c.whenToUse));
    const response = await call("tools/call", { name: c.name, arguments: c.example });
    assert.equal(response.error, undefined); assert.ok(!response.result.isError);
    assert.deepEqual(response.result.structuredContent, await c.execute(c.example));
    assert.deepEqual(JSON.parse(response.result.content[0].text), await c.execute(c.example));
    const invalid = await call("tools/call", { name: c.name, arguments: { propertyValue: 0, unexpected: true } });
    assert.ok(invalid.error || invalid.result?.isError);
  }
  const conflict = await call("tools/call", { name: "analyze_property", arguments: { propertyValue: 100, annualRent: 10, maintenance: 1, maintenanceCost: 2 } });
  assert.ok(conflict.error || conflict.result?.isError);
});
