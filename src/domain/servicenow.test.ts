import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  derivePriority, severityToImpactUrgency, PRIORITY_LABEL,
  type ImpactUrgency,
} from "./servicenow.js";

describe("servicenow: priority is derived, never set directly", () => {
  it("reproduces the standard impact x urgency matrix", () => {
    const expected: Record<ImpactUrgency, Record<ImpactUrgency, number>> = {
      1: { 1: 1, 2: 2, 3: 3 },
      2: { 1: 2, 2: 3, 3: 4 },
      3: { 1: 3, 2: 4, 3: 5 },
    };
    for (const impact of [1, 2, 3] as ImpactUrgency[]) {
      for (const urgency of [1, 2, 3] as ImpactUrgency[]) {
        assert.equal(
          derivePriority(impact, urgency),
          expected[impact][urgency],
          `impact ${impact} x urgency ${urgency}`,
        );
      }
    }
  });
});

describe("servicenow: severity maps to the intended priority", () => {
  const cases: [Parameters<typeof severityToImpactUrgency>[0], string][] = [
    ["P1", "1 - Critical"],
    ["P2", "2 - High"],
    // A P3 is a single-user fault with a workaround - Moderate, not Low. An
    // earlier 2/3 mapping produced 4-Low and understated every one of them.
    ["P3", "3 - Moderate"],
    ["P4", "5 - Planning"],
  ];

  for (const [severity, expected] of cases) {
    it(`maps ${severity} to ${expected}`, () => {
      const { impact, urgency } = severityToImpactUrgency(severity);
      assert.equal(PRIORITY_LABEL[derivePriority(impact, urgency)], expected);
    });
  }
});
