import type {
  CatalogEntry, ConfidenceBreakdown, EnrichmentContext, Level,
  Recommendation, RetrievedDoc, Severity, Ticket,
} from "../domain/types.js";

/** Minimal catalog covering one team per level, enough for routing assertions. */
export const testCatalog: CatalogEntry[] = [
  {
    service: "account", team: "Customer-Care-L1", level: "L1",
    charter: "Password resets and how-to questions.",
    keywords: ["password", "login", "reset"], active: true,
  },
  {
    service: "api", team: "API-Support-L2", level: "L2",
    charter: "Public API behaviour and rate limits.",
    keywords: ["api", "rate limit", "429"], active: true,
  },
  {
    service: "payments", team: "Payments-Engineering-L3", level: "L3",
    charter: "Payment processing internals.",
    keywords: ["stripe", "charge", "settlement"], active: true,
  },
  {
    service: "security", team: "Security-Engineering-L3", level: "L3",
    charter: "Breaches and vulnerability reports.",
    keywords: ["breach", "vulnerability"], active: true,
  },
  {
    service: "retired", team: "Retired-Team-L2", level: "L2",
    charter: "No longer active.", keywords: ["retired"], active: false,
  },
];

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const createdAt = new Date("2026-09-17T10:00:00Z");
  return {
    id: "INC0010001",
    sysId: "0".repeat(32),
    subject: "Checkout is failing for some customers",
    body: "Several customers report an error at checkout since this morning.",
    requester: "Alex Morgan",
    requesterEmail: "alex.morgan@example.com",
    customerTier: "standard",
    category: "inquiry",
    contactType: "self-service",
    createdAt,
    deadlineAt: new Date(createdAt.getTime() + 180_000),
    status: "new",
    ...overrides,
  };
}

export function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    summary: "Checkout failures",
    category: "payments",
    affectedService: "payments",
    severity: "P3" as Severity,
    recommendedTeam: "Payments-Engineering-L3",
    recommendedLevel: "L3" as Level,
    alternatives: [],
    confidence: 0.8,
    rationale: "Similar incidents were resolved by the payments team.",
    evidence: ["h-3001"],
    clientResponse:
      "Thanks for getting in touch. I've passed this to the team that handles payments, " +
      "and they'll follow up here with an update as soon as they have one.",
    needsHuman: false,
    missingInformation: [],
    ...overrides,
  };
}

export function makeContext(overrides: Partial<EnrichmentContext> = {}): EnrichmentContext {
  return {
    customerTier: "standard",
    openIncident: null,
    recentTicketCount: 0,
    errorSignatures: [],
    missing: [],
    ...overrides,
  };
}

export function makeConfidence(composite: number): ConfidenceBreakdown {
  return {
    model: composite, neighbourAgreement: composite, catalogMatch: composite,
    contextCompleteness: 1, guardrails: 1, composite,
    note: `test fixture at ${composite}`,
  };
}

export function makeDoc(overrides: Partial<RetrievedDoc> = {}): RetrievedDoc {
  return {
    id: "h-3001",
    kind: "ticket",
    title: "Stripe webhook timeouts causing duplicate charges",
    content: "Handler exceeded the Stripe timeout and retries produced duplicates.",
    resolvedTeam: "Payments-Engineering-L3",
    resolvedLevel: "L3",
    service: "payments",
    score: 0.5,
    via: ["lexical", "vector"],
    ...overrides,
  };
}
