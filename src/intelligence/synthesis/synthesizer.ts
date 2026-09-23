import type { z } from "zod";
import { recordProviderCost } from "../costEstimator.js";

/**
 * Section "AI / LLM Usage": "If an LLM is required for synthesis, put it behind an abstraction.
 * Do NOT bind core business logic directly to a single LLM vendor... Structured output must be
 * validated before returning. Never trust raw model JSON without schema validation."
 *
 * `synthesize()` takes the zod OUTPUT schema itself and validates against it internally — a
 * caller never receives unvalidated model output. A `null` return means "synthesis is not
 * configured, or the model's output could not be validated even after a retry" — callers must
 * treat this exactly like a provider returning no evidence: fall back to an honest, lower-
 * confidence result built from raw evidence alone, never throw.
 */
export interface SynthesisEvidenceItem {
  /** A stable label the model can cite back (e.g. "source-1") — never the raw URL, so the model
   *  is never tempted to invent a URL that merely looks plausible. */
  id: string;
  title: string;
  text: string;
}

export interface SynthesisRequest {
  /** What the model is being asked to do, INCLUDING the "only use the evidence below; mark
   *  anything not stated in the evidence as null; never invent a fact" instruction — every call
   *  site is responsible for writing this instruction explicitly, never assumed by the
   *  synthesizer itself, so it's visible/auditable at the call site. */
  instruction: string;
  evidence: readonly SynthesisEvidenceItem[];
  /** For cost-attribution/logging only. */
  capability: string;
  requestId: string | null;
  /** Optional (additive): a system prompt, sent in the provider's dedicated system channel —
   *  used to state that the evidence is untrusted DATA, never instructions (document_facts_extract). */
  system?: string;
  /** Optional (additive): output-token cap (default 2000) and request timeout (default 20 s). */
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface IntelligenceSynthesizer {
  readonly name: string;
  synthesize<T>(request: SynthesisRequest, outputSchema: z.ZodType<T>): Promise<T | null>;
}

/** The honest default and what the generic capability tests exercise: no LLM provider was
 *  configured, so synthesis simply doesn't happen — the calling service builds its result from
 *  raw retrieved evidence alone (or, with no evidence either, an honest empty/low-confidence
 *  result). Never fabricates a fact by falling back to the model's own general knowledge. */
export class NotConfiguredSynthesizer implements IntelligenceSynthesizer {
  readonly name = "LLM synthesis (not configured)";
  async synthesize<T>(): Promise<T | null> {
    return null;
  }
}

export interface AnthropicSynthesizerOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  estimatedCostPerCallUSD?: number;
}

/** A real, working implementation calling the Anthropic Messages API directly (no SDK dependency
 *  added — a single `fetch` call, matching this codebase's existing "use the platform fetch, not
 *  a client library" style for services/ncsi/ncsiClient.ts and domain/oman/safeFeedFetch.ts).
 *  Entirely inert until both INTELLIGENCE_LLM_PROVIDER=anthropic, ANTHROPIC_API_KEY and
 *  INTELLIGENCE_LLM_MODEL are all set (see intelligence/config.ts) — this class is never
 *  constructed otherwise, so no core business logic anywhere imports "Anthropic" directly except
 *  this one adapter file. */
export class AnthropicSynthesizer implements IntelligenceSynthesizer {
  readonly name = "Anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly estimatedCostPerCallUSD: number;

  constructor(options: AnthropicSynthesizerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.estimatedCostPerCallUSD = options.estimatedCostPerCallUSD ?? 0.01;
  }

  async synthesize<T>(request: SynthesisRequest, outputSchema: z.ZodType<T>): Promise<T | null> {
    const evidenceBlock = request.evidence
      .map(e => `[${e.id}] ${e.title}\n${e.text}`)
      .join("\n\n");
    const prompt = [
      request.instruction,
      "",
      "Evidence (use ONLY this; if the evidence does not state something, the corresponding field must be null or an empty array/list — never invent or guess a fact):",
      evidenceBlock || "(no evidence was retrieved)",
      "",
      "Respond with ONLY a single JSON object matching the required shape. No prose before or after the JSON."
    ].join("\n");

    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.callModel(prompt, attempt > 0, request);
      if (raw === null) return null;
      const parsed = tryParseJson(raw);
      if (parsed === undefined) continue;
      const validated = outputSchema.safeParse(parsed);
      if (validated.success) {
        recordProviderCost({ provider: this.name, estimatedCostUSD: this.estimatedCostPerCallUSD, requestId: request.requestId, capability: request.capability });
        return validated.data;
      }
    }
    // Two attempts, never a validated result — treat exactly like "not configured" rather than
    // trusting an unvalidated shape or throwing mid-request.
    return null;
  }

  private async callModel(prompt: string, isRetry: boolean, request?: Pick<SynthesisRequest, "system" | "maxOutputTokens" | "timeoutMs">): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request?.timeoutMs ?? 20_000);
    try {
      const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: request?.maxOutputTokens ?? 2000,
          ...(request?.system ? { system: request.system } : {}),
          messages: [{ role: "user", content: isRetry ? `${prompt}\n\nYour previous response was not valid JSON matching the required shape. Try again, JSON only.` : prompt }]
        })
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { content?: unknown };
      const content = Array.isArray(body.content) ? body.content : [];
      const textBlock = content.find((b): b is { type: string; text: string } => Boolean(b) && typeof b === "object" && (b as { type?: unknown }).type === "text");
      return typeof textBlock?.text === "string" ? textBlock.text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Extracts and parses a JSON object from a model response that may (despite instructions)
 *  include surrounding prose or a markdown code fence — never throws; returns `undefined` on
 *  failure so the caller can retry rather than crash. */
function tryParseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return undefined; }
}
