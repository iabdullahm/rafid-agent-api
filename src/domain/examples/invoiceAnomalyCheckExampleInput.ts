import { SCENARIOS } from "../../invoice-anomaly/examples/scenarios.js";

/** invoice_anomaly_check's registry example input: a synthetic (fictional) invoice that is a
 *  near-duplicate of a pending invoice, carries a changed bank account, and is billed against
 *  another supplier's purchase order. */
export const INVOICE_ANOMALY_EXAMPLE_INPUT = SCENARIOS.multiple;
