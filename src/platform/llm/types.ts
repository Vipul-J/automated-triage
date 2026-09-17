import type { CatalogEntry, EnrichmentContext, RetrievedDoc, Ticket } from "../../core/types.js";
import type { RawRecommendation } from "./schema.js";

export interface InferenceRequest {
  readonly ticket: Ticket;
  readonly context: EnrichmentContext;
  readonly documents: readonly RetrievedDoc[];
  readonly catalog: readonly CatalogEntry[];
  readonly deterministicHint: { team: string; reason: string } | null;
  readonly signal?: AbortSignal;
}

export interface InferenceUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
}

export interface InferenceResponse {
  readonly recommendation: RawRecommendation;
  readonly model: string;
  readonly usage: InferenceUsage;
}

/** The model gateway. Swapping providers or adding failover happens behind this. */
export interface TriageModel {
  readonly name: string;
  readonly isMock: boolean;
  infer(request: InferenceRequest): Promise<InferenceResponse>;
}
