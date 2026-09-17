import { EventEmitter } from "node:events";
import { config } from "../config/index.js";
import type { Level, Ticket, TriageResult } from "../core/types.js";
import { auditRepository } from "../platform/db/repositories/audit.repository.js";
import { triageRepository } from "../platform/db/repositories/triage.repository.js";
import { loggerFor } from "../platform/logging/logger.js";
import { runTriage, type PipelineDeps } from "../triage/run-triage.js";
import type { WritebackService } from "./writeback.js";

const log = loggerFor("workflow");

export interface HumanDecision {
  readonly action: "approve" | "approve_with_edit" | "reroute" | "escalate";
  readonly actor: string;
  readonly actorRole: "L1" | "L2";
  readonly team?: string;
  readonly level?: Level;
  readonly clientResponse?: string;
}

export type WorkflowState =
  "triaging" | "awaiting_review" | "applied" | "auto_applied" | "abandoned" | "failed";

export interface WorkflowRecord {
  readonly ticketId: string;
  state: WorkflowState;
  result?: TriageResult;
  recommendationId?: string;
  readonly deadlineAt: Date;
  readonly autoCommitAt: Date;
  presentedAt?: number;
  outcome?: string;
}

/**
 * One workflow execution per ticket.
 *
 * The core of the problem is a race between a human signal and a timer, so that
 * is exactly what this models. In production this is a Temporal workflow - the
 * timer becomes a durable timer and the approval becomes a signal, so a process
 * restart at T+45s does not lose the ticket (design doc 5.3). The shape here is
 * deliberately identical so the swap is mechanical.
 */
