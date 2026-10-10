import { capabilities } from "../domain/capabilities.js";

// Generated from the canonical runtime registry, including appended capability modules.
// Never maintain a parallel hand-written list of product names/prices for RapidAPI.
export function marketplaceCatalog() {
  return capabilities.map(c => ({
    name: c.name,
    method: "POST",
    path: "/rapidapi/v1" + c.path,
    price: c.price,
    currency: c.currency,
    status: "not_enabled",
    reason: "Gateway execution, provider coverage and billing release gates pending"
  }));
}
