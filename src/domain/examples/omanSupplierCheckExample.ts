/**
 * Deterministic example output for oman_supplier_check (discovery/OpenAPI/x402 Bazaar), generated
 * once by calling runOmanSupplierCheck(example) with NO live sources configured (the default) and
 * the demo registry (OMAN_BUSINESS_DATA_MODE unset). Never computed at module-load time.
 * Regenerate if src/supplier-check/ changes the output for this example.
 */
export const OMAN_SUPPLIER_CHECK_EXAMPLE_OUTPUT = {
  "supplier": {
    "inputName": "Example Technical Services LLC",
    "normalizedName": "EXAMPLE TECHNICAL SERVICES",
    "matchedName": null,
    "matchedNameAr": null,
    "companyId": null,
    "crNumber": null,
    "crNumberSupplied": null,
    "country": "OM",
    "identityMatch": "unconfirmed"
  },
  "screeningResult": {
    "risk": "insufficient_data",
    "riskScore": 0,
    "procurementSuitability": "insufficient_information",
    "identityConfirmed": false,
    "activityMatch": null,
    "summary": "There is not enough public evidence to screen this supplier (risk: insufficient_data; identity evidence: unconfirmed)."
  },
  "checks": {
    "companyIdentity": {
      "status": "unknown",
      "confidence": 0,
      "explanation": "No record in Rafid Oman company registry — Composite(Licensed Oman business-data feed (not yet integrated), Rafid curated Oman business demo dataset (demo/MVP)) matched the submitted company name. This is not evidence that the company does not exist — registry coverage is incomplete.",
      "corroborations": []
    },
    "website": {
      "status": "unknown",
      "explanation": "A website (https://example.om) was supplied, but live website inspection is not enabled for this deployment.",
      "url": "https://example.om",
      "urlSource": "supplied",
      "signals": {
        "websiteExists": null,
        "https": null,
        "domainMatchesCompanyName": null,
        "domainMatchesRegistry": null,
        "companyNameOnWebsite": null,
        "corporateEmailOnWebsite": null,
        "phoneOnWebsite": null,
        "physicalAddressOnWebsite": null,
        "redirectedToDifferentDomain": null
      }
    },
    "businessActivity": {
      "status": "unknown",
      "explanation": "No registry activity or website content was available to compare against the requested product/service.",
      "requiredCategories": [
        "hvac"
      ],
      "supplierCategories": []
    },
    "contactConsistency": {
      "status": "pass",
      "explanation": "email domain matches supplied website."
    },
    "addressConsistency": {
      "status": "unknown",
      "explanation": "No address was supplied, so address consistency was not assessed."
    },
    "sanctions": {
      "status": "not_checked",
      "matches": [],
      "listsChecked": [],
      "listsUnavailable": [],
      "explanation": "No sanctions source is enabled for this deployment; sanctions were not screened."
    },
    "publicRisk": {
      "status": "not_checked",
      "signals": [],
      "explanation": "Public-web risk screening is not enabled for this deployment; only internal consistency indicators were evaluated."
    }
  },
  "riskFlags": [
    {
      "code": "IDENTITY_NOT_CONFIRMED",
      "severity": "low",
      "message": "No registry record could be confidently matched to the submitted company."
    },
    {
      "code": "INSUFFICIENT_PUBLIC_DATA",
      "severity": "low",
      "message": "Too little public evidence was available to screen this supplier reliably."
    }
  ],
  "riskModel": {
    "score": 0,
    "thresholds": {
      "medium": 20,
      "high": 45
    },
    "components": []
  },
  "normalizedInput": {
    "companyName": "Example Technical Services LLC",
    "normalizedName": "EXAMPLE TECHNICAL SERVICES",
    "nameVariants": [
      "EXAMPLE TECHNICAL SERVICES"
    ],
    "crNumber": null,
    "website": "https://example.om",
    "websiteDomain": "example.om",
    "email": "sales@example.om",
    "emailDomain": "example.om",
    "freeEmailProvider": false,
    "phone": null,
    "address": null,
    "requiredProductOrService": "HVAC maintenance"
  },
  "sources": [],
  "dataCoverage": {
    "registryMatch": false,
    "demoDataOnly": false,
    "liveChecksPerformed": [],
    "unavailableSources": []
  },
  "confidence": 0.1,
  "limitations": [
    "This is an automated public-source procurement screening result and is not a substitute for legal, AML, KYC or regulatory due diligence.",
    "identityConfirmed means the submitted identity is consistent with the registry and contact evidence found; it is not a government verification or certification of the supplier.",
    "Sanctions screening is automated name matching only. A potential_match is not a confirmed listing, and a clear result does not guarantee the supplier is not listed under another name or on a list not checked.",
    "Public-risk signals are unverified public-source indicators, never findings of misconduct. Absence of signals is not a clearance.",
    "procurementSuitability informs the procurement decision; it is not a vendor approval or rejection.",
    "Live website inspection is not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED).",
    "Sanctions lists were not checked: no sanctions source is enabled for this deployment (RISK_LIVE_CHECKS_ENABLED / SUPPLIER_SANCTIONS_PROVIDERS).",
    "Public-web risk screening is not enabled for this deployment (WEB_SEARCH_PROVIDER)."
  ]
} as unknown;
