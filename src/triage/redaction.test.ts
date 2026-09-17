import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redact, rehydrate } from "./redaction.js";

describe("redaction: nothing identifying reaches the prompt", () => {
  it("tokenises an email address", () => {
    const result = redact("Contact me at jane.doe@example.com please.");
    assert.ok(!result.text.includes("jane.doe@example.com"));
    assert.match(result.text, /\[EMAIL_1\]/);
    assert.deepEqual(result.found, ["EMAIL"]);
  });

  it("tokenises a card number", () => {
    const result = redact("My card 4111 1111 1111 1111 was charged twice.");
    assert.ok(!result.text.includes("4111 1111 1111 1111"));
    assert.ok(result.found.includes("CARD"));
  });

  it("tokenises a leaked credential", () => {
    const result = redact("Our key sk_live_abcdefghijklmnop1234 is in a public repo.");
    assert.ok(!result.text.includes("sk_live_abcdefghijklmnop1234"));
    assert.ok(result.found.includes("SECRET"));
  });

  it("leaves text with no PII untouched", () => {
    const text = "The dashboard is slow since this morning.";
    const result = redact(text);
    assert.equal(result.text, text);
    assert.deepEqual(result.found, []);
  });
});

describe("redaction: substitution is reversible", () => {
  it("round-trips the original value back into the customer reply", () => {
    // The customer still gets a personalised reply without their data having
    // been in the prompt.
    const result = redact("Write to alex@example.com about this.");
    assert.equal(rehydrate(result.text, result.tokens), "Write to alex@example.com about this.");
  });

  it("reuses one placeholder for a value repeated in the same ticket", () => {
    const result = redact("Mail alex@example.com. I repeat: alex@example.com.");
    assert.equal(result.tokens.size, 1);
    assert.equal((result.text.match(/\[EMAIL_1\]/g) ?? []).length, 2);
  });

  it("keeps distinct values on distinct placeholders", () => {
    const result = redact("Either alex@example.com or sam@example.com works.");
    assert.equal(result.tokens.size, 2);
    assert.equal(
      rehydrate(result.text, result.tokens),
      "Either alex@example.com or sam@example.com works.",
    );
  });
});
