import express from "express";
import type { VoiceService } from "../voice/service.js";
import { ApiError } from "../utils/errors.js";

export function createVoiceRoutes(service: VoiceService) {
  const router = express.Router();
  router.get("/api/v1/calls/:callId", (req, res, next) => { try { res.json({ success: true, data: service.get(req.params.callId), meta: { requestId: res.locals.requestId } }); } catch (e) { next(e); } });
  router.post("/api/v1/voice/webhooks", express.raw({ type: "application/json", limit: "64kb" }), (req, res, next) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body ?? {});
      if (!service.verifyWebhook(raw, req.header("x-voice-signature"))) throw new ApiError(401, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed.");
      const body = JSON.parse(raw) as { eventId?: string; callId?: string; status?: string; durationSeconds?: number; result?: Record<string, unknown> };
      if (!body.callId || !body.status) throw new ApiError(400, "INVALID_WEBHOOK", "callId and status are required");
      const allowed = new Set(["answered", "in_progress", "completed", "no_answer", "busy", "rejected", "failed", "cancelled"]);
      if (!allowed.has(body.status)) throw new ApiError(400, "INVALID_WEBHOOK_STATUS", "Unsupported provider status");
      const data = service.updateFromWebhook(body.eventId ?? raw, body.callId, body.status as never, body.durationSeconds ?? 0, body.result);
      res.json({ success: true, data, meta: { requestId: res.locals.requestId } });
    } catch (e) { next(e); }
  });
  return router;
}
