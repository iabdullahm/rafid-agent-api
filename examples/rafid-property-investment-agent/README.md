# Rafid Property Investment AI Agent

A **free, open-source Node.js example** demonstrating a transparent, rule-based property investment agent with the three production-tested endpoints of **Rafid Intelligence Network** on RapidAPI.

**[Subscribe / Get an API key on RapidAPI](https://rapidapi.com/iabdullahm/api/rafid-intelligence-network2)**

> This example is an orchestrated agent workflow, not an LLM-based autonomous agent. API subscriptions and requests are subject to current RapidAPI terms and quotas.

## What it does

1. Calls `POST /rapidapi/v1/property/compare` to rank two example rental properties.
2. Calls `POST /rapidapi/v1/property/analyze` to evaluate the selected property.
3. Calls `POST /rapidapi/v1/maintenance/estimate` to estimate maintenance reserves.
4. Prints a JSON summary of the results.

**Three API requests per run** (excluding retries); BASIC is configured with 20 requests/month, so check your quota before repeatedly running.

## Requirements

- Node.js **20+** (native `fetch`, `AbortSignal.timeout`).
- Active RapidAPI subscription and its API key. Start with BASIC (free) if available.
- Network access to `rafid-intelligence-network2.p.rapidapi.com`.

## Run

Clone the repository, then from its root:

**macOS/Linux (bash)**

```bash
export RAPIDAPI_KEY="YOUR_OWN_RAPIDAPI_KEY"
node examples/rafid-property-investment-agent/agent.mjs
```

**Windows PowerShell**

```powershell
$env:RAPIDAPI_KEY = "YOUR_OWN_RAPIDAPI_KEY"
node examples/rafid-property-investment-agent/agent.mjs
Remove-Item Env:RAPIDAPI_KEY
```

Never commit credentials, share screenshots containing keys, or put RapidAPI keys in client-side browser code. For a real product, proxy calls through a secure backend.

## Example requests

**Compare properties:**
```json
{"properties":[{"name":"Apartment A","propertyValue":85000,"annualRent":7200,"serviceCharge":650,"maintenanceCost":400},{"name":"Apartment B","propertyValue":100000,"annualRent":7000,"serviceCharge":500,"maintenanceCost":450}]}
```

**Analyze property:**
```json
{"propertyValue":85000,"annualRent":7200,"serviceCharge":650,"maintenanceCost":400}
```

**Estimate maintenance:**
```json
{"propertyValue":85000,"ageYears":12,"units":1}
```

## Security and error handling

Calls use the RapidAPI gateway and send `X-RapidAPI-Key`, `X-RapidAPI-Host`, `Content-Type`, and a unique `Idempotency-Key`. Errors are surfaced with the HTTP status. No secrets are stored in this example. Re-running creates new idempotency keys and consumes additional requests.

## Limitations

The output uses provided property values and assumptions; it is **not** independent valuation, certified cost estimating, verified market research, or financial advice. Always confirm financial figures and service coverage before production use.

The original Rafid API backend and its production deployment are **not modified** by this example.

## Pricing & subscription

**[Open Rafid Intelligence Network on RapidAPI](https://rapidapi.com/iabdullahm/api/rafid-intelligence-network2)**

At publication, displayed plans were BASIC (20 requests/mo free), PRO ($19/100), ULTRA ($79/500), and MEGA ($249/1000). Always check current prices, limits, and overages on RapidAPI.

## License

[MIT](LICENSE)
