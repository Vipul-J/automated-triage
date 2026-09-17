import { config } from "../config/index.js";
import { ConcurrentModificationError, TicketingAdapterError } from "../core/errors.js";
import {
  INCIDENT_STATE,
  type ImpactUrgency,
  type IncidentState,
  type Priority,
} from "./incident.js";
import type { CustomerTier } from "../core/types.js";
import type {
  AssignmentRequest,
  JournalRequest,
  TicketingAdapter,
  TicketSnapshot,
} from "../core/ports/ticketing.js";

interface IncidentPayload {
  sysId: string;
  number: string;
  shortDescription: string;
  description: string;
  callerId: string;
  callerEmail: string;
  callerTier: CustomerTier;
  contactType: string;
  category: string;
  impact: ImpactUrgency;
  urgency: ImpactUrgency;
  priority: Priority;
  state: IncidentState;
  assignmentGroup: string | null;
  assignedTo: string | null;
  openedAt: string;
  slaDueAt: string;
  escalated: boolean;
  version: string;
}

const REQUEST_TIMEOUT_MS = 4_000;

const toSnapshot = (p: IncidentPayload): TicketSnapshot => ({
  id: p.number,
  sysId: p.sysId,
  subject: p.shortDescription,
  body: p.description,
  requester: p.callerId,
  requesterEmail: p.callerEmail,
  customerTier: p.callerTier,
  category: p.category,
  contactType: p.contactType,
  createdAt: new Date(p.openedAt),
  deadlineAt: new Date(p.slaDueAt),
  status: p.escalated ? "escalated" : p.state === INCIDENT_STATE.NEW ? "new" : "in_progress",
  version: p.version,
  assignmentGroup: p.assignmentGroup,
  assignedTo: p.assignedTo,
  state: p.state,
  priority: p.priority,
  impact: p.impact,
  urgency: p.urgency,
  escalated: p.escalated,
});

/** Speaks the ServiceNow Table API shape against the local simulator. */
export class ServiceNowAdapter implements TicketingAdapter {
  readonly name = "servicenow";

  constructor(private readonly baseUrl: string = config.http.simBaseUrl) {}

  async fetch(ticketId: string): Promise<TicketSnapshot | null> {
    const response = await this.request(`/api/now/table/incident/${ticketId}`, { method: "GET" });
    if (response.status === 404) return null;
    const { result } = (await response.json()) as { result: IncidentPayload };
    return toSnapshot(result);
  }

  async assign(request: AssignmentRequest): Promise<TicketSnapshot> {
    const response = await this.request(`/api/now/table/incident/${request.ticketId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": request.expectedVersion,
        "idempotency-key": request.idempotencyKey,
      },
      body: JSON.stringify({
        assignment_group: request.assignmentGroup,
        assigned_to: request.assignedTo,
        impact: request.impact,
        urgency: request.urgency,
        category: request.category,
        // Custom fields, so the AI's involvement is visible and reportable
        // inside ServiceNow itself (design doc section 12).
        u_ai_confidence: request.aiConfidence,
        u_ai_tier: request.aiTier,
        u_ai_run_id: request.aiRunId,
      }),
    });

    // The incident moved under us: a human took it, or the SLA already breached.
    if (response.status === 409) {
      throw new ConcurrentModificationError(
        `Incident ${request.ticketId} changed since triage read it`,
        { ticketId: request.ticketId, expectedVersion: request.expectedVersion },
      );
    }
    const { result } = (await response.json()) as { result: IncidentPayload };
    return toSnapshot(result);
  }

  async journal(request: JournalRequest): Promise<void> {
    await this.request(`/api/now/table/incident/${request.ticketId}/journal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: request.field,
        value: request.value,
        created_by: request.createdBy,
      }),
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new TicketingAdapterError(`ServiceNow request failed: ${path}`, true, { cause });
    }

    if (response.status >= 500 || response.status === 429) {
      throw new TicketingAdapterError(`ServiceNow returned ${response.status} for ${path}`, true, {
        status: response.status,
      });
    }
    if (!response.ok && response.status !== 404 && response.status !== 409) {
      throw new TicketingAdapterError(`ServiceNow returned ${response.status} for ${path}`, false, {
        status: response.status,
      });
    }
    return response;
  }
}
