import { getAnthropicApiKey, getIntelligenceLlmMode, getIntelligenceLlmModel } from "../config.js";
import { AnthropicSynthesizer, NotConfiguredSynthesizer, type IntelligenceSynthesizer } from "./synthesizer.js";

export function buildIntelligenceSynthesizer(): IntelligenceSynthesizer {
  const mode = getIntelligenceLlmMode();
  if (mode === "none") return new NotConfiguredSynthesizer();
  const apiKey = getAnthropicApiKey();
  const model = getIntelligenceLlmModel();
  if (!apiKey || !model) return new NotConfiguredSynthesizer(); // misconfigured — fail honest-empty, never throw mid-request.
  return new AnthropicSynthesizer({ apiKey, model });
}

export function isSynthesisConfigured(): boolean {
  return getIntelligenceLlmMode() !== "none" && Boolean(getAnthropicApiKey()) && Boolean(getIntelligenceLlmModel());
}
