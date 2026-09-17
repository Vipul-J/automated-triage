import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOrTsQuery } from "./knowledge.repository.js";

describe("retrieval: lexical queries use OR semantics", () => {
  it("joins terms with OR", () => {
    // websearch_to_tsquery and plainto_tsquery both AND their terms, so a
    // full-sentence ticket body matched nothing and the lexical half of the
    // hybrid silently contributed zero results.
    const query = buildOrTsQuery("stripe webhook timeout");
    assert.equal(query, "stripe | webhook | timeout");
  });

  it("drops filler that would otherwise match every document", () => {
    const query = buildOrTsQuery("please help this customer issue with stripe");
    assert.ok(query);
    assert.ok(!query.includes("please"), query);
    assert.ok(!query.includes("customer"), query);
    assert.ok(query.includes("stripe"), query);
  });

  it("keeps error codes and identifiers, which carry the most signal", () => {
    const query = buildOrTsQuery("getting ERR_CONN_RESET and 429 from the api");
    assert.ok(query);
    assert.ok(query.includes("err"), query);
    assert.ok(query.includes("conn"), query);
    assert.ok(query.includes("429"), query);
  });

  it("deduplicates repeated terms", () => {
    assert.equal(buildOrTsQuery("stripe stripe stripe"), "stripe");
  });

  it("returns null when nothing usable survives", () => {
    assert.equal(buildOrTsQuery("please help with this"), null);
    assert.equal(buildOrTsQuery("   "), null);
  });

  it("strips tsquery metacharacters rather than passing them through", () => {
    // Input is reduced to [a-z0-9] tokens, so no operator can survive into the
    // parsed query and change its meaning.
    const query = buildOrTsQuery("stripe & webhook | (timeout) !failure :*");
    assert.equal(query, "stripe | webhook | timeout | failure");
  });
});
