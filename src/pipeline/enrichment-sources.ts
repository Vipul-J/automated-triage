import type { CustomerTier, Ticket } from "../domain/types.js";
import type { EnrichmentSources } from "./enrichment.js";
import type { TicketingAdapter } from "../adapters/ticketing/types.js";

interface IncidentListItem {
  callerEmail: string;
  openedAt: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Enrichment backed by the ServiceNow instance.
 *
 * In production the incident feed comes from the incident manager and the error
 * context from the observability stack. Each source stays best-effort and
 * individually timed out: the pipeline degrades when one is slow, never blocks.
 */
export class ServiceNowEnrichmentSources implements EnrichmentSources {
  constructor(
    private readonly adapter: TicketingAdapter,
    private readonly baseUrl: string,
  ) {}

  async fetchCustomerTier(ticket: Ticket, signal: AbortSignal): Promise<CustomerTier> {
    const snapshot = await this.adapter.fetch(ticket.id);
    if (signal.aborted) throw new Error("aborted");
    return snapshot?.customerTier ?? ticket.customerTier;
  }

  async fetchRecentTicketCount(ticket: Ticket, signal: AbortSignal): Promise<number> {
    const response = await fetch(`${this.baseUrl}/api/now/table/incident`, { signal });
    const { result } = (await response.json()) as { result: IncidentListItem[] };
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    return result.filter(
      (i) => i.callerEmail === ticket.requesterEmail && Date.parse(i.openedAt) >= cutoff,
    ).length;
  }

  /**
   * Placeholder for the incident manager. A live major incident on the affected
   * service is one of the strongest routing signals available and changes the
   * caller-facing text entirely - worth wiring to the real source early.
   */
  async fetchOpenIncident(): Promise<{ service: string; summary: string } | null> {
    return null;
  }
}
