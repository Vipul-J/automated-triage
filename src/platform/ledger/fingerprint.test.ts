import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionFingerprint, type DecisionEvent } from "./fingerprint.js";

const event: DecisionEvent = {
  id: 10,
  ticket_id: "INC10001",
  recommendation_id: "review-1",
  actor: "demo.engineer",
  actor_role: "L1",
  action: "reroute",
  final_team: "Network-L2",
  final_level: "L2",
  response_after: "We received your report.",
  created_at: new Date("2026-11-16T00:00:00Z"),
  evidence: ["KB3", "INC2"],
  nonce: "60bc081c-4add-4d27-bece-0d4de504115f",
};

test("decision fingerprints are stable and detect edits to the actual approval record", () => {
  const expected = decisionFingerprint(event);
  assert.match(expected, /^0x[0-9a-f]{64}$/);
  assert.equal(
    expected,
    decisionFingerprint({ ...event, evidence: [...event.evidence].reverse() }),
  );
  assert.notEqual(expected, decisionFingerprint({ ...event, final_team: "Identity-L2" }));
  assert.notEqual(expected, decisionFingerprint({ ...event, response_after: "Changed text." }));
  assert.notEqual(expected, decisionFingerprint({ ...event, nonce: "different-nonce" }));
});
