import { EventEmitter } from "node:events";
import type { Level, Ticket, TriageResult } from "../core/types.js";
import { ticketRepository } from "../platform/db/repositories/ticket.repository.js";
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
  private readonly signals = new Map<string, (decision: HumanDecision | null) => void>();
  private closing = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly writeback: WritebackService,
    private readonly deps: PipelineDeps,
    private readonly onLiveDecision?: (ticket: Ticket, note: string) => Promise<void>,
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
    const record = this.workflows.get(ticketId);
    if (
      !resolve ||
      !record ||
      record.result?.decision.owner !== decision.actorRole ||
      Date.now() >= record.deadlineAt.getTime()
    )
      return false;
    this.cleanup(ticketId);
    resolve(decision);
    return true;
  }

  async start(ticket: Ticket): Promise<void> {
    if (this.closing) return;
    if (this.workflows.has(ticket.id)) {
      log.info({ ticketId: ticket.id }, "workflow already running, ignoring duplicate");
      return;
    }

    const record: WorkflowRecord = {
      ticketId: ticket.id,
      state: "triaging",
      deadlineAt: ticket.deadlineAt,
    };
    this.workflows.set(ticket.id, record);
    this.emit("change");

    try {
      await this.execute(ticket, record);
    } catch (err) {
      log.error({ err, ticketId: ticket.id }, "workflow failed - ticket left to escalate");
      record.state = "failed";
      record.outcome = err instanceof Error ? err.message : String(err);
      await auditRepository
        .record(ticket.id, "workflow.failed", { reason: record.outcome })
        .catch(() => log.error("workflow failure could not be audited"));
      this.emit("change");
    } finally {
      this.cleanup(ticket.id);
      if (!this.closing)
        await ticketRepository
          .updateStatus(ticket.id, record.state)
          .catch(() => log.error({ ticketId: ticket.id }, "could not persist workflow outcome"));
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

    await auditRepository.record(ticket.id, "recommendation.ready", {
      tier: result.decision.tier,
      owner: result.decision.owner,
      team: result.recommendation.recommendedTeam,
      confidence: result.confidence.composite,
      reasons: result.decision.reasons,
      confidenceNote: result.confidence.note,
    });

    // The race: whichever of these resolves first decides the ticket.
    if (this.closing) return;
    const waiting = this.awaitDecisionOrDeadline(ticket, record);
    record.state = "awaiting_review";
    this.emit("change");
    const decision = await waiting;
    if (this.closing && !decision) return;

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

      const waitMs = Math.max(0, record.deadlineAt.getTime() - Date.now());
      const timer = setTimeout(() => {
        log.info({ ticketId: ticket.id }, "review deadline reached with no human response");
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

    const escalation = decision.action === "escalate";
    const finalTeam = escalation
      ? "Escalation-Queue"
      : (decision.team ?? result.recommendation.recommendedTeam);
    const finalLevel = escalation
      ? "L2"
      : (decision.level ?? result.recommendation.recommendedLevel);
    const clientResponse = decision.clientResponse ?? result.recommendation.clientResponse;

    await triageRepository.recordApproval(
      {
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
      },
      result.evidence.map((item) => item.id),
    );

    const actor = `${decision.actor} (${decision.actorRole})`;
    if (this.onLiveDecision) {
      // Live writes are internal handoff notes. Assignment and customer publication
      // are performed in ServiceNow under the engineer's own permissions.
      await this.onLiveDecision(
        result.ticket,
        [
          `Triage decision: ${decision.action} by ${actor}`,
          `Suggested handoff: ${finalTeam} (${finalLevel})`,
          `Run: ${result.runId}`,
          `Evidence: ${result.evidence.map((item) => item.id).join(", ")}`,
        ].join("\n"),
      );
      record.outcome = "Decision saved; internal handoff note added";
      record.state = "applied";
      this.emit("change");
      return;
    }

    const outcome = await this.writeback.apply({
      result,
      recommendationId: record.recommendationId!,
      finalTeam,
      finalLevel,
      actor: `${decision.actor} (${decision.actorRole})`,
      autoApplied: false,
    });

    record.state = outcome.status === "applied" ? "applied" : "abandoned";
    record.outcome = `${decision.action} by ${decision.actor} -> ${outcome.status}`;
    this.emit("change");
  }

  private async applyTimeoutPolicy(record: WorkflowRecord, result: TriageResult): Promise<void> {
    record.state = "abandoned";
    record.outcome = "Review window expired; ticketing platform owns escalation";
    await auditRepository.record(result.ticket.id, "timeout.left_to_escalate", {
      tier: result.decision.tier,
    });
    this.emit("change");
  }

  private cleanup(ticketId: string): void {
    const timer = this.timers.get(ticketId);
    if (timer) clearTimeout(timer);
    this.timers.delete(ticketId);
    this.signals.delete(ticketId);
  }

  stopAll(): void {
    this.closing = true;
    for (const resolve of this.signals.values()) resolve(null);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.signals.clear();
  }
}
