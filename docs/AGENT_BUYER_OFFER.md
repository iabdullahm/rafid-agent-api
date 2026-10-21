# Rafid Agent API — Buy a Tool, Not a Subscription

**Production API:** https://api.rafidsystem.com  
**Discovery:** https://api.rafidsystem.com/api/v1/capabilities  
**Payment methods:** https://api.rafidsystem.com/api/v1/payment-methods  
**MCP:** https://api.rafidsystem.com/mcp

Rafid provides independently callable capabilities for AI agents and developers working on property analysis, supplier research, invoice anomaly checks, and business intelligence. Capabilities and availability are discoverable from the live API; inspect the response before integrating.

## First integration: Oman property investment analysis

Use the **verified live x402 challenge route**:

```http
POST https://api.rafidsystem.com/api/v1/x402/property/analyze
Content-Type: application/json

{"propertyValue":85000,"annualRent":7200,"serviceCharge":650,"maintenanceCost":400}
```

The endpoint calculates rental yields, operating costs and simple payback in **OMR**. It provides calculations, not investment advice or an independent valuation.

Run a **no-payment discovery** check:

```bash
curl -i -X POST 'https://api.rafidsystem.com/api/v1/x402/property/analyze' \
  -H 'Content-Type: application/json' \
  --data '{"propertyValue":85000,"annualRent":7200,"serviceCharge":650,"maintenanceCost":400}'
```

An unsigned request receives an **HTTP 402** challenge. Read and decode the `PAYMENT-REQUIRED` header, select a supported offer, and have an authorized x402 v2-compatible wallet sign it. Retry the **same request** with `PAYMENT-SIGNATURE`. A 402 response on its own does **not** move any funds.

During the production check on 21 Oct 2026, the offer advertised **0.01 USDC** on Base Mainnet (`eip155:8453`). The live `PAYMENT-REQUIRED` terms are authoritative: **always confirm the current network, token, amount and receiver before authorizing payment.**

## Free preview → paid supplier due diligence

**Best starting point for procurement and finance agents:** `company_due_diligence` — **$1.50 per completed paid call** as currently advertised by production discovery. It supports a **free preview** before a buyer authorizes payment.

- Free preview: `POST https://api.rafidsystem.com/api/v1/preview/company_due_diligence`
- Paid x402 route: `POST https://api.rafidsystem.com/api/v1/x402/risk/company-due-diligence`
- REST route: `POST https://api.rafidsystem.com/api/v1/risk/company-due-diligence`
- MCP tool: `company_due_diligence`

Example review request (use a company you are authorized to assess):

```json
{
  "company": "Example Supplier LLC",
  "purpose": "supplier_onboarding",
  "depth": "standard",
  "checks": {
    "registry": true,
    "sanctions": true,
    "adverseMedia": true,
    "reputation": true,
    "businessRisk": true
  }
}
```

The preview only indicates analysis availability and a next-action payment contract; it does **not** provide the paid report. Check the production API's current input schema, preview terms, and payment challenge before using. A free preview is not proof of verified screening data or a sales conversion.

## Other agent use cases

- **Procurement agents:** research vendors and business-risk signals before review.
- **Finance agents:** identify candidate invoice anomalies for human investigation.
- **Property agents:** compare investment yields using explicit numerical inputs.
- **Integration teams:** browse MCP tools and REST capabilities and choose API credits, subscription, x402, or other advertised methods.

Actual tool IDs, prices, input schemas, availability and payment routes must be obtained from the live discovery endpoints. Outputs are informational and should not replace due diligence or professional decisions.

## A buyer evaluation checklist

1. Discover the required tool and check its schema.
2. Test the unsigned request and inspect its 402 response, if using x402.
3. Set an explicit per-call spending limit in your agent.
4. Review any required wallet permissions and sign **only** an authorized payment.
5. Verify the HTTP response, payment receipt, and output quality.
6. Contact the maintainer with reproducible integration feedback; never share private keys or tokens.

## For developer teams

If you build a procurement, finance, property or risk-analysis agent, propose a **single specific tool integration**, expected monthly call volume, latency requirements, and preferred payment method.

- Source and integration discussion: https://github.com/iabdullahm/rafid-agent-api
- Public API: https://api.rafidsystem.com
- Buyer guide: https://github.com/iabdullahm/rafid-agent-api/blob/docs/x402-buyer-quickstart/docs/RAFID_X402_BUYER_QUICKSTART.md

**Scope:** This is a buyer-facing overview, not a claim of verified external sales, completed settlement, service-level guarantee, or current marketplace ranking.
