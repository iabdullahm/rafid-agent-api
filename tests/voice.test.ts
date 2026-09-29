import test from "node:test";
import assert from "node:assert/strict";
import { transitionCall } from "../src/voice/state.js";
import { calculateVoiceCharge } from "../src/voice/billing.js";
import { VoiceService } from "../src/voice/service.js";
import { DisabledTelephonyProvider, type TelephonyProvider } from "../src/voice/providers.js";
import { aiCallAgentInput, appointmentCallAgentInput, voiceLeadQualifierInput } from "../src/schemas/voiceInputs.js";

const provider: TelephonyProvider = { name: "test", async initiate() { return { providerCallId: "provider-1" }; }, verifyWebhook() { return true; } };

test("voice state machine rejects skipped transitions", () => {
  assert.equal(transitionCall("created", "queued"), "queued");
  assert.throws(() => transitionCall("created", "completed"), /Cannot transition/);
});

test("voice billing uses base plus duration and caps duration", () => {
  assert.deepEqual(calculateVoiceCharge("ai_call_agent", 125), { baseCharge: .3, usageCharge: .31, totalCharge: .61, billableMinutes: 3 });
  assert.equal(calculateVoiceCharge("voice_lead_qualifier", 999999, 60).totalCharge, .9);
});

test("voice service creates an asynchronous call and enforces maximum duration", async () => {
  const service = new VoiceService({ telephony: provider, now: () => new Date("2026-09-26T00:00:00.000Z") });
  const input = aiCallAgentInput.parse({ phoneNumber: "+96891234567", objective: "Confirm product demonstration interest", language: "en", maxDurationSeconds: 30 });
  const call = await service.start("ai_call_agent", input);
  assert.equal(call.status, "dialing");
  const completed = service.update(call.callId, "ringing");
  assert.equal(completed.status, "ringing");
  assert.equal(service.update(call.callId, "answered").answered, true);
  assert.equal(service.update(call.callId, "in_progress").durationSeconds, 0);
  assert.equal(service.update(call.callId, "completed", 99).durationSeconds, 30);
});

test("qualification rubric returns a deterministic classification with evidence", async () => {
  const service = new VoiceService({ telephony: provider });
  const input = voiceLeadQualifierInput.parse({ phoneNumber: "+96891234567", language: "en", criteria: { minimumBudget: 1000, decisionMakerRequired: true } });
  const result = service.qualify(input, { structuredFacts: { interest: "high", businessNeed: "automation", productRequested: "voice", budgetAmount: 1500, budget: "OMR 1,000-2,000", timelineDays: 15, timeline: "within_30_days", decisionMaker: true, objections: ["Needs management approval"] } });
  assert.equal((result.qualification as { classification: string }).classification, "qualified");
  assert.equal((result.qualification as { evidence: unknown[] }).evidence.length, 9);
});

test("appointment logic requires a slot for booking", async () => {
  const service = new VoiceService({ telephony: provider });
  const invalid = appointmentCallAgentInput.parse({ phoneNumber: "+96891234567", action: "book", appointmentType: "Demo", timezone: "Asia/Muscat", language: "en" });
  await assert.rejects(() => service.appointment(invalid), (error: unknown) => (error as { code?: string }).code === "SLOT_REQUIRED");
});

test("real calling fails closed when provider credentials are absent", async () => {
  const service = new VoiceService({ telephony: new DisabledTelephonyProvider() });
  const input = aiCallAgentInput.parse({ phoneNumber: "+96891234567", objective: "Confirm product demonstration interest", language: "en" });
  await assert.rejects(() => service.start("ai_call_agent", input), (error: unknown) => (error as { code?: string }).code === "VOICE_PROVIDER_NOT_CONFIGURED");
});
