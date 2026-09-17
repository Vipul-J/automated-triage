import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  derivePriority, nextIncidentNumber, INCIDENT_STATE,
  type ContactType, type ImpactUrgency, type Incident, type IncidentState,
} from "../domain/servicenow.js";

export interface CreateIncidentInput {
  readonly shortDescription: string;
  readonly description: string;
  readonly callerId?: string;
  readonly callerEmail?: string;
  readonly contactType?: ContactType;
  readonly category?: string;
  readonly impact?: ImpactUrgency;
  readonly urgency?: ImpactUrgency;
  /** Drives our internal VIP/strategic policy rules. */
  readonly callerTier?: "standard" | "vip" | "strategic";
}

export interface AssignInput {
  readonly number: string;
  readonly assignmentGroup: string;
  readonly assignedTo: string | null;
  readonly impact: ImpactUrgency;
  readonly urgency: ImpactUrgency;
  readonly category: string;
  readonly expectedVersion: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly aiConfidence: number | null;
  readonly aiTier: string | null;
  readonly aiRunId: string | null;
}

/** Caller tier is not a stock ServiceNow field; most orgs add it via the CMDB. */
export interface StoredIncident extends Incident {
  callerTier: "standard" | "vip" | "strategic";
}

const sysId = (): string => randomBytes(16).toString("hex");

/**
 * In-memory `incident` table.
 *
 * Reproduces the behaviours of a real instance that the triage design depends
 * on: derived priority, journal fields split into work_notes and comments,
 * optimistic concurrency, idempotent writes, and an SLA clock that breaches on
 * its own if nobody acts.
 */
export class IncidentStore {
  private readonly incidents = new Map<string, StoredIncident>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly appliedKeys = new Set<string>();

  constructor(
    private readonly slaWindowMs: number,
    private readonly onBreach: (incident: StoredIncident) => void,
  ) {}

  create(input: CreateIncidentInput): StoredIncident {
    const now = new Date();
    const impact = input.impact ?? 2;
    const urgency = input.urgency ?? 2;

    const incident: StoredIncident = {
      sysId: sysId(),
      number: nextIncidentNumber(),
      shortDescription: input.shortDescription,
      description: input.description,
      callerId: input.callerId ?? "Alex Morgan",
      callerEmail: input.callerEmail ?? "alex.morgan@example.com",
      contactType: input.contactType ?? "self-service",
      category: input.category ?? "inquiry",
      subcategory: null,
      impact,
      urgency,
      priority: derivePriority(impact, urgency),
      state: INCIDENT_STATE.NEW,
      assignmentGroup: null,
      assignedTo: null,
      openedAt: now.toISOString(),
      sysUpdatedOn: now.toISOString(),
      // The SLA clock is anchored to opened_at, never to anyone's receipt time.
      slaDueAt: new Date(now.getTime() + this.slaWindowMs).toISOString(),
      escalated: false,
      escalatedAt: null,
      journal: [
        {
          field: "comments",
          value: input.description,
          createdBy: input.callerId ?? "Alex Morgan",
          createdOn: now.toISOString(),
        },
      ],
      version: randomUUID(),
      aiTriaged: false,
      aiConfidence: null,
      aiTier: null,
      aiRunId: null,
      callerTier: input.callerTier ?? "standard",
    };

    this.incidents.set(incident.number, incident);
    const timer = setTimeout(() => this.breach(incident.number), this.slaWindowMs);
    this.timers.set(incident.number, timer);

    return incident;
  }

  get(number: string): StoredIncident | undefined {
    return this.incidents.get(number);
  }

  list(): StoredIncident[] {
    return [...this.incidents.values()].sort((a, b) => a.number.localeCompare(b.number));
  }

  assign(input: AssignInput): StoredIncident | "not-found" | "conflict" {
    const incident = this.incidents.get(input.number);
    if (!incident) return "not-found";

    if (input.idempotencyKey && this.appliedKeys.has(input.idempotencyKey)) return incident;
    if (input.expectedVersion && input.expectedVersion !== incident.version) return "conflict";
    if (incident.escalated) return "conflict";
    if (incident.assignmentGroup) return "conflict";

    incident.assignmentGroup = input.assignmentGroup;
    incident.assignedTo = input.assignedTo;
    incident.impact = input.impact;
    incident.urgency = input.urgency;
    incident.priority = derivePriority(input.impact, input.urgency);
    incident.category = input.category;
    incident.state = INCIDENT_STATE.IN_PROGRESS;
    incident.aiTriaged = true;
    incident.aiConfidence = input.aiConfidence;
    incident.aiTier = input.aiTier;
    incident.aiRunId = input.aiRunId;
    this.touch(incident);

    if (input.idempotencyKey) this.appliedKeys.add(input.idempotencyKey);
    // Assignment is action: the SLA clock stops.
    this.clearTimer(input.number);

    return incident;
  }

  addJournal(
    number: string,
    field: "work_notes" | "comments",
    value: string,
    createdBy: string,
  ): StoredIncident | undefined {
    const incident = this.incidents.get(number);
    if (!incident) return undefined;

    incident.journal.push({ field, value, createdBy, createdOn: new Date().toISOString() });
    this.touch(incident);
    return incident;
  }

  private breach(number: string): void {
    const incident = this.incidents.get(number);
    if (!incident || incident.state !== INCIDENT_STATE.NEW) return;

    incident.escalated = true;
    incident.escalatedAt = new Date().toISOString();
    // A breached incident is escalated to the on-call major-incident group.
    incident.assignmentGroup = "Escalation-Queue";
    incident.urgency = 1;
    incident.priority = derivePriority(incident.impact, 1);
    incident.journal.push({
      field: "work_notes",
      value: "SLA breached - no action taken within the triage window. Auto-escalated.",
      createdBy: "system",
      createdOn: incident.escalatedAt,
    });
    this.touch(incident);
    this.clearTimer(number);
    this.onBreach(incident);
  }

  private touch(incident: StoredIncident): void {
    incident.sysUpdatedOn = new Date().toISOString();
    incident.version = randomUUID();
  }

  private clearTimer(number: string): void {
    const timer = this.timers.get(number);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(number);
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

export type { IncidentState };
