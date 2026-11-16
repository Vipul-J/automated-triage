import { createHash } from "node:crypto";

export interface DecisionEvent {
  id: number;
  ticket_id: string;
  recommendation_id: string;
  actor: string;
  actor_role: string;
  action: string;
  final_team: string | null;
  final_level: string | null;
  response_after: string | null;
  created_at: Date;
  evidence: string[];
  nonce: string;
}

export function decisionFingerprint(event: DecisionEvent): string {
  const canonical = JSON.stringify([
    "triage-decision-v1",
    event.id,
    event.ticket_id,
    event.recommendation_id,
    event.actor,
    event.actor_role,
    event.action,
    event.final_team,
    event.final_level,
    event.response_after,
    event.created_at.toISOString(),
    [...event.evidence].sort(),
    event.nonce,
  ]);
  return "0x" + createHash("sha256").update(canonical, "utf8").digest("hex");
}
