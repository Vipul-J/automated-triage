import { z } from "zod";
import { config } from "../config/index.js";
import type { Ticket } from "../core/types.js";
import { INCIDENT_STATE } from "./incident.js";
import type { IncidentDetail } from "../web/views/incident.js";
type IncidentDetailFromTable = IncidentDetail & { sysId: string };

export const LiveIncidentId = z.string().regex(/^[0-9a-f]{32}$/i);
const reference = z
  .union([z.string(), z.object({ value: z.string() })])
  .default("")
  .transform((ref) => (typeof ref === "string" ? ref : ref.value));
const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).transform((value) => Number(value));

const TableIncident = z.object({
  sys_id: LiveIncidentId,
  number: z.string().regex(/^INC\d+$/i),
  short_description: z.string(),
  description: z.string().nullish(),
  impact: choice(["1", "2", "3"]),
  urgency: choice(["1", "2", "3"]),
  priority: choice(["1", "2", "3", "4", "5"]),
  state: choice(["1", "2", "3", "6", "7", "8"]),
  opened_at: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
  sys_updated_on: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
  assignment_group: reference,
  assigned_to: reference,
  category: z.string().default("inquiry"),
  contact_type: z.string().default("self-service"),
});

const fields = Object.keys(TableIncident.shape).join(",");

export class LiveServiceNow {
  constructor(private readonly options: NonNullable<typeof config.serviceNow>) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(`/api/now/table/incident${path}`, this.options.url);
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.options.bearerToken}`,
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(4500),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`ServiceNow Table API returned HTTP ${response.status}`);
    }
    return response;
  }

  async read(sysId: string): Promise<IncidentDetailFromTable | null> {
    const id = LiveIncidentId.parse(sysId);
    const response = await this.request(
      `/${id}?sysparm_display_value=false&sysparm_fields=${fields}`,
    );
    if (response.status === 404) return null;
    const { result } = z.object({ result: TableIncident }).parse(await response.json());
    const openedAt = utc(result.opened_at).toISOString();
    return {
      number: result.number,
      shortDescription: result.short_description,
      description: result.description ?? "",
      callerId: "ServiceNow",
      callerEmail: "",
      callerTier: "standard",
      contactType: result.contact_type,
      category: result.category,
      impact: result.impact as IncidentDetailFromTable["impact"],
      urgency: result.urgency as IncidentDetailFromTable["urgency"],
      priority: result.priority as IncidentDetailFromTable["priority"],
      state: result.state as IncidentDetailFromTable["state"],
      assignmentGroup: result.assignment_group || null,
      assignedTo: result.assigned_to || null,
      openedAt,
      sysUpdatedOn: utc(result.sys_updated_on).toISOString(),
      slaDueAt: new Date(Date.parse(openedAt) + config.deadlines.escalationWindowMs).toISOString(),
      escalated: false,
      escalatedAt: null,
      journal: [],
      aiTriaged: false,
      aiConfidence: null,
      aiTier: null,
      aiRunId: null,
      sysId: result.sys_id,
    };
  }

  async writeInternalNote(ticket: Ticket, note: string): Promise<void> {
    const sysId = LiveIncidentId.parse(ticket.sysId);
    const current = await this.read(sysId);
    if (
      !current ||
      current.state !== INCIDENT_STATE.NEW ||
      current.assignmentGroup ||
      current.assignedTo ||
      Date.now() >= ticket.deadlineAt.getTime()
    ) {
      throw new Error(
        "Decision saved locally; the ServiceNow incident is no longer eligible for a handoff",
      );
    }
    const response = await this.request(`/${sysId}?sysparm_fields=sys_id`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ work_notes: note }),
    });
    if (response.status === 404) throw new Error("ServiceNow incident no longer exists");
    z.object({ result: z.object({ sys_id: z.literal(sysId) }) }).parse(await response.json());
  }
}

export function toLiveTicket(incident: IncidentDetailFromTable): Ticket {
  return {
    id: incident.number,
    sysId: incident.sysId,
    subject: incident.shortDescription,
    body: incident.description,
    requester: "ServiceNow",
    requesterEmail: "",
    customerTier: "standard",
    category: incident.category,
    contactType: incident.contactType,
    createdAt: new Date(incident.openedAt),
    deadlineAt: new Date(incident.slaDueAt),
    status: incident.state === INCIDENT_STATE.NEW ? "new" : "in_progress",
    priority: incident.priority,
  };
}

function utc(date: string): Date {
  return new Date(date.replace(" ", "T") + "Z");
}
