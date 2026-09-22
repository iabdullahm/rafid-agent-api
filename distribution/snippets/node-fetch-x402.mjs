// Node fetch client for the x402 pay-per-call route. This is the same shape shown in
// ../X402.md's "x402 client example" — `wallet` is a stand-in for a real x402-aware
// payment signer from your own client library. Never construct or transmit a raw
// private key by hand; this snippet does not, and cannot, sign a real payment itself.

const BASE_URL = "https://rafid-agent-api.vercel.app";

async function callWithX402(path, body, wallet) {
  const url = `${BASE_URL}/api/v1/x402${path}`;

  const first = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (first.status !== 402) return first.json(); // already paid for, or free

  const requirements = JSON.parse(
    Buffer.from(first.headers.get("PAYMENT-REQUIRED"), "base64").toString("utf8")
  );

  // `wallet.buildPayment` is supplied by a real x402-aware payment library in your own
  // integration — not implemented here. See the x402 protocol spec, or an existing
  // x402 client SDK, for how to construct a valid payment proof.
  const paymentHeader = await wallet.buildPayment(requirements.accepts[0]);

  const second = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader },
    body: JSON.stringify(body),
  });
  return second.json();
}

// Example call (requires a real `wallet` implementation to actually complete):
// const result = await callWithX402("/oman/property/analyze", {
//   governorate: "Muscat", area: "Al Mouj", propertyType: "apartment",
//   bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000
// }, wallet);

export { callWithX402 };