export class TriageOrchestrator extends EventEmitter {
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly signals = new Map<string, (decision: HumanDecision) => void>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly writeback: WritebackService,
    private readonly deps: PipelineDeps,
  ) {
    super();
  }

  list(): WorkflowRecord[] {
    return [...this.workflows.values()].sort(
      (a, b) => b.deadlineAt.getTime() - a.deadlineAt.getTime(),
    );
  }

  get(ticketId: string): WorkflowRecord | undefined {
    return this.workflows.get(ticketId);
  }

  /** Delivers a reviewer's decision into a waiting workflow. */
  submitDecision(ticketId: string, decision: HumanDecision): boolean {
    const resolve = this.signals.get(ticketId);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  async start(ticket: Ticket): Promise<void> {
    if (this.workflows.has(ticket.id)) {
      log.info({ ticketId: ticket.id }, "workflow already running, ignoring duplicate");
      return;
    }

    const autoCommitAt = new Date(
      ticket.deadlineAt.getTime() - config.deadlines.autoCommitMarginMs,
    );
    const record: WorkflowRecord = {
      ticketId: ticket.id,
      state: "triaging",
      deadlineAt: ticket.deadlineAt,
      autoCommitAt,
    };
    this.workflows.set(ticket.id, record);
    this.emit("change");

    try {
      await this.execute(ticket, record);
    } catch (err) {
      log.error({ err, ticketId: ticket.id }, "workflow failed - ticket left to escalate");
      record.state = "failed";
      record.outcome = err instanceof Error ? err.message : String(err);
      await auditRepository.record(ticket.id, "workflow.failed", { reason: record.outcome });
      this.emit("change");
    } finally {
      this.cleanup(ticket.id);
    }
  }

  private async execute(ticket: Ticket, record: WorkflowRecord): Promise<void> {
    const result = await runTriage(ticket, this.deps);
    record.result = result;

    const persisted = await triageRepository.saveRecommendation({
      runId: result.runId,
      ticketId: ticket.id,
      recommendation: result.recommendation,
      confidence: result.confidence,
      decision: result.decision,
      guardrails: result.guardrails,
      evidence: result.evidence,
    });
    record.recommendationId = persisted.id;
    record.presentedAt = Date.now();
    record.state = "awaiting_review";
    this.emit("change");

    await auditRepository.record(ticket.id, "recommendation.ready", {
      tier: result.decision.tier,
      owner: result.decision.owner,
      team: result.recommendation.recommendedTeam,
      confidence: result.confidence.composite,
      reasons: result.decision.reasons,
      confidenceNote: result.confidence.note,
    });

    // The race: whichever of these resolves first decides the ticket.
    const decision = await this.awaitDecisionOrDeadline(ticket, record);

    if (decision) {
      await this.applyHumanDecision(record, result, decision);
    } else {
      await this.applyTimeoutPolicy(record, result);
    }
  }

  private awaitDecisionOrDeadline(
    ticket: Ticket,
    record: WorkflowRecord,
  ): Promise<HumanDecision | null> {
    return new Promise<HumanDecision | null>((resolve) => {
      let settled = false;
      const settle = (value: HumanDecision | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      this.signals.set(ticket.id, settle);

      const waitMs = Math.max(0, record.autoCommitAt.getTime() - Date.now());
      const timer = setTimeout(() => {
        log.info({ ticketId: ticket.id }, "auto-commit deadline reached with no human response");
        settle(null);
      }, waitMs);
      // Deliberately NOT unref'd: a ticket awaiting a decision is real in-flight
      // work, and dropping it on shutdown would lose the ticket silently.
      this.timers.set(ticket.id, timer);
    });
  }

  private async applyHumanDecision(
    record: WorkflowRecord,
    result: TriageResult,
    decision: HumanDecision,
  ): Promise<void> {
    const timeToDecisionMs = record.presentedAt ? Date.now() - record.presentedAt : null;

    if (decision.action === "escalate") {
      record.state = "abandoned";
      record.outcome = `escalated by ${decision.actor}`;
      await auditRepository.record(result.ticket.id, "review.escalated", { actor: decision.actor });
      this.emit("change");
      return;
    }

    const finalTeam = decision.team ?? result.recommendation.recommendedTeam;
    const finalLevel = decision.level ?? result.recommendation.recommendedLevel;
    const clientResponse = decision.clientResponse ?? result.recommendation.clientResponse;

    await triageRepository.recordApproval({
      ticketId: result.ticket.id,
      recommendationId: record.recommendationId!,
      actor: decision.actor,
      actorRole: decision.actorRole,
      action: decision.action,
      finalTeam,
      finalLevel,
      responseBefore: result.recommendation.clientResponse,
      responseAfter: clientResponse,
      timeToDecisionMs,
    });

    const outcome = await this.writeback.apply({
      result,
      recommendationId: record.recommendationId!,
      finalTeam,
      finalLevel,
      clientResponse,
      actor: `${decision.actor} (${decision.actorRole})`,
      autoApplied: false,
      ackOnly: false,
    });

    record.state = outcome.status === "applied" ? "applied" : "abandoned";
    record.outcome = `${decision.action} by ${decision.actor} -> ${outcome.status}`;
    this.emit("change");
  }

  /** What happens when nobody clicks: driven entirely by the policy tier (doc 10). */
  private async applyTimeoutPolicy(record: WorkflowRecord, result: TriageResult): Promise<void> {
    const { decision, recommendation } = result;

    // A setTimeout is not a guarantee. Under a GC pause, a suspended process, a
    // VM migration or clock skew it can fire arbitrarily late, and acting on a
    // stale timer means writing back after the ticket has already escalated.
    // The wall clock is the authority, not the timer.
    const overdueMs = Date.now() - record.deadlineAt.getTime();
    if (overdueMs > 0) {
      record.state = "abandoned";
      record.outcome = `deadline missed by ${Math.round(overdueMs / 1000)}s - no action taken`;
      log.error(
        { ticketId: result.ticket.id, overdueMs, tier: decision.tier },
        "SLO breach: auto-commit timer fired after the escalation deadline",
      );
      await auditRepository.record(result.ticket.id, "timeout.deadline_missed", {
        overdueMs,
        tier: decision.tier,
      });
      this.emit("change");
      return;
    }

    if (decision.tier === "MANUAL") {
      record.state = "abandoned";
      record.outcome = "MANUAL tier - left to escalate, which is the correct outcome";
      await auditRepository.record(result.ticket.id, "timeout.left_to_escalate", {
        tier: decision.tier,
        reasons: decision.reasons,
      });
      this.emit("change");
      return;
    }

    await triageRepository.recordApproval({
      ticketId: result.ticket.id,
      recommendationId: record.recommendationId!,
      actor: "system",
      actorRole: "L1",
      action: "auto_commit",
      finalTeam: decision.ackOnly ? null : recommendation.recommendedTeam,
      finalLevel: decision.ackOnly ? null : recommendation.recommendedLevel,
      responseBefore: recommendation.clientResponse,
      responseAfter: recommendation.clientResponse,
      timeToDecisionMs: null,
    });

    const outcome = await this.writeback.apply({
      result,
      recommendationId: record.recommendationId!,
      finalTeam: recommendation.recommendedTeam,
      finalLevel: recommendation.recommendedLevel,
      clientResponse: recommendation.clientResponse,
      actor: "system (unreviewed)",
      autoApplied: true,
      // ASSIST: stop the clock with a true acknowledgement, claim no route.
      ackOnly: decision.ackOnly,
    });

    record.state = outcome.status === "applied" ? "auto_applied" : "abandoned";
    record.outcome = decision.ackOnly
      ? `ASSIST - acknowledgement only, queued for L1 (${outcome.status})`
      : `${decision.tier} auto-applied unreviewed -> ${outcome.status}`;
    this.emit("change");
  }

  private cleanup(ticketId: string): void {
    const timer = this.timers.get(ticketId);
    if (timer) clearTimeout(timer);
    this.timers.delete(ticketId);
    this.signals.delete(ticketId);
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.signals.clear();
  }
}
