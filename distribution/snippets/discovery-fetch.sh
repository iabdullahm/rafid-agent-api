#!/usr/bin/env bash
# Fetch every discovery surface. Useful as a first smoke-test that a deployment is up and
# that all discovery documents agree with each other (they're all built from the same
# capability registry — see ../AGENT-DISCOVERY.md).

BASE_URL="https://api.rafidsystem.com"

echo "--- /agent.json ---"
curl -s "$BASE_URL/agent.json" | head -c 500; echo

echo "--- /.well-known/agent.json (A2A Agent Card) ---"
curl -s "$BASE_URL/.well-known/agent.json" | head -c 500; echo

echo "--- /.well-known/ai-plugin.json (legacy OpenAI plugin manifest) ---"
curl -s "$BASE_URL/.well-known/ai-plugin.json" | head -c 500; echo

echo "--- /llms.txt ---"
curl -s "$BASE_URL/llms.txt" | head -c 500; echo

echo "--- /api/v1/capabilities ---"
curl -s "$BASE_URL/api/v1/capabilities" | head -c 500; echo

echo "--- /api/v1/pricing ---"
curl -s "$BASE_URL/api/v1/pricing"; echo

echo "--- /api/v1/mcp/status ---"
curl -s "$BASE_URL/api/v1/mcp/status"; echo

echo "--- /api/v1/x402/status ---"
curl -s "$BASE_URL/api/v1/x402/status"; echo
