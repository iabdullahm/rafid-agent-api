import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError } from "../utils/errors.js";
const digest = (key: string) => createHash("sha256").update(key).digest();
export function apiKeyAuth(keys: string[]): RequestHandler {
  const accepted = keys.map(digest);
  return (req, res, next) => {
    const presented = digest(req.header("x-api-key") ?? "");
    let index = -1;
    accepted.forEach((key, i) => { if (timingSafeEqual(presented, key)) index = i; });
    if (index < 0) return next(new ApiError(401, "UNAUTHORIZED", "A valid X-API-Key header is required"));
    // Replace this configuration-local principal with durable customer IDs before billing.
    res.locals.customerId = `configured-key-${index}`;
    next();
  };
}
