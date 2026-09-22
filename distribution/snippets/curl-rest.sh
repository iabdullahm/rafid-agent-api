#!/usr/bin/env bash
# REST call to analyze_oman_property using an API key.
# Replace BASE_URL and API_KEY. See ../OPENAPI.md for the full route family and ../QUICKSTART.md
# for how this compares to the MCP and x402 paths.

BASE_URL="https://api.rafidsystem.com"
API_KEY="<your-api-key>"

curl -sS -X POST "$BASE_URL/api/v1/oman/property/analyze" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "governorate": "Muscat",
    "area": "Al Mouj",
    "propertyType": "apartment",
    "bedrooms": 2,
    "sizeSqm": 130,
    "askingPriceOMR": 118000
  }'
