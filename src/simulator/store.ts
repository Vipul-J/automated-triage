import { createHmac, randomUUID } from "node:crypto";
import type { CustomerTier } from "../domain/types.js";

export interface SimComment {
  readonly body: string;
  readonly visibility: "public" | "internal";
  readonly at: string;
}

export interface SimTicket {
  id: string;
  subject: string;
  body: string;
  requester: string;
  customerTier: CustomerTier;
  createdAt: string;
  deadlineAt: string;
  status: "new" | "assigned" | "escalated";
  version: string;
  assignedTeam: string | null;
  assignedLevel: string | null;
  priority: string | null;
  comments: SimComment[];
  escalatedAt: string | null;
}

export interface CreateTicketInput {
  readonly subject: string;
  readonly body: string;
  readonly requester?: string;
  readonly customerTier?: CustomerTier;
}

/**
 * In-memory ticket store for the simulator.
 *
 * Mirrors the properties of a real platform that actually matter to the design:
 * an opaque version for optimistic concurrency, idempotency keys on writes, and
 * an escalation clock that fires on its own if nobody acts.
 */
export class SimulatorStore {
  private readonly tickets = new Map<string, SimTicket>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly appliedKeys = new Set<string>();
  private sequence = 0;

  constructor(
    private readonly escalationWindowMs: number,
    private readonly onEscalate: (ticket: SimTicket) => void,
  ) {}

  create(input: CreateTicketInput): SimTicket {
    const now = new Date();
    const id = `TKT-${String(++this.sequence).padStart(4, "0")}`;
    const ticket: SimTicket = {
      id,
      subject: input.subject,
      body: input.body,
      requester: input.requester ?? "customer@example.com",
      customerTier: input.customerTier ?? "standard",
      createdAt: now.toISOString(),
      // The clock is anchored to creation time, never to anyone's receipt time.
      deadlineAt: new Date(now.getTime() + this.escalationWindowMs).toISOString(),
      status: "new",
      version: randomUUID(),
      assignedTeam: null,
      assignedLevel: null,
      priority: null,
      comments: [],
      escalatedAt: null,
    };
    this.tickets.set(id, ticket);

    const timer = setTimeout(() => this.escalate(id), this.escalationWindowMs);
    timer.unref();
    this.timers.set(id, timer);

    return ticket;
  }

  get(id: string): SimTicket | undefined {
    return this.tickets.get(id);
  }

  list(): SimTicket[] {
    return [...this.tickets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Returns 'conflict' when the caller's view of the ticket is stale. */
  assign(args: {
    id: string;
    team: string;
    level: string;
    priority: string;
    expectedVersion: string | undefined;
    idempotencyKey: string | undefined;
  }): SimTicket | "not-found" | "conflict" {
    const ticket = this.tickets.get(args.id);
    if (!ticket) return "not-found";

    if (args.idempotencyKey && this.appliedKeys.has(args.idempotencyKey)) return ticket;
    if (args.expectedVersion && args.expectedVersion !== ticket.version) return "conflict";
    if (ticket.status === "escalated") return "conflict";

    ticket.assignedTeam = args.team;
    ticket.assignedLevel = args.level;
    ticket.priority = args.priority;
    ticket.status = "assigned";
    ticket.version = randomUUID();

    if (args.idempotencyKey) this.appliedKeys.add(args.idempotencyKey);
    this.clearTimer(args.id);
    return ticket;
  }

  comment(id: string, body: string, visibility: "public" | "internal"): SimTicket | undefined {
    const ticket = this.tickets.get(id);
    if (!ticket) return undefined;
    ticket.comments.push({ body, visibility, at: new Date().toISOString() });
    ticket.version = randomUUID();
    return ticket;
  }

  private escalate(id: string): void {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.status !== "new") return;
    ticket.status = "escalated";
    ticket.escalatedAt = new Date().toISOString();
    ticket.version = randomUUID();
    this.clearTimer(id);
    this.onEscalate(ticket);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/** Webhook signature, as every real platform does it. */
export function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
