import type { CustomerTier, Ticket } from "../domain/types.js";
import type { EnrichmentSources } from "./enrichment.js";
import type { TicketingAdapter } from "../adapters/ticketing/types.js";

interface SimTicketListItem {
  requester: string;
  createdAt: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Enrichment backed by the ticketing simulator.
 *
 * In production these become calls to the CRM, the observability stack and the
 * incident manager. Each one stays best-effort and individually timed out: the
 * pipeline must degrade when a source is slow, never block on it.
 */
export class SimulatorEnrichmentSources implements EnrichmentSources {
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
    const response = await fetch(`${this.baseUrl}/api/tickets`, { signal });
    const all = (await response.json()) as SimTicketListItem[];
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    return all.filter(
      (t) => t.requester === ticket.requester && Date.parse(t.createdAt) >= cutoff,
    ).length;
  }

  /**
   * Placeholder for the incident manager. A live incident on the affected
   * service is one of the strongest routing signals available, and it changes
   * the customer-facing text entirely - worth wiring to the real source early.
   */
  async fetchOpenIncident(): Promise<{ service: string; summary: string } | null> {
    return null;
  }
}
