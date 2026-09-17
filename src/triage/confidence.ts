import type {
  ConfidenceBreakdown,
  EnrichmentContext,
  GuardrailResult,
  Recommendation,
  RetrievedDoc,
} from "../core/types.js";
import type { DeterministicMatch } from "./preclassifier.js";

/**
 * Weights for the composite score. Neighbour agreement carries the most because
 * it is the only signal grounded in what actually happened: the resolving team
 * of genuinely similar past tickets.
 */
const WEIGHTS = Object.freeze({
  model: 0.25,
  neighbourAgreement: 0.35,
  catalogMatch: 0.2,
  contextCompleteness: 0.1,
  guardrails: 0.1,
});

const ENRICHMENT_SOURCE_COUNT = 3;

/**
 * An LLM's self-reported confidence is poorly calibrated on its own, so it is
 * one input among several rather than the answer (design doc 7.3).
 *
 * In production these weights are fitted against held-out historical data and
 * recalibrated monthly; the constants above are a starting point, not a result.
 */
export function scoreConfidence(args: {
  recommendation: Recommendation;
  documents: readonly RetrievedDoc[];
  context: EnrichmentContext;
  deterministicMatch: DeterministicMatch | null;
  guardrails: readonly GuardrailResult[];
}): ConfidenceBreakdown {
  const { recommendation, documents, context, deterministicMatch, guardrails } = args;

  const neighbours = documents.filter((d) => d.kind === "ticket" && d.resolvedTeam);
  const agreeing = neighbours.filter((d) => d.resolvedTeam === recommendation.recommendedTeam);
  const neighbourAgreement = neighbours.length > 0 ? agreeing.length / neighbours.length : 0;

  const catalogMatch = deterministicMatch
    ? deterministicMatch.team === recommendation.recommendedTeam
      ? deterministicMatch.strength
      : // The deterministic prior disagrees with the model. That is a real
        // signal of ambiguity, so it actively costs confidence.
        0
    : 0.35;

  const contextCompleteness = Math.max(
    0,
    (ENRICHMENT_SOURCE_COUNT - context.missing.length) / ENRICHMENT_SOURCE_COUNT,
  );

  const failed = guardrails.filter((g) => !g.passed).length;
  const guardrailScore = guardrails.length === 0 ? 1 : Math.max(0, 1 - failed / guardrails.length);

  const parts = {
    model: recommendation.confidence,
    neighbourAgreement,
    catalogMatch,
    contextCompleteness,
    guardrails: guardrailScore,
  };

  let composite = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce(
    (sum, key) => sum + WEIGHTS[key] * parts[key],
    0,
  );

  // The model's own "I am not sure about this" is treated as authoritative
  // downward - it may be badly calibrated high, but never ignore it low.
  if (recommendation.needsHuman) composite = Math.min(composite, 0.5);

  return {
    ...parts,
    composite: Number(composite.toFixed(4)),
    note: buildNote(
      agreeing.length,
      neighbours.length,
      recommendation.recommendedTeam,
      deterministicMatch,
    ),
  };
}

function buildNote(
  agreeing: number,
  total: number,
  team: string,
  match: DeterministicMatch | null,
): string {
  const parts: string[] = [];
  parts.push(
    total > 0
      ? `${agreeing} of ${total} similar past tickets were resolved by ${team}`
      : "no similar past tickets matched",
  );
  if (match) {
    parts.push(
      match.team === team
        ? `catalog keywords agree (${match.reason})`
        : `catalog keywords instead suggest ${match.team}`,
    );
  }
  return parts.join("; ");
}
