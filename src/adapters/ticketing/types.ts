import type { Level, Ticket } from "../../domain/types.js";

export interface TicketSnapshot extends Ticket {
  /** Opaque version for optimistic concurrency. Changes on every mutation. */
  readonly version: string;
  readonly assignedTeam: string | null;
}

export interface AssignmentRequest {
  readonly ticketId: string;
  readonly team: string;
  readonly level: Level;
  readonly priority: string;
  /** Aborts the write if the ticket changed since triage read it. */
  readonly expectedVersion: string;
  readonly idempotencyKey: string;
}

export interface CommentRequest {
  readonly ticketId: string;
  readonly body: string;
  readonly visibility: "public" | "internal";
}

/**
 * Anti-corruption layer (design doc section 12). Everything inside the system
 * speaks this interface and the canonical Ticket model, so supporting Zendesk,
 * ServiceNow or Jira Service Management means writing one more implementation
 * of this file - nothing else changes.
 */
export interface TicketingAdapter {
  readonly name: string;
  fetch(ticketId: string): Promise<TicketSnapshot | null>;
  assign(request: AssignmentRequest): Promise<TicketSnapshot>;
  comment(request: CommentRequest): Promise<void>;
}
