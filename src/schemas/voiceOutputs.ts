import { z } from "zod";

export const callStatus = z.enum(["created", "queued", "dialing", "ringing", "answered", "in_progress", "completed", "no_answer", "busy", "rejected", "failed", "cancelled"]);
export const transcriptTurn = z.object({ speaker: z.enum(["agent", "customer"]), text: z.string(), at: z.string().datetime() });
export const callResult = z.object({
  callId: z.string(), status: callStatus, answered: z.boolean(), durationSeconds: z.number().int().nonnegative(),
  outcome: z.string().nullable(), summary: z.string().nullable(), nextAction: z.string().nullable(),
  structuredFacts: z.record(z.string(), z.unknown()), transcript: z.array(transcriptTurn),
  createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable()
});
export const leadQualification = z.object({ score: z.number().int().min(0).max(100), classification: z.enum(["unqualified", "needs_review", "qualified"]), intent: z.enum(["low", "medium", "high"]), budget: z.string().nullable(), timeline: z.string().nullable(), decisionMaker: z.boolean().nullable(), objections: z.array(z.string()), evidence: z.array(z.object({ field: z.string(), value: z.unknown(), source: z.enum(["customer_statement", "provider_event", "derived"]) })) });
export const voiceLeadQualifierOutput = callResult.extend({ qualification: leadQualification, recommendedNextAction: z.string() });
export const appointmentCallAgentOutput = z.object({ callId: z.string(), status: z.enum(["proposed", "confirmed", "rescheduled", "cancelled", "failed"]), confirmedSlot: z.string().datetime({ offset: true }).nullable(), customerNotes: z.string().nullable(), calendarEventId: z.string().nullable() });
