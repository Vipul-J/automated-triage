import { config } from "../../config/index.js";
import { ConcurrentModificationError, TicketingAdapterError } from "../../domain/errors.js";
import type { CustomerTier } from "../../domain/types.js";
import type {
  AssignmentRequest, CommentRequest, TicketingAdapter, TicketSnapshot,
} from "./types.js";

interface SimTicketPayload {
  id: string;
  subject: string;
  body: string;
  requester: string;
  customerTier: CustomerTier;
  createdAt: string;
  deadlineAt: string;
  status: string;
  version: string;
  assignedTeam: string | null;
}

const REQUEST_TIMEOUT_MS = 4_000;

const toSnapshot = (p: SimTicketPayload): TicketSnapshot => ({
  id: p.id,
  subject: p.subject,
  body: p.body,
  requester: p.requester,
  customerTier: p.customerTier,
  createdAt: new Date(p.createdAt),
  deadlineAt: new Date(p.deadlineAt),
  status: p.status,
  version: p.version,
  assignedTeam: p.assignedTeam,
});

/** Talks to the local simulator over the HTTP shape a real platform would use. */
export class SimulatorTicketingAdapter implements TicketingAdapter {
  readonly name = "simulator";

  constructor(private readonly baseUrl: string = config.http.simBaseUrl) {}

  async fetch(ticketId: string): Promise<TicketSnapshot | null> {
    const response = await this.request(`/api/tickets/${ticketId}`, { method: "GET" });
    if (response.status === 404) return null;
    return toSnapshot((await response.json()) as SimTicketPayload);
  }

  async assign(request: AssignmentRequest): Promise<TicketSnapshot> {
    const response = await this.request(`/api/tickets/${request.ticketId}/assign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": request.expectedVersion,
        "idempotency-key": request.idempotencyKey,
      },
      body: JSON.stringify({
        team: request.team, level: request.level, priority: request.priority,
      }),
    });

    // The ticket moved under us: a human took it, or it already escalated.
    if (response.status === 409) {
      throw new ConcurrentModificationError(
        `Ticket ${request.ticketId} changed since triage read it`,
        { ticketId: request.ticketId, expectedVersion: request.expectedVersion },
      );
    }
    return toSnapshot((await response.json()) as SimTicketPayload);
  }

  async comment(request: CommentRequest): Promise<void> {
    await this.request(`/api/tickets/${request.ticketId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: request.body, visibility: request.visibility }),
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
      // Transport failures are retryable; the write-back layer decides whether to.
      throw new TicketingAdapterError(`Ticketing request failed: ${path}`, true, { cause });
    }

    if (response.status >= 500 || response.status === 429) {
      throw new TicketingAdapterError(
        `Ticketing returned ${response.status} for ${path}`, true, { status: response.status },
      );
    }
    if (!response.ok && response.status !== 404 && response.status !== 409) {
      throw new TicketingAdapterError(
        `Ticketing returned ${response.status} for ${path}`, false, { status: response.status },
      );
    }
    return response;
  }
}
