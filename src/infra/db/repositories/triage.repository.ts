import { randomUUID } from "node:crypto";
import { pool } from "../pool.js";
import type {
  ConfidenceBreakdown, Decision, GuardrailResult, Level,
  Recommendation, RetrievedDoc, StageTimings,
} from "../../../domain/types.js";

export interface PersistedRecommendation {
  readonly id: string;
  readonly runId: string;
  readonly ticketId: string;
}

export interface RunMetrics {
  readonly model: string | null;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly timings: StageTimings;
  readonly degraded: readonly string[];
  readonly outcome: string;
}

export interface ApprovalRecord {
  readonly ticketId: string;
  readonly recommendationId: string;
  readonly actor: string;
  readonly actorRole: string;
  readonly action: "approve" | "approve_with_edit" | "reroute" | "escalate" | "auto_commit";
  readonly finalTeam: string | null;
  readonly finalLevel: Level | null;
  readonly responseBefore: string | null;
  readonly responseAfter: string | null;
  readonly timeToDecisionMs: number | null;
}

export class TriageRepository {
  async startRun(ticketId: string): Promise<string> {
    const runId = randomUUID();
    await pool.query(`INSERT INTO triage_runs (id, ticket_id) VALUES ($1, $2)`, [runId, ticketId]);
    return runId;
  }

  async finishRun(runId: string, metrics: RunMetrics): Promise<void> {
    await pool.query(
      `UPDATE triage_runs
          SET finished_at = now(), stage_timings = $2, model = $3, prompt_version = $4,
              input_tokens = $5, output_tokens = $6, cache_read_tokens = $7,
              degraded = $8, outcome = $9
        WHERE id = $1`,
      [
        runId, JSON.stringify(metrics.timings), metrics.model, metrics.promptVersion,
        metrics.inputTokens, metrics.outputTokens, metrics.cacheReadTokens,
        [...metrics.degraded], metrics.outcome,
      ],
    );
  }

  async saveRecommendation(args: {
    runId: string;
    ticketId: string;
    recommendation: Recommendation;
    confidence: ConfidenceBreakdown;
    decision: Decision;
    guardrails: readonly GuardrailResult[];
    evidence: readonly RetrievedDoc[];
  }): Promise<PersistedRecommendation> {
    const id = randomUUID();
    const { recommendation: rec } = args;
    await pool.query(
      `INSERT INTO recommendations
         (id, run_id, ticket_id, summary, category, affected_service, severity,
          recommended_team, recommended_level, alternatives, model_confidence,
          composite_confidence, confidence_parts, rationale, evidence, client_response,
          needs_human, missing_information, guardrails, tier, owner_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        id, args.runId, args.ticketId, rec.summary, rec.category, rec.affectedService,
        rec.severity, rec.recommendedTeam, rec.recommendedLevel,
        JSON.stringify(rec.alternatives), rec.confidence, args.confidence.composite,
        JSON.stringify(args.confidence), rec.rationale,
        JSON.stringify(args.evidence.map((e) => ({ id: e.id, title: e.title, kind: e.kind }))),
        rec.clientResponse, rec.needsHuman, [...rec.missingInformation],
        JSON.stringify(args.guardrails), args.decision.tier, args.decision.owner,
      ],
    );
    return { id, runId: args.runId, ticketId: args.ticketId };
  }

  async recordApproval(record: ApprovalRecord): Promise<void> {
    await pool.query(
      `INSERT INTO approvals
         (ticket_id, recommendation_id, actor, actor_role, action, final_team, final_level,
          response_edited, response_before, response_after, time_to_decision_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.ticketId, record.recommendationId, record.actor, record.actorRole,
        record.action, record.finalTeam, record.finalLevel,
        record.responseBefore !== record.responseAfter,
        record.responseBefore, record.responseAfter, record.timeToDecisionMs,
      ],
    );
  }

  /** Idempotent: a duplicate key means this action already landed. */
  async recordAction(args: {
    ticketId: string;
    idempotencyKey: string;
    team: string | null;
    level: Level | null;
    autoApplied: boolean;
    result: "applied" | "skipped" | "failed";
    detail?: string;
  }): Promise<boolean> {
    const { rowCount } = await pool.query(
      `INSERT INTO actions
         (ticket_id, idempotency_key, applied_team, applied_level, auto_applied, result, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [args.ticketId, args.idempotencyKey, args.team, args.level,
       args.autoApplied, args.result, args.detail ?? null],
    );
    return rowCount === 1;
  }
}

export const triageRepository = new TriageRepository();
