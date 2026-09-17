import { ConcurrentModificationError, TicketingAdapterError } from "../domain/errors.js";
import type { Level, Recommendation, TriageResult } from "../domain/types.js";
import { auditRepository } from "../infra/db/repositories/audit.repository.js";
import { triageRepository } from "../infra/db/repositories/triage.repository.js";
import { loggerFor } from "../infra/logging/logger.js";
import type { TicketingAdapter } from "../adapters/ticketing/types.js";

const log = loggerFor("writeback");

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

export interface ApplyRequest {
  readonly result: TriageResult;
  readonly recommendationId: string;
  readonly finalTeam: string;
  readonly finalLevel: Level;
  readonly clientResponse: string;
  readonly actor: string;
  readonly autoApplied: boolean;
  /** ASSIST: post the acknowledgement but make no routing claim. */
  readonly ackOnly: boolean;
}

export type ApplyOutcome =
  | { status: "applied"; team: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * The only component permitted to mutate the ticketing system.
 *
 * Idempotent, version-checked, and allow-list validated. On terminal failure it
 * gives up and lets the ticket escalate normally - the fail-safe from design doc
 * principle 1: the worst outcome of any failure is today's behaviour.
 */
export class WritebackService {
  constructor(private readonly adapter: TicketingAdapter) {}

  async apply(request: ApplyRequest): Promise<ApplyOutcome> {
    const { result, finalTeam, finalLevel, ackOnly } = request;
    const ticketId = result.ticket.id;
    const idempotencyKey = `${result.runId}:${ackOnly ? "ack" : finalTeam}`;

    const first = await triageRepository.recordAction({
      ticketId, idempotencyKey,
      team: ackOnly ? null : finalTeam,
      level: ackOnly ? null : finalLevel,
      autoApplied: request.autoApplied,
      result: "applied",
    });
    if (!first) {
      log.info({ ticketId, idempotencyKey }, "action already applied, skipping");
      return { status: "skipped", reason: "already-applied" };
    }

    try {
      return await this.attemptWithRetries(request, idempotencyKey);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error({ err, ticketId }, "write-back failed - ticket left to escalate normally");
      await auditRepository.record(ticketId, "writeback.failed", { reason });
      return { status: "failed", reason };
    }
  }

  private async attemptWithRetries(
    request: ApplyRequest,
    idempotencyKey: string,
  ): Promise<ApplyOutcome> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(request, idempotencyKey);
      } catch (err) {
        lastError = err;

        // A human took the ticket, or it already escalated. Never clobber that.
        if (err instanceof ConcurrentModificationError) {
          log.info({ ticketId: request.result.ticket.id }, "abandoned - ticket changed externally");
          await auditRepository.record(request.result.ticket.id, "writeback.abandoned", {
            reason: "concurrent-modification",
          });
          return { status: "skipped", reason: "human-took-over" };
        }

        const retryable = err instanceof TicketingAdapterError && err.retryable;
        if (!retryable || attempt === MAX_ATTEMPTS) break;

        const jitter = Math.random() * BASE_BACKOFF_MS;
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1) + jitter));
      }
    }
    throw lastError;
  }

  private async attempt(request: ApplyRequest, idempotencyKey: string): Promise<ApplyOutcome> {
    const { result, ackOnly } = request;
    const ticketId = result.ticket.id;

    // Re-read immediately before writing: optimistic concurrency needs a fresh
    // version, and this is where "someone already handled it" is detected.
    const snapshot = await this.adapter.fetch(ticketId);
    if (!snapshot) return { status: "skipped", reason: "ticket-not-found" };
    if (snapshot.status === "escalated") {
      return { status: "skipped", reason: "already-escalated" };
    }
    if (snapshot.assignedTeam) {
      return { status: "skipped", reason: "already-assigned" };
    }

    // ASSIST: acknowledge the customer, make no routing claim, stop the clock.
    if (ackOnly) {
      await this.adapter.comment({
        ticketId, visibility: "public", body: request.clientResponse,
      });
      log.info({ ticketId }, "acknowledgement posted without a routing claim (ASSIST)");
      await auditRepository.record(ticketId, "writeback.ack_only", { actor: request.actor });
      return { status: "applied", team: null };
    }

    // The assignment goes FIRST, while the version we just read is still current.
    //
    // Every mutation bumps the ticket version, comments included, so posting the
    // customer reply before assigning would invalidate `snapshot.version` and the
    // assign would fail its own concurrency check - indistinguishable from a real
    // human takeover. Guard the operation that actually needs guarding, then
    // comment.
    await this.adapter.assign({
      ticketId,
      team: request.finalTeam,
      level: request.finalLevel,
      priority: result.recommendation.severity,
      expectedVersion: snapshot.version,
      idempotencyKey,
    });

    await this.adapter.comment({
      ticketId, visibility: "public", body: request.clientResponse,
    });

    // The receiving team gets the reasoning for free, and audit gets its trail.
    await this.adapter.comment({
      ticketId, visibility: "internal",
      body: buildInternalNote(request),
    });

    log.info(
      { ticketId, team: request.finalTeam, autoApplied: request.autoApplied },
      "assignment applied",
    );
    await auditRepository.record(ticketId, "writeback.applied", {
      team: request.finalTeam, actor: request.actor, autoApplied: request.autoApplied,
    });

    return { status: "applied", team: request.finalTeam };
  }
}

function buildInternalNote(request: ApplyRequest): string {
  const { result } = request;
  const rec: Recommendation = result.recommendation;
  const evidence = result.evidence.slice(0, 3).map((e) => `  - ${e.id}: ${e.title}`).join("\n");

  return [
    `AI triage - ${request.autoApplied ? "auto-applied" : `approved by ${request.actor}`}`,
    ``,
    `Routed to: ${request.finalTeam} (${request.finalLevel})   Severity: ${rec.severity}`,
    `Tier: ${result.decision.tier}   Confidence: ${result.confidence.composite.toFixed(2)}`,
    `Reasoning: ${rec.rationale}`,
    `Confidence basis: ${result.confidence.note}`,
    ``,
    `Evidence:`,
    evidence || "  (none)",
    ``,
    `Model: ${result.usedMockLlm ? "deterministic stub" : "claude"}   Run: ${result.runId}`,
    result.degraded.length > 0 ? `Degraded: ${result.degraded.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}
