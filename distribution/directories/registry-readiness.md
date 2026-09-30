# Registry readiness matrix

| Registry | Protocol | Status | Exact reason / action |
|---|---|---|---|
| Official MCP Registry | MCP | PARTIAL | Manifest is prepared; owner must run mcp-publisher and complete repository verification. |
| Glama | MCP | MANUAL ACTION REQUIRED | Submit the public MCP endpoint and repository through the Glama listing flow; no submission is claimed. |
| Smithery | MCP | MANUAL ACTION REQUIRED | Submit a verified server/repository through Smithery; account and ownership checks are external. |
| PulseMCP | MCP | MANUAL ACTION REQUIRED | Submit the public server metadata and confirm remote transport availability. |
| x402 Bazaar | x402 | PARTIAL | Runtime Bazaar metadata exists; verify deployed Base/network/payTo and submit through the current directory flow. |
| x402.direct | x402 | MANUAL ACTION REQUIRED | External listing and approval are not performed by this repository. |
| x402-list | x402 | MANUAL ACTION REQUIRED | External listing and approval are not performed by this repository. |
| x402mpp | x402/MPP | PARTIAL | x402 is documented; MPP remains deployment-configured and must be verified before listing. |
| agentfirst.directory | A2A/REST/MCP | MANUAL ACTION REQUIRED | Submit the generated platform and capability metadata after production URL verification. |

Statuses describe repository readiness only; none means that a remote registry accepted or published Rafid.
