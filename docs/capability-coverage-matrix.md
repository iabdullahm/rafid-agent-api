# Capability coverage matrix

Generated from `src/domain/capabilities.ts` on 2026-09-30T04:41:14.552Z. Counts and route-family status are derived from the canonical registry; PASS means the public route family is registry-driven, not that a live deployment has been verified.

- Canonical capabilities: **69**
- REST routes: **69**
- MCP tools: **69**
- OpenAPI operations: **69**
- A2A/agent-card skills: **69**
- Public tool pages: **69**
- Preview-enabled: **24**
- Paid: **69**

| # | Capability | Category | Price | REST | MCP | OpenAPI | A2A | Preview | Tool page | Guidance | Notes |
|---:|---|---|---:|---|---|---|---|---|---|---|---|
| 1 | `analyze_property` | property | $0.01 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 2 | `compare_properties` | property | $0.03 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 3 | `estimate_maintenance` | property | $0.02 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 4 | `analyze_oman_property` | property | $0.25 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 5 | `search_oman_company` | risk_intelligence | $0.05 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 6 | `get_oman_company_profile` | risk_intelligence | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 7 | `analyze_oman_company` | risk_intelligence | $0.75 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 8 | `due_diligence_oman_company` | risk_intelligence | $2.00 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 9 | `research_company` | risk_intelligence | $0.15 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 10 | `find_companies` | risk_intelligence | $0.05 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 11 | `analyze_company_risk` | risk_intelligence | $0.35 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 12 | `oman_supplier_check` | supplier | $0.50 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 13 | `company_reputation_check` | risk_intelligence | $0.40 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 14 | `business_risk_score` | risk_intelligence | $0.50 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 15 | `social_video_generate` | video_generation | $1.50 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 16 | `news_video_generate` | video_generation | $1.50 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 17 | `product_promo_video` | video_generation | $2.00 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 18 | `company_due_diligence` | risk_intelligence | $1.50 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 19 | `document_facts_extract` | document_intelligence | $0.25 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 20 | `invoice_anomaly_check` | finance_risk | $0.25 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 21 | `vehicle_value_estimate` | automotive | $0.25 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 22 | `website_download` | website_services | $0.75 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 23 | `extract_candidate_profile` | recruitment | $0.10 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 24 | `generate_job_profile` | recruitment | $0.10 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 25 | `cv_score` | recruitment | $0.20 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 26 | `cv_job_match` | recruitment | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 27 | `cv_improve` | recruitment | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 28 | `candidate_shortlist_score` | recruitment | $0.10 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 29 | `strategy_performance_analysis` | trading | $0.35 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 30 | `trade_risk_score` | trading | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 31 | `portfolio_exposure_check` | trading | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 32 | `trade_log_analysis` | trading | $0.30 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 33 | `shipping_cost_estimate` | logistics | $0.25 USD | PASS | PASS | PASS | PASS | PASS | PASS | PASS | — |
| 34 | `ai_call_agent` | voice | $0.30 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 35 | `voice_lead_qualifier` | voice | $0.75 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 36 | `website_project_estimate` | website_services | $0.25 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 37 | `website_audit` | website_services | $0.75 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 38 | `appointment_call_agent` | voice | $0.50 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 39 | `supplier_due_diligence_report` | supplier | $1.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 40 | `company_risk_report` | risk_intelligence | $1.50 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 41 | `property_investment_report` | property | $0.75 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 42 | `portfolio_screen` | property | $0.50 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 43 | `procurement_vendor_shortlist` | supplier | $2.00 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 44 | `company_risk_batch` | risk_intelligence | $8.00 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 45 | `startup_readiness_score` | book_business | $0.05 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 46 | `business_idea_validate` | book_business | $0.25 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 47 | `business_idea_generator` | book_business | $0.20 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 48 | `business_validation_plan` | book_business | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 49 | `ideal_customer_profile` | book_business | $0.20 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 50 | `competitor_analysis` | book_business | $0.30 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 51 | `business_model_builder` | book_business | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 52 | `startup_cost_estimate` | book_business | $0.10 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 53 | `product_pricing_calculator` | book_business | $0.10 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 54 | `break_even_calculator` | book_business | $0.10 USD | PASS | PASS | PASS | PASS | PASS | PASS | WARN | — |
| 55 | `business_profitability_analysis` | book_business | $0.15 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 56 | `offer_builder` | book_business | $0.20 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 57 | `oman_go_to_market_plan` | book_business | $0.40 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 58 | `content_plan_generator` | book_business | $0.20 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 59 | `first_10_customers_plan` | book_business | $0.25 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 60 | `sales_response_builder` | book_business | $0.10 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 61 | `whatsapp_business_setup` | book_business | $0.20 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 62 | `monthly_business_financial_report` | book_business | $0.15 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 63 | `oman_business_launch_plan` | book_business | $0.40 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 64 | `business_90_day_growth_plan` | book_business | $0.40 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 65 | `business_risk_check` | book_business | $0.20 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 66 | `final_business_plan_builder` | book_business | $0.50 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 67 | `oman_business_launch_advisor` | book_business | $0.50 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 68 | `oman_business_plan_generator` | book_business | $1.00 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
| 69 | `oman_small_business_guide` | book_business | $0.15 USD | PASS | PASS | PASS | PASS | WARN | PASS | WARN | — |
