# Rafid x402 Buyer Quickstart

API: https://api.rafidsystem.com
Network: Base Mainnet (eip155:8453)
Payment Asset: USDC
Protocol: x402 v2

## Example capability

POST https://api.rafidsystem.com/api/v1/x402/property/analyze

Content-Type: application/json

{
  "propertyValue": 85000,
  "annualRent": 7200,
  "serviceCharge": 650,
  "maintenanceCost": 400
}

## Payment flow

1. Send the HTTP POST request without a payment signature.
2. Expect HTTP 402 Payment Required.
3. Decode the PAYMENT-REQUIRED base64 header as JSON.
4. Read accepts[] and select an authorized requirement.
5. Verify network, asset, amount, and receiver.
6. Use an x402 v2 compatible wallet/client to create
   the payment authorization.
7. Retry the identical method, URL, and request body
   with the PAYMENT-SIGNATURE header.
8. Preserve payment journey correlation headers.
9. Inspect the returned payment receipt and response.
10. Do not repeatedly retry a rejected or consumed
    payment authorization.

Never send wallet private keys to Rafid.

## Discovery

GET https://api.rafidsystem.com/api/v1/capabilities
GET https://api.rafidsystem.com/api/v1/payment-methods
GET https://api.rafidsystem.com/api/v1/x402/status

## Important

An HTTP 402 challenge is not a payment failure.
No payment occurs without an authorized signed retry.
