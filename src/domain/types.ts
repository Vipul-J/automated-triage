export const LEVELS = ["L1", "L2", "L3"] as const;
export type Level = (typeof LEVELS)[number];

export const SEVERITIES = ["P1", "P2", "P3", "P4"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CUSTOMER_TIERS = ["standard", "vip", "strategic"] as const;
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];

/** Design doc section 10 - the tier decides both T+150s behaviour and the owner. */
export const TIERS = ["AUTO", "REVIEW", "ASSIST", "MANUAL"] as const;
export type Tier = (typeof TIERS)[number];

export type OwnerRole = "L1" | "L2" | "none";
export type KnowledgeKind = "ticket" | "runbook" | "template";

export interface CatalogEntry {
  readonly service: string;
  readonly team: string;
  readonly level: Level;
  readonly charter: string;
  readonly keywords: readonly string[];
  readonly active: boolean;
}

export interface Ticket {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly requester: string;
  readonly customerTier: CustomerTier;
  readonly createdAt: Date;
  /** Absolute escalation deadline, derived from createdAt - never from receipt time. */
  readonly deadlineAt: Date;
  readonly status: string;
}

export interface KnowledgeDoc {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly content: string;
  /** For kind='ticket': the FINAL RESOLVING team, not the first assignment. */
  readonly resolvedTeam: string | null;
  readonly resolvedLevel: Level | null;
  readonly service: string | null;
}

export interface RetrievedDoc extends KnowledgeDoc {
  readonly score: number;
  readonly via: readonly ("lexical" | "vector")[];
}

export interface EnrichmentContext {
  readonly customerTier: CustomerTier;
  readonly openIncident: { service: string; summary: string } | null;
  readonly recentTicketCount: number;
  readonly errorSignatures: readonly string[];
  /** Sources that timed out or failed. Each one costs confidence. */
  readonly missing: readonly string[];
}

/** The model's structured proposal. It never acts; a separate service does. */
export interface Recommendation {
  readonly summary: string;
  readonly category: string;
  readonly affectedService: string | null;
  readonly severity: Severity;
  readonly recommendedTeam: string;
  readonly recommendedLevel: Level;
  readonly alternatives: readonly { team: string; why: string }[];
  readonly confidence: number;
  readonly rationale: string;
  readonly evidence: readonly string[];
  readonly clientResponse: string;
  readonly needsHuman: boolean;
  readonly missingInformation: readonly string[];
}

export interface GuardrailResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface ConfidenceBreakdown {
  readonly model: number;
  readonly neighbourAgreement: number;
  readonly catalogMatch: number;
  readonly contextCompleteness: number;
  readonly guardrails: number;
  readonly composite: number;
  /** Reviewer-facing: "4 of 5 similar tickets went to X". A bare 0.78 means nothing. */
  readonly note: string;
}

export interface Decision {
  readonly tier: Tier;
  readonly owner: OwnerRole;
  readonly reasons: readonly string[];
  readonly autoApplyAtDeadline: boolean;
  /** ASSIST: acknowledge the customer without claiming a route. */
  readonly ackOnly: boolean;
}

export interface StageTimings {
  readonly [stage: string]: number;
}

export interface TriageResult {
  readonly runId: string;
  readonly ticket: Ticket;
  readonly recommendation: Recommendation;
  readonly confidence: ConfidenceBreakdown;
  readonly decision: Decision;
  readonly evidence: readonly RetrievedDoc[];
  readonly guardrails: readonly GuardrailResult[];
  readonly timings: StageTimings;
  readonly degraded: readonly string[];
  readonly usedMockLlm: boolean;
}
