import type { ImpactUrgency, IncidentState, Priority } from "../../servicenow/incident.js";
import type { Ticket } from "../types.js";

export interface TicketSnapshot extends Ticket {
  /** Opaque version for optimistic concurrency. Changes on every mutation. */
  readonly version: string;
  readonly assignmentGroup: string | null;
  readonly assignedTo: string | null;
  readonly state: IncidentState;
  readonly priority: Priority;
  readonly impact: ImpactUrgency;
  readonly urgency: ImpactUrgency;
  readonly escalated: boolean;
}

export interface AssignmentRequest {
  readonly ticketId: string;
  readonly assignmentGroup: string;
  readonly assignedTo: string | null;
  readonly impact: ImpactUrgency;
  readonly urgency: ImpactUrgency;
  readonly category: string;
  /** Aborts the write if the incident changed since triage read it. */
  readonly expectedVersion: string;
  readonly idempotencyKey: string;
  readonly aiConfidence: number | null;
  readonly aiTier: string | null;
  readonly aiRunId: string | null;
}

export interface JournalRequest {
  readonly ticketId: string;
  readonly value: string;
  /** work_notes are internal; comments are visible to the caller. */
  readonly field: "work_notes" | "comments";
  readonly createdBy: string;
}

/**
 * Anti-corruption layer (design doc section 12). Everything inside the system
 * speaks this interface and the canonical Ticket model, so supporting Zendesk or
 * Jira Service Management means writing one more implementation of this file -
 * nothing else changes.
 */
export interface TicketingAdapter {
  readonly name: string;
  fetch(ticketId: string): Promise<TicketSnapshot | null>;
  assign(request: AssignmentRequest): Promise<TicketSnapshot>;
  journal(request: JournalRequest): Promise<void>;
}
