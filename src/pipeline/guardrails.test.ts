import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allGuardrailsPassed, runGuardrails } from "./guardrails.js";
import { makeRecommendation, testCatalog } from "../test-support/fixtures.js";

const check = (overrides: Parameters<typeof makeRecommendation>[0] = {}) =>
  runGuardrails({ recommendation: makeRecommendation(overrides), catalog: testCatalog });

const named = (results: ReturnType<typeof check>, name: string) => {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `guardrail '${name}' was not evaluated`);
  return found;
};

describe("guardrails: the allow-list is the injection backstop", () => {
  it("passes a clean recommendation", () => {
    assert.equal(allGuardrailsPassed(check()), true);
  });

  it("rejects a team that is not in the catalog", () => {
    assert.equal(named(check({ recommendedTeam: "Totally-Made-Up-L2" }), "team-in-allow-list").passed, false);
  });

  it("rejects a team that exists but is inactive", () => {
    // A retired team must not be routable even though the name is real.
    assert.equal(named(check({ recommendedTeam: "Retired-Team-L2" }), "team-in-allow-list").passed, false);
  });

  it("rejects a level that disagrees with the catalog", () => {
    assert.equal(named(check({ recommendedLevel: "L1" }), "level-matches-catalog").passed, false);
  });

  it("rejects alternatives outside the allow-list", () => {
    const results = check({ alternatives: [{ team: "Invented-L3", why: "because" }] });
    assert.equal(named(results, "alternatives-in-allow-list").passed, false);
  });
});

describe("guardrails: the customer-facing text carries brand and legal risk", () => {
  const cases: [string, string][] = [
    ["a resolution time", "Thanks for reporting this. We will fix this within 2 hours and follow up."],
    ["a fix promise", "Thanks for reporting this issue. We'll resolve this and let you know shortly."],
    ["a refund claim", "Thanks for getting in touch. Your refund has been approved and is on its way."],
    ["a same-day promise", "Thanks for reporting this. Our team will have this sorted by tomorrow morning."],
  ];

  for (const [label, clientResponse] of cases) {
    it(`rejects ${label}`, () => {
      assert.equal(named(check({ clientResponse }), "no-time-or-outcome-commitment").passed, false);
    });
  }

  it("rejects internal vocabulary leaking to the customer", () => {
    const clientResponse =
      "Thanks for getting in touch. I have escalated this to our L3 team per the runbook, " +
      "and they will follow up with you here as soon as they can.";
    assert.equal(named(check({ clientResponse }), "no-internal-vocabulary").passed, false);
  });

  it("rejects a residual secret that survived redaction", () => {
    const clientResponse =
      "Thanks for getting in touch about this. We found the key sk_live_abcd1234efgh5678 " +
      "in your report and have passed it to the team for review right away.";
    assert.equal(named(check({ clientResponse }), "no-residual-secret").passed, false);
  });

  it("rejects a reply that is too short to be a real acknowledgement", () => {
    assert.equal(named(check({ clientResponse: "Thanks, assigned." }), "response-length-sane").passed, false);
  });
});

describe("guardrails: evidence must support severity", () => {
  it("rejects a P1 with no cited evidence", () => {
    const results = check({ severity: "P1", evidence: [] });
    assert.equal(named(results, "severity-supported-by-evidence").passed, false);
  });

  it("accepts a P1 that cites evidence", () => {
    const results = check({ severity: "P1", evidence: ["h-3001"] });
    assert.equal(named(results, "severity-supported-by-evidence").passed, true);
  });
});
