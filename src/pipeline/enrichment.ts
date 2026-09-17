import { STAGE_BUDGET_MS } from "../config/index.js";
import type { CustomerTier, EnrichmentContext, Ticket } from "../domain/types.js";
import { bestEffort } from "../shared/timeout.js";

/** Per-source cap. Enrichment is best-effort and must never block the pipeline. */
const PER_SOURCE_BUDGET_MS = 1_500;

const ERROR_SIGNATURE_PATTERNS: readonly RegExp[] = [
  /\b[45]\d{2}\b/g,                       // HTTP status codes
  /\bORA-\d{4,5}\b/gi,                    // Oracle
  /\bERR_[A-Z_]+\b/g,                     // Node/Chrome style
  /\b[a-z]+_[a-z]+_(?:error|failed|denied)\b/gi,
  /\b(?:invalid_grant|access_denied|rate_limit_exceeded|deadlock detected)\b/gi,
];

export interface EnrichmentSources {
  fetchCustomerTier(ticket: Ticket, signal: AbortSignal): Promise<CustomerTier>;
  fetchRecentTicketCount(ticket: Ticket, signal: AbortSignal): Promise<number>;
  fetchOpenIncident(
    ticket: Ticket,
    signal: AbortSignal,
  ): Promise<{ service: string; summary: string } | null>;
}

export function extractErrorSignatures(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of ERROR_SIGNATURE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[0]) found.add(match[0].trim());
    }
  }
  return [...found].slice(0, 10);
}

/**
 * Fans out to every enrichment source in parallel under a hard total cap.
 * Anything that does not answer in time is simply absent, and its absence is
 * recorded so the confidence layer can discount it (design doc 5.4).
 */
export async function enrich(
  ticket: Ticket,
  sources: EnrichmentSources,
): Promise<EnrichmentContext> {
  const started = Date.now();

  const [tier, recent, incident] = await Promise.all([
    bestEffort<CustomerTier>(
      "customer-tier",
      PER_SOURCE_BUDGET_MS,
      (signal) => sources.fetchCustomerTier(ticket, signal),
      ticket.customerTier,
    ),
    bestEffort(
      "ticket-history",
      PER_SOURCE_BUDGET_MS,
      (signal) => sources.fetchRecentTicketCount(ticket, signal),
      0,
    ),
    bestEffort<{ service: string; summary: string } | null>(
      "incident-status",
      Math.min(PER_SOURCE_BUDGET_MS, STAGE_BUDGET_MS.enrich - (Date.now() - started)),
      (signal) => sources.fetchOpenIncident(ticket, signal),
      null,
    ),
  ]);

  const missing = [tier.degraded, recent.degraded, incident.degraded].filter(
    (d): d is string => d !== null,
  );

  return {
    customerTier: tier.value,
    recentTicketCount: recent.value,
    openIncident: incident.value,
    errorSignatures: extractErrorSignatures(`${ticket.subject} ${ticket.body}`),
    missing,
  };
}
