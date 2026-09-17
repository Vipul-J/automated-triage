import { STAGE_BUDGET_MS } from "../config/index.js";
import { InvalidModelOutputError, ModelRefusalError } from "../core/errors.js";
import type {
  CatalogEntry,
  Recommendation,
  RetrievedDoc,
  Ticket,
  TriageResult,
} from "../core/types.js";
import { catalogRepository } from "../platform/db/repositories/catalog.repository.js";
import { knowledgeRepository } from "../platform/db/repositories/knowledge.repository.js";
import { triageRepository } from "../platform/db/repositories/triage.repository.js";
import { getTriageModel } from "../platform/llm/index.js";
import { loggerFor } from "../platform/logging/logger.js";
import { timed, withTimeout } from "../core/deadline.js";
import { scoreConfidence } from "./confidence.js";
import { enrich, type EnrichmentSources } from "./enrichment.js";
import { runGuardrails } from "./guardrails.js";
import { decide } from "./policy.js";
import { preclassify } from "./preclassifier.js";
import { redact, rehydrate } from "./redaction.js";

const log = loggerFor("pipeline");
const RETRIEVAL_LIMIT = 8;

export interface PipelineDeps {
  readonly enrichmentSources: EnrichmentSources;
}

/**
 * Runs one ticket through the full triage pipeline.
 *
 * Stage order and budgets come from the latency table in design doc section 4.
 * Every stage is capped; enrichment and retrieval degrade rather than fail, and
 * a model failure falls back to the deterministic path instead of dropping the
 * ticket. The worst outcome available here is "no recommendation", which leaves
 * the ticket to escalate exactly as it does today.
 */
export async function runTriage(ticket: Ticket, deps: PipelineDeps): Promise<TriageResult> {
  const timings: Record<string, number> = {};
  const degraded: string[] = [];
  const runId = await triageRepository.startRun(ticket.id);

  const catalog = await timed(timings, "catalog", () => catalogRepository.listActive());

  const context = await timed(timings, "enrich", () => enrich(ticket, deps.enrichmentSources));
  degraded.push(...context.missing);

  // Everything downstream of here sees tokenised text, never raw PII.
  const redaction = redact(`${ticket.subject}\n\n${ticket.body}`);
  const safeTicket: Ticket = {
    ...ticket,
    subject: redact(ticket.subject).text,
    body: redact(ticket.body).text,
  };

  const documents = await timed(timings, "retrieve", async () => {
    try {
      return await withTimeout("retrieve", STAGE_BUDGET_MS.retrieve, () =>
        knowledgeRepository.search(redaction.text, { limit: RETRIEVAL_LIMIT }),
      );
    } catch (err) {
      // Retrieval is degradable: routing continues on the catalog alone, and
      // the missing neighbour signal costs confidence downstream.
      log.warn({ err, ticketId: ticket.id }, "retrieval failed, continuing without neighbours");
      degraded.push("retrieval");
      return [] as RetrievedDoc[];
    }
  });

  const deterministicMatch = preclassify(safeTicket, catalog);

  const inference = await timed(timings, "infer", () =>
    inferWithFallback({
      ticket: safeTicket,
      context,
      documents,
      catalog,
      deterministicMatch,
      degraded,
    }),
  );

  const recommendation: Recommendation = {
    ...inference.recommendation,
    // Rehydrate only the customer-facing text: the customer gets a personalised
    // reply without their data having been in the prompt.
    clientResponse: rehydrate(inference.recommendation.clientResponse, redaction.tokens),
  };

  const guardrails = await timed(timings, "guardrails", () =>
    runGuardrails({ recommendation, catalog }),
  );

  const confidence = scoreConfidence({
    recommendation,
    documents,
    context,
    deterministicMatch,
    guardrails,
  });

  const decision = decide({ ticket, recommendation, confidence, guardrails, context });

  await triageRepository.finishRun(runId, {
    model: inference.model,
    promptVersion: "triage-v1",
    inputTokens: inference.usage.inputTokens,
    outputTokens: inference.usage.outputTokens,
    cacheReadTokens: inference.usage.cacheReadTokens,
    timings,
    degraded,
    outcome: decision.tier,
  });

  log.info(
    {
      ticketId: ticket.id,
      tier: decision.tier,
      owner: decision.owner,
      team: recommendation.recommendedTeam,
      confidence: confidence.composite,
      totalMs: Object.values(timings).reduce((a, b) => a + b, 0),
    },
    "triage complete",
  );

  return {
    runId,
    ticket,
    recommendation,
    confidence,
    decision,
    evidence: documents,
    guardrails,
    timings,
    degraded,
    usedMockLlm: getTriageModel().isMock,
  };
}

/**
 * Model call with the fallback ladder from design doc section 14: a schema or
 * transport failure degrades to the deterministic route rather than failing the
 * ticket. A refusal is NOT retried - it is surfaced as low confidence so the
 * policy engine routes it to a human.
 */
async function inferWithFallback(args: {
  ticket: Ticket;
  context: Awaited<ReturnType<typeof enrich>>;
  documents: readonly RetrievedDoc[];
  catalog: readonly CatalogEntry[];
  deterministicMatch: ReturnType<typeof preclassify>;
  degraded: string[];
}) {
  const model = getTriageModel();
  try {
    return await withTimeout("infer", STAGE_BUDGET_MS.infer, (signal) =>
      model.infer({
        ticket: args.ticket,
        context: args.context,
        documents: args.documents,
        catalog: args.catalog,
        deterministicHint: args.deterministicMatch
          ? { team: args.deterministicMatch.team, reason: args.deterministicMatch.reason }
          : null,
        signal,
      }),
    );
  } catch (err) {
    const reason =
      err instanceof ModelRefusalError
        ? "model-refusal"
        : err instanceof InvalidModelOutputError
          ? "invalid-model-output"
          : "model-unavailable";

    log.warn({ err, ticketId: args.ticket.id, reason }, "falling back to deterministic routing");
    args.degraded.push(reason);

    return {
      recommendation: deterministicRecommendation(
        args.ticket,
        args.catalog,
        args.deterministicMatch,
      ),
      model: `fallback:${reason}`,
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null },
    };
  }
}

/** Last resort before "do nothing": route on rules alone, flagged for a human. */
function deterministicRecommendation(
  ticket: Ticket,
  catalog: readonly CatalogEntry[],
  match: ReturnType<typeof preclassify>,
): Recommendation {
  const fallbackTeam =
    match?.team ?? catalog.find((c) => c.level === "L2" && c.active)?.team ?? catalog[0]?.team;

  if (!fallbackTeam) throw new Error("Service catalog is empty; cannot route");
  const entry = catalog.find((c) => c.team === fallbackTeam);

  return {
    summary: ticket.subject,
    category: entry?.service ?? "uncategorised",
    affectedService: entry?.service ?? null,
    severity: "P3",
    recommendedTeam: fallbackTeam,
    recommendedLevel: entry?.level ?? "L2",
    alternatives: [],
    confidence: 0.2,
    rationale: match
      ? `Model unavailable. Deterministic route only: ${match.reason}.`
      : "Model unavailable and no deterministic match. Needs a human.",
    evidence: [],
    clientResponse:
      "Thanks for getting in touch. Your ticket has been received and is with our " +
      "support team for review. Someone will come back to you shortly with an update.",
    needsHuman: true,
    missingInformation: ["Model inference unavailable for this ticket"],
  };
}
