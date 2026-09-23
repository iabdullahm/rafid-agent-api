import { SAMPLE_SERVICE_AGREEMENT } from "../../document-facts/examples/samples.js";

/** document_facts_extract's registry example: a synthetic two-page service agreement (pages
 *  separated by \f) with three targeted requested facts. */
export const DOCUMENT_FACTS_EXAMPLE_INPUT = {
  text: SAMPLE_SERVICE_AGREEMENT,
  documentType: "auto" as const,
  requestedFacts: ["contract expiry date", "termination notice period", "annual contract value"],
  mode: "auto" as const
};
