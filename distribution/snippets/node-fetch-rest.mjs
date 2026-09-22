// Node fetch client for the API-key REST route. Requires Node 18+ (global fetch) or an
// equivalent fetch polyfill. See ../OPENAPI.md for the full route family.

const BASE_URL = "https://api.rafidsystem.com";
const API_KEY = process.env.RAFID_API_KEY ?? "<your-api-key>";

async function analyzeOmanProperty(input) {
  const res = await fetch(`${BASE_URL}/api/v1/oman/property/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Rafid call failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data; // response envelope is { success, data, meta } — the analysis result is `data`
}

const result = await analyzeOmanProperty({
  governorate: "Muscat",
  area: "Al Mouj",
  propertyType: "apartment",
  bedrooms: 2,
  sizeSqm: 130,
  askingPriceOMR: 118000,
});

// Always check provenance/dataQuality before reporting a figure — see
// ../examples/al-mouj-agent-flow.md.
console.log(result.pricePosition, result.provenance, result.dataQuality);
