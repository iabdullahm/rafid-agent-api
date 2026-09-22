# Integration Examples

Worked, end-to-end integration examples live in [`examples/`](examples/). Each one is written for a specific integrating surface and follows the same shape: what the surface is, how it discovers Rafid, a concrete config or code snippet, and what to expect back. None of these invent a numeric analysis result that isn't from a real, live-verified endpoint or an explicitly-labeled illustrative example.

| File | Covers |
|---|---|
| [`examples/openai-agent.md`](examples/openai-agent.md) | An OpenAI-style function-calling / custom-GPT-actions agent: discovery, a suggested tool-selection instruction, and a worked function-call example. |
| [`examples/claude.md`](examples/claude.md) | Claude Desktop and Claude Code as MCP clients: stdio config, and what a tool call/result looks like in each. |
| [`examples/cursor.md`](examples/cursor.md) | Cursor as an MCP client: config file location and shape, verified against Cursor's documented MCP config format where possible, clearly labeled illustrative otherwise. |
| [`examples/generic-agent.md`](examples/generic-agent.md) | Any other agent framework: the transport-agnostic decision logic (fetch discovery → match question to `whenToUse`/`priorityContexts` → call → read `provenance`/`confidence` → label evidence types) that every other example is a specific case of. |
| [`examples/al-mouj-agent-flow.md`](examples/al-mouj-agent-flow.md) | A single, detailed 12-step worked flow for the pack's headline scenario: "Is OMR 450,000 reasonable for a 4-bedroom villa in Al Mouj Muscat?" from discovery through to a labeled final answer. |

Reusable code snippets referenced from these examples (and usable directly) live in [`snippets/`](snippets/): plain `curl` for the REST and x402 routes, a Node `fetch` client for both, an MCP client connection snippet, and small snippets for calling the discovery endpoints and inspecting a capability's `agentGuidance` fields.

For the underlying discovery surfaces, transports, and payment model these examples build on, see [`QUICKSTART.md`](QUICKSTART.md), [`MCP.md`](MCP.md), [`OPENAPI.md`](OPENAPI.md), [`X402.md`](X402.md), and [`AGENT-DISCOVERY.md`](AGENT-DISCOVERY.md).
