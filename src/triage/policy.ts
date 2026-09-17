import { config } from "../config/index.js";
import type {
  ConfidenceBreakdown,
  Decision,
  EnrichmentContext,
  GuardrailResult,
  Recommendation,
  Ticket,
} from "../core/types.js";
import { allGuardrailsPassed } from "./guardrails.js";

/**
 * Content that must always reach a human.
 *
 * These are deliberately broad: a false positive costs one human review, while a
 * false negative auto-routes a data-exposure report to a billing queue. Note the
 * word-stem coverage - an earlier version matched "exposed" but not "exposure",
 * and matched "another customer data" but not "another company's invoices",
 * which let a genuine isolation breach through.
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:breach(?:ed|es)?|leak(?:ed|ing|s)?|expos(?:ed|ure|ing)|vulnerabilit(?:y|ies)|cve-\d|exploit(?:ed|able)?|compromis(?:ed|e))\b/i,
  // "another company's invoices", "someone else's records", "other tenant data"
  /\b(?:another|other|different|someone\s+else'?s?)\s+(?:company|compan(?:y|ies)|organisation|organization|customer|tenant|user|account|client)(?:'s|s')?\s+\w{0,12}\s*(?:data|invoice|record|information|detail|document|file|order|account)/i,
  /\bi\s+can\s+see\s+(?:another|other|someone\s+else'?s?|a\s+different)\b/i,
  /\b(?:credential|password|api\s*key|token|secret)s?\s+(?:\w+\s+){0,2}(?:leaked|exposed|compromised|stolen|published|visible)/i,
  /\bunauthoris?zed\s+(?:access|login|activity)\b/i,
  /\b(?:gdpr|subpoena|legal\s+hold|lawsuit|compliance\s+audit|data\s+protection)\b/i,
];

/** Heuristic for a ticket trying to instruct the model rather than describe a fault. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (?:all |any )?(?:previous|prior|above) instructions/i,
  /\byou are now\b|\bnew instructions?\b|\bsystem prompt\b/i,
  /\bdisregard (?:the )?(?:rules|policy|instructions)\b/i,
];

export function detectSensitive(ticket: Ticket): string | null {
  const haystack = `${ticket.subject}\n${ticket.body}`;
  const hit = SENSITIVE_PATTERNS.find((p) => p.test(haystack));
  return hit ? `sensitive content matched ${hit}` : null;
}

export function detectInjectionAttempt(ticket: Ticket): string | null {
  const haystack = `${ticket.subject}\n${ticket.body}`;
  const hit = INJECTION_PATTERNS.find((p) => p.test(haystack));
  return hit ? `possible prompt-injection attempt matched ${hit}` : null;
}

/**
 * The policy engine (design doc section 10).
 *
 * Decides the tier, which settles both what happens if nobody responds before
 * the deadline AND who owns the decision. L1 is the default owner; L2 sees only
 * the hard tail. Thresholds live in configuration so risk appetite can be tuned
 * without a deploy.
 */
export function decide(args: {
  ticket: Ticket;
  recommendation: Recommendation;
  confidence: ConfidenceBreakdown;
  guardrails: readonly GuardrailResult[];
  context: EnrichmentContext;
}): Decision {
  const { ticket, recommendation: rec, confidence, guardrails, context } = args;
  const reasons: string[] = [];

  const manual = (reason: string): Decision => {
    reasons.push(reason);
    return {
      tier: "MANUAL",
      owner: "L2",
      reasons,
      autoApplyAtDeadline: false,
      ackOnly: false,
    };
  };

  // --- MANUAL: never delegated, never auto-applied -------------------------
  const sensitive = detectSensitive(ticket);
  if (sensitive) return manual(sensitive);

  const injection = detectInjectionAttempt(ticket);
  if (injection) return manual(injection);

  if (rec.severity === "P1") return manual("P1 severity");
  if (ticket.customerTier !== "standard") return manual(`${ticket.customerTier} account`);

  // Asymmetric downward routing (design doc 10.1). A bad route *up* costs
  // specialist time; a bad route *down* bounces and burns the whole window.
  if (rec.recommendedLevel === "L1" && confidence.composite < config.policy.confDownwardL1) {
    return manual(
      `downward route to L1 below the ${config.policy.confDownwardL1} bar ` +
        `(scored ${confidence.composite.toFixed(2)})`,
    );
  }

  const guardrailsClean = allGuardrailsPassed(guardrails);
  if (!guardrailsClean) {
    reasons.push(
      `guardrail trips: ${guardrails
        .filter((g) => !g.passed)
        .map((g) => g.name)
        .join(", ")}`,
    );
  }

  // --- ASSIST: acknowledge the customer, do not claim a route --------------
  if (confidence.composite < config.policy.confReview || !guardrailsClean || rec.needsHuman) {
    if (rec.needsHuman) reasons.push("model flagged needsHuman");
    if (confidence.composite < config.policy.confReview) {
      reasons.push(`confidence ${confidence.composite.toFixed(2)} below review threshold`);
    }
    return {
      tier: "ASSIST",
      owner: "L1",
      reasons,
      autoApplyAtDeadline: false,
      // The two decisions are separable: stop the clock with a true
      // acknowledgement without gambling on a routing claim.
      ackOnly: true,
    };
  }

  // --- AUTO: high confidence, low risk ------------------------------------
  if (confidence.composite >= config.policy.confAuto && context.missing.length === 0) {
    reasons.push(`confidence ${confidence.composite.toFixed(2)} at or above auto threshold`);
    return {
      tier: "AUTO",
      owner: "L1",
      reasons,
      autoApplyAtDeadline: true,
      ackOnly: false,
    };
  }

  // --- REVIEW: the middle ground ------------------------------------------
  reasons.push(`confidence ${confidence.composite.toFixed(2)} in the review band`);
  if (context.missing.length > 0) reasons.push(`degraded context: ${context.missing.join(", ")}`);
  return {
    tier: "REVIEW",
    owner: "L1",
    reasons,
    autoApplyAtDeadline: true,
    ackOnly: false,
  };
}
