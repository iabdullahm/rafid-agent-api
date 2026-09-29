# Creative Techno Oman small-business toolkit

The `book_business` capabilities are derived from the attached canonical PDF:

> Creative Techno, *كيف تبدأ مشروعك الصغير في عُمان؟ — الدليل العملي من الفكرة إلى أول عميل*, 2026.

They are registered through `src/domain/capabilities.ts` via `src/book-business/registry.ts`. That single registry automatically exposes them through REST, x402, L402, MPP, MCP, OpenAPI, `/api/v1/capabilities`, `/agent.json`, the well-known manifests and `llms.txt`.

## Framework mapping

| Book worksheet/framework | Capability family |
| --- | --- |
| 15-question readiness assessment | `startup_readiness_score` |
| Problem + customer + solution + willingness to pay | `business_idea_validate`, `business_idea_generator` |
| Seven-day validation plan | `business_validation_plan` |
| Ideal customer card | `ideal_customer_profile` |
| Competitor comparison | `competitor_analysis` |
| One-page business map | `business_model_builder` |
| Capital, unit cost, pricing and break-even sheets | `startup_cost_estimate`, `product_pricing_calculator`, `break_even_calculator` |
| Profitability and monthly financial sheets | `business_profitability_analysis`, `monthly_business_financial_report` |
| Offer, marketing, content and first customers | `offer_builder`, `oman_go_to_market_plan`, `content_plan_generator`, `first_10_customers_plan`, `sales_response_builder`, `whatsapp_business_setup` |
| 30-day launch, 90-day growth and risk checklist | `oman_business_launch_plan`, `business_90_day_growth_plan`, `business_risk_check` |
| Final plan and entrepreneur guide | `final_business_plan_builder`, `oman_business_launch_advisor`, `oman_business_plan_generator`, `oman_small_business_guide` |

The implementation does not reproduce the book's chapter text. It returns structured calculations, checklists, plans and provenance metadata. OMR calculations use integer baisa internally. Market, legal, tax and regulatory facts are not silently invented or treated as current.

## Example workflow

For a founder with OMR 500, an agent can call:

1. `business_idea_validate`
2. `startup_cost_estimate`
3. `product_pricing_calculator`
4. `break_even_calculator`
5. `oman_business_launch_advisor`

The book framework is deterministic where the input is numeric or checklist-based. Narrative outputs remain constrained to supplied evidence and explicitly report when live market evidence was not checked.
