import { ApiError } from "../utils/errors.js";
import type { z } from "zod";
import { callStatus } from "../schemas/voiceOutputs.js";
export type CallStatus = z.infer<typeof callStatus>;
const transitions: Record<CallStatus, readonly CallStatus[]> = {
  created: ["queued", "cancelled", "failed"], queued: ["dialing", "cancelled", "failed"], dialing: ["ringing", "busy", "rejected", "failed", "no_answer"], ringing: ["answered", "busy", "rejected", "no_answer", "failed"], answered: ["in_progress", "completed", "cancelled", "failed"], in_progress: ["completed", "cancelled", "failed"], completed: [], no_answer: [], busy: [], rejected: [], failed: [], cancelled: []
};
export function transitionCall(status: CallStatus, next: CallStatus): CallStatus { if (!transitions[status].includes(next)) throw new ApiError(409, "INVALID_CALL_TRANSITION", `Cannot transition call from ${status} to ${next}`); return next; }
