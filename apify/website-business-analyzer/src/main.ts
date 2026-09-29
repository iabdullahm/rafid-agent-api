import { analyzeWebsite, AnalyzerError, type AnalyzerOptions } from "./analyzer.js";
export async function run(input: unknown, deps: { pushData: (value: unknown) => Promise<void>; setValue: (key: string, value: unknown) => Promise<void>; analyzer?: (input: unknown, options?: AnalyzerOptions) => Promise<unknown>; options?: AnalyzerOptions; }) {
  try { const result = await (deps.analyzer ?? analyzeWebsite)(input, deps.options); await deps.pushData(result); await deps.setValue("OUTPUT", result); return result; }
  catch (error) { const e = error instanceof AnalyzerError ? error : new AnalyzerError("CRAWL_FAILED", error instanceof Error ? error.message : "Actor failed."); const result = { schemaVersion: "1.0", success: false, error: { code: e.code, message: e.message } }; await deps.pushData(result); await deps.setValue("OUTPUT", result); return result; }
}
