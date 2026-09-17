import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preclassify } from "./preclassifier.js";
import { makeTicket, testCatalog } from "../testing/fixtures.js";

const classify = (subject: string, body = "") =>
  preclassify(makeTicket({ subject, body }), testCatalog);

describe("preclassifier: rules settle the obvious cases without a model call", () => {
  it("matches a clear single-team keyword hit", () => {
    const match = classify("Stripe charge failed", "A charge did not settle.");
    assert.equal(match?.team, "Payments-Engineering-L3");
  });

  it("returns null when nothing matches", () => {
    assert.equal(classify("The colour scheme is hard to read"), null);
  });

  it("returns null when two teams tie", () => {
    // An ambiguous match is not a match - if the keywords do not discriminate,
    // the model should decide rather than inherit a coin flip.
    assert.equal(classify("password reset and api rate limit"), null);
  });

  it("never proposes an inactive team", () => {
    const match = classify("This is a retired thing", "retired retired retired");
    assert.notEqual(match?.team, "Retired-Team-L2");
  });

  it("reports strength that grows with the number of matching keywords", () => {
    const one = classify("stripe question");
    const many = classify("stripe charge settlement problem");
    assert.ok((many?.strength ?? 0) >= (one?.strength ?? 0));
  });
});
