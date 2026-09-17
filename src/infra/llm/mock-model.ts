import { detectSensitive } from "../../pipeline/policy.js";
import type { Level, Severity } from "../../domain/types.js";
import type { RawRecommendation } from "./schema.js";
import type { InferenceRequest, InferenceResponse, TriageModel } from "./types.js";

const SEVERITY_SIGNALS: ReadonlyArray<readonly [Severity, readonly string[]]> = [
  ["P1", ["outage", "down", "data loss", "breach", "cannot access at all", "everyone"]],
  ["P2", ["broken", "failing", "duplicate charge", "crash", "blocked", "not working"]],
  ["P4", ["how do i", "question", "where is", "cosmetic", "typo", "wondering"]],
];

/**
 * Deterministic stand-in for the model, used when no API credential is present.
 *
 * It votes on the retrieved neighbours' resolving teams rather than returning a
 * fixed answer, so the surrounding pipeline - retrieval, confidence scoring,
 * guardrails, policy tiers, the deadline race - is exercised honestly end to end
 * and tests stay reproducible. It is not a substitute for the real model's
 * judgement, and it deliberately reports modest confidence.
 */
export class MockTriageModel implements TriageModel {
  readonly name = "mock-deterministic";
  readonly isMock = true;

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const { ticket, documents, catalog, deterministicHint } = request;
    const haystack = `${ticket.subject} ${ticket.body}`.toLowerCase();

    const votes = new Map<string, number>();
    for (const [index, doc] of documents.entries()) {
      if (!doc.resolvedTeam) continue;
      votes.set(doc.resolvedTeam, (votes.get(doc.resolvedTeam) ?? 0) + 1 / (index + 1));
    }
    if (deterministicHint) {
      votes.set(deterministicHint.team, (votes.get(deterministicHint.team) ?? 0) + 1.5);
    }

    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const activeTeams = catalog.filter((c) => c.active);
    const fallbackTeam = activeTeams.find((c) => c.level === "L2")?.team ?? activeTeams[0]?.team;

    // Reuse the policy engine's detector rather than keeping a second list.
    // A previous duplicate list matched bare "credential", which sent every
    // "invalid credentials" password ticket to the security team.
    const isSecurity = detectSensitive(ticket) !== null;
    const securityTeam = activeTeams.find((c) => c.service === "security")?.team;

    const chosenTeam = isSecurity && securityTeam
      ? securityTeam
      : (ranked[0]?.[0] ?? fallbackTeam);

    if (!chosenTeam) throw new Error("Service catalog is empty; cannot produce a recommendation");

    const entry = activeTeams.find((c) => c.team === chosenTeam);
    const totalVotes = ranked.reduce((sum, [, v]) => sum + v, 0);
    const share = ranked[0] && totalVotes > 0 ? ranked[0][1] / totalVotes : 0;

    const recommendation: RawRecommendation = {
      summary: ticket.subject,
      category: entry?.service ?? "uncategorised",
      affectedService: entry?.service ?? null,
      severity: this.severityFor(haystack),
      recommendedTeam: chosenTeam,
      recommendedLevel: (entry?.level ?? "L2") as Level,
      alternatives: ranked
        .slice(1, 3)
        .filter(([team]) => team !== chosenTeam)
        .map(([team]) => ({ team, why: "Also appeared among similar resolved tickets." })),
      // Deliberately capped: a stub must never look confident enough to auto-apply.
      confidence: Math.min(0.72, 0.4 + share * 0.4),
      rationale: ranked.length
        ? `${ranked.length} similar resolved ticket(s) point at ${chosenTeam}.`
        : `No close matches; defaulting to ${chosenTeam}.`,
      evidence: documents.slice(0, 3).map((d) => d.id),
      clientResponse:
        `Thanks for getting in touch about "${ticket.subject}". ` +
        `I've reviewed the details and passed this to the team that handles this area. ` +
        `They'll follow up here with an update as soon as they have one.`,
      needsHuman: isSecurity || ranked.length === 0,
      missingInformation: ranked.length === 0 ? ["No similar historical tickets matched"] : [],
    };

    return {
      recommendation,
      model: this.name,
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null },
    };
  }

  private severityFor(haystack: string): Severity {
    for (const [severity, signals] of SEVERITY_SIGNALS) {
      if (signals.some((s) => haystack.includes(s))) return severity;
    }
    return "P3";
  }
}
