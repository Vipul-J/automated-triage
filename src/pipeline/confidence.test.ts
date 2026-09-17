import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreConfidence } from "./confidence.js";
import { makeContext, makeDoc, makeRecommendation } from "../test-support/fixtures.js";

const score = (args: {
  recommendation?: Parameters<typeof makeRecommendation>[0];
  docs?: ReturnType<typeof makeDoc>[];
  context?: Parameters<typeof makeContext>[0];
  match?: { team: string; reason: string; strength: number } | null;
  guardrailsPass?: boolean;
}) =>
  scoreConfidence({
    recommendation: makeRecommendation(args.recommendation),
    documents: args.docs ?? [],
    context: makeContext(args.context),
    deterministicMatch: args.match ?? null,
    guardrails: [{ name: "team-in-allow-list", passed: args.guardrailsPass ?? true }],
  });

const agreeing = makeDoc();
const disagreeing = makeDoc({ id: "h-1004", resolvedTeam: "Billing-L1", resolvedLevel: "L1" });

describe("confidence: neighbour agreement carries the most weight", () => {
  it("scores higher when similar incidents agree on the team", () => {
    const withAgreement = score({ docs: [agreeing, agreeing] });
    const withDisagreement = score({ docs: [disagreeing, disagreeing] });
    assert.ok(
      withAgreement.composite > withDisagreement.composite,
      `${withAgreement.composite} should exceed ${withDisagreement.composite}`,
    );
  });

  it("reports agreement as reasoning a human can read", () => {
    // A bare 0.78 means nothing to a reviewer at 2am.
    const result = score({ docs: [agreeing, disagreeing] });
    assert.match(result.note, /1 of 2 similar past tickets were resolved by Payments-Engineering-L3/);
  });

  it("says so plainly when nothing matched", () => {
    assert.match(score({ docs: [] }).note, /no similar past tickets matched/);
  });
});

describe("confidence: the model's self-report is one input, not the answer", () => {
  it("caps the composite when the model asks for a human", () => {
    // Self-reported confidence may be badly calibrated high, but a request for a
    // human is always honoured downward.
    const result = score({
      recommendation: { confidence: 0.99, needsHuman: true },
      docs: [agreeing, agreeing],
      match: { team: "Payments-Engineering-L3", reason: "keywords", strength: 1 },
    });
    assert.ok(result.composite <= 0.5, `expected <= 0.5, got ${result.composite}`);
  });

  it("does not let a confident model alone reach the auto threshold", () => {
    const result = score({ recommendation: { confidence: 1 }, docs: [] });
    assert.ok(result.composite < 0.85, `model self-report alone reached ${result.composite}`);
  });
});

describe("confidence: context and catalog signals", () => {
  it("penalises a missing enrichment source", () => {
    const full = score({ docs: [agreeing] });
    const degraded = score({ docs: [agreeing], context: { missing: ["incident-status"] } });
    assert.ok(degraded.composite < full.composite);
  });

  it("penalises a deterministic match that disagrees with the model", () => {
    const agrees = score({ match: { team: "Payments-Engineering-L3", reason: "kw", strength: 1 } });
    const disagrees = score({ match: { team: "Billing-L1", reason: "kw", strength: 1 } });
    assert.ok(disagrees.composite < agrees.composite);
    assert.match(disagrees.note, /catalog keywords instead suggest Billing-L1/);
  });

  it("penalises a tripped guardrail", () => {
    assert.ok(score({ guardrailsPass: false }).composite < score({ guardrailsPass: true }).composite);
  });
});
