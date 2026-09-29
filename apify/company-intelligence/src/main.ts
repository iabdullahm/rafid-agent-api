import { analyze } from "./adapter.js";
import { mapFailure, mapResult } from "./resultMapper.js";
import { safeError, parseInput } from "./validation.js";
import { EVENTS, type BillingMode, type Mode } from "./types.js";

class BillingFailure extends Error {
  constructor(public readonly code: "BILLING_NOT_AVAILABLE" | "SPENDING_LIMIT_REACHED", message: string) {
    super(message);
    this.name = "BillingFailure";
  }
}

export async function run(input: unknown, deps: {
  analyze?: (mode: Mode, company: import("./types.js").CompanyInput) => Promise<unknown>;
  charge: (options: { eventName: string; count?: number }) => Promise<{ chargedCount: number }>;
  pushData: (data: unknown) => Promise<void>;
  setValue: (key: string, value: unknown) => Promise<void>;
  billingMode?: BillingMode;
  log?: Pick<Console, "info" | "error">;
}): Promise<{ requested: number; succeeded: number; failed: number; chargedEvents: Record<string, number>; billing: { mode: BillingMode; charged: boolean; event: string; chargedCount: number } }> {
  const { mode, companies } = parseInput(input);
  const execute = deps.analyze ?? analyze;
  const log = deps.log ?? console;
  const billingMode = deps.billingMode ?? "production";
  const event = EVENTS[mode];
  log.info(`Actor started: mode=${mode}, companyCount=${companies.length}`);
  let succeeded = 0;
  let failed = 0;
  const chargedEvents: Record<string, number> = { [event]: 0 };
  for (const [index, company] of companies.entries()) {
    try {
      const result = await execute(mode, company);
      let charged = false;
      if (billingMode === "production") {
        let charge: { chargedCount: number };
        try {
          charge = await deps.charge({ eventName: event, count: 1 });
        } catch (error) {
          throw new BillingFailure("BILLING_NOT_AVAILABLE", error instanceof Error ? error.message : "The commercial event charge could not be completed.");
        }
        if (charge.chargedCount !== 1) {
          throw new BillingFailure("SPENDING_LIMIT_REACHED", "The commercial event charge was not completed.");
        }
        charged = true;
        chargedEvents[event]++;
      }
      await deps.pushData(mapResult(mode, company, result, { mode: billingMode, charged, event }));
      succeeded++;
      log.info(`Analysis completed: index=${index + 1}`);
    } catch (error) {
      failed++;
      const mapped = mapFailure(mode, company, safeError(error), { mode: billingMode, charged: false, event });
      await deps.pushData(mapped);
      log.error(`Analysis failed: index=${index + 1}, code=${(mapped.error as { code: string }).code}`);
    }
  }
  const summary = {
    status: "completed", mode, requested: companies.length, succeeded, failed, chargedEvents,
    billing: { mode: billingMode, charged: billingMode === "production" && Object.values(chargedEvents).some(count => count > 0), event, chargedCount: chargedEvents[event] }
  };
  await deps.setValue("OUTPUT", summary);
  log.info(`Actor completed: succeeded=${succeeded}, failed=${failed}`);
  return summary;
}
