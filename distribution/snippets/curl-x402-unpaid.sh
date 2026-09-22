#!/usr/bin/env bash
# Unpaid x402 call: the normal first step of the x402 flow (see ../X402.md).
# Returns 402 Payment Required with a base64-encoded PAYMENT-REQUIRED header
# describing the accepted payment terms — no wallet or payment proof needed
# for this step.

BASE_URL="https://api.rafidsystem.com"

curl -s -i -X POST "$BASE_URL/api/v1/x402/property/analyze" \
  -H "Content-Type: application/json" \
  -d '{"propertyValue":85000,"annualRent":7200}'

# Then, to read the payment terms out of the response:
#   curl -s -i ... | grep -i '^PAYMENT-REQUIRED:' | cut -d' ' -f2- | base64 -d
#
# Retrying with a valid payment proof requires an x402-aware wallet/signer client —
# out of scope for a plain curl snippet. See ../X402.md's "x402 client example" for
# the request/response shape of the paid retry.
