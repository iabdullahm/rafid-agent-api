import { z } from "zod";

const phoneNumber = z.string().regex(/^\+[1-9]\d{7,14}$/, "phoneNumber must be an E.164 number");
const language = z.enum(["en", "ar"]);
const context = z.record(z.string(), z.string().max(500)).optional();
const safety = z.object({
  consentNotice: z.string().max(500).optional(),
  recording: z.boolean().default(false),
  transcription: z.boolean().default(false),
  timezone: z.string().max(100).optional()
}).optional();

export const aiCallAgentInput = z.strictObject({
  phoneNumber, objective: z.string().trim().min(10).max(2000), language,
  maxDurationSeconds: z.number().int().min(1).max(3600).default(300), context, safety
});

export const voiceLeadQualifierInput = z.strictObject({
  phoneNumber, language, maxDurationSeconds: z.number().int().min(1).max(3600).default(300),
  context, criteria: z.object({
    requiredInterest: z.boolean().default(false), minimumBudget: z.number().nonnegative().optional(),
    currency: z.string().length(3).default("USD"), targetTimelineDays: z.number().int().positive().default(30),
    decisionMakerRequired: z.boolean().default(false)
  }).default({ requiredInterest: false, currency: "USD", targetTimelineDays: 30, decisionMakerRequired: false }), safety
});

export const appointmentCallAgentInput = z.strictObject({
  phoneNumber, action: z.enum(["propose", "book", "confirm", "reschedule", "cancel"]),
  appointmentType: z.string().trim().min(2).max(200),
  availableSlots: z.array(z.string().datetime({ offset: true })).max(20).default([]),
  timezone: z.string().min(1).max(100), language, maxDurationSeconds: z.number().int().min(1).max(3600).default(300),
  context, safety
});
