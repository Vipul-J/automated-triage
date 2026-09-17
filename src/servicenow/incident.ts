/**
 * ServiceNow incident field model.
 *
 * Mirrors the fields that actually matter for triage on the `incident` table, so
 * the console looks like what an engineer already uses and the write-back path
 * exercises the real shape. When the real adapter is written, these map
 * one-to-one onto ServiceNow's REST API field names.
 */

/** ServiceNow incident_state values. */
export const INCIDENT_STATE = {
  NEW: 1,
  IN_PROGRESS: 2,
  ON_HOLD: 3,
  RESOLVED: 6,
  CLOSED: 7,
  CANCELED: 8,
} as const;

export type IncidentState = (typeof INCIDENT_STATE)[keyof typeof INCIDENT_STATE];

export const STATE_LABEL: Record<IncidentState, string> = {
  [INCIDENT_STATE.NEW]: "New",
  [INCIDENT_STATE.IN_PROGRESS]: "In Progress",
  [INCIDENT_STATE.ON_HOLD]: "On Hold",
  [INCIDENT_STATE.RESOLVED]: "Resolved",
  [INCIDENT_STATE.CLOSED]: "Closed",
  [INCIDENT_STATE.CANCELED]: "Canceled",
};

/** 1-High, 2-Medium, 3-Low - ServiceNow's standard scale. */
export type ImpactUrgency = 1 | 2 | 3;
export type Priority = 1 | 2 | 3 | 4 | 5;

export const IMPACT_URGENCY_LABEL: Record<ImpactUrgency, string> = {
  1: "1 - High",
  2: "2 - Medium",
  3: "3 - Low",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  1: "1 - Critical",
  2: "2 - High",
  3: "3 - Moderate",
  4: "4 - Low",
  5: "5 - Planning",
};

/**
 * ServiceNow's default priority lookup. Priority is DERIVED from impact and
 * urgency - it is not set directly, which is why the model proposes impact and
 * urgency and the priority falls out of this matrix.
 *
 *              urgency 1    urgency 2    urgency 3
 *   impact 1   Critical     High         Moderate
 *   impact 2   High         Moderate     Low
 *   impact 3   Moderate     Low          Planning
 */
const PRIORITY_MATRIX: Record<ImpactUrgency, Record<ImpactUrgency, Priority>> = {
  1: { 1: 1, 2: 2, 3: 3 },
  2: { 1: 2, 2: 3, 3: 4 },
  3: { 1: 3, 2: 4, 3: 5 },
};

export function derivePriority(impact: ImpactUrgency, urgency: ImpactUrgency): Priority {
  return PRIORITY_MATRIX[impact][urgency];
}

/** Our internal severity maps onto the ServiceNow impact/urgency pair. */
export function severityToImpactUrgency(severity: "P1" | "P2" | "P3" | "P4"): {
  impact: ImpactUrgency;
  urgency: ImpactUrgency;
} {
  // Chosen so the matrix yields the intended priority, not by picking
  // plausible-looking impact/urgency values:
  //   P1 -> 1/1 = 1 Critical    P2 -> 2/1 = 2 High
  //   P3 -> 2/2 = 3 Moderate    P4 -> 3/3 = 5 Planning
  // An earlier P3 -> 2/3 mapping produced 4-Low, which understated every
  // single-user fault with a workaround.
  switch (severity) {
    case "P1":
      return { impact: 1, urgency: 1 };
    case "P2":
      return { impact: 2, urgency: 1 };
    case "P3":
      return { impact: 2, urgency: 2 };
    case "P4":
      return { impact: 3, urgency: 3 };
  }
}

export type ContactType = "email" | "phone" | "self-service" | "chat";

export interface JournalEntry {
  /** work_notes are internal; comments are visible to the caller. */
  readonly field: "work_notes" | "comments";
  readonly value: string;
  readonly createdBy: string;
  readonly createdOn: string;
}

export interface Incident {
  readonly sysId: string;
  /** INC0010001 */
  readonly number: string;
  shortDescription: string;
  description: string;
  callerId: string;
  callerEmail: string;
  contactType: ContactType;
  category: string;
  subcategory: string | null;
  impact: ImpactUrgency;
  urgency: ImpactUrgency;
  priority: Priority;
  state: IncidentState;
  assignmentGroup: string | null;
  assignedTo: string | null;
  readonly openedAt: string;
  sysUpdatedOn: string;
  /** SLA breach point - our 3-minute triage window. */
  readonly slaDueAt: string;
  escalated: boolean;
  escalatedAt: string | null;
  journal: JournalEntry[];
  /** Opaque version for optimistic concurrency. */
  version: string;
  /** Marks tickets whose assignment came from AI triage, for reporting. */
  aiTriaged: boolean;
  aiConfidence: number | null;
  aiTier: string | null;
  aiRunId: string | null;
}

let sequence = 0;

export const nextIncidentNumber = (): string =>
  `INC${String(++sequence + 10_000).padStart(7, "0")}`;

export const resetIncidentSequence = (): void => {
  sequence = 0;
};
