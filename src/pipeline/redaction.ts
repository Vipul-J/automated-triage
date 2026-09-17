/**
 * PII tokenisation, applied before any text reaches the model (design doc 13.2).
 *
 * Substitution is reversible: placeholders are stable within a ticket and are
 * rehydrated in the final customer-facing text, so the customer still gets a
 * personalised reply without their data sitting in a prompt.
 *
 * The patterns here are illustrative. A production deployment should run a
 * dedicated PII/secret detector (Presidio or equivalent) plus a secret scanner,
 * because customers paste credentials constantly.
 */
export interface RedactionResult {
  readonly text: string;
  readonly tokens: ReadonlyMap<string, string>;
  readonly found: readonly string[];
}

interface Pattern {
  readonly label: string;
  readonly regex: RegExp;
}

const PATTERNS: readonly Pattern[] = [
  { label: "EMAIL", regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { label: "CARD", regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { label: "PHONE", regex: /\+?\d[\d\s().-]{8,16}\d/g },
  { label: "IPV4", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // Long opaque strings that look like credentials.
  { label: "SECRET", regex: /\b(?:sk|pk|api|key|token|bearer)[_-][A-Za-z0-9_-]{16,}\b/gi },
];

export function redact(text: string): RedactionResult {
  const tokens = new Map<string, string>();
  const found = new Set<string>();
  const counters = new Map<string, number>();
  let output = text;

  for (const { label, regex } of PATTERNS) {
    output = output.replace(regex, (match) => {
      found.add(label);
      // Reuse the same placeholder for a repeated value within one ticket.
      for (const [placeholder, original] of tokens) {
        if (original === match) return placeholder;
      }
      const next = (counters.get(label) ?? 0) + 1;
      counters.set(label, next);
      const placeholder = `[${label}_${next}]`;
      tokens.set(placeholder, match);
      return placeholder;
    });
  }

  return { text: output, tokens, found: [...found] };
}

/** Restores original values in customer-facing text before it is sent. */
export function rehydrate(text: string, tokens: ReadonlyMap<string, string>): string {
  let output = text;
  for (const [placeholder, original] of tokens) {
    output = output.split(placeholder).join(original);
  }
  return output;
}
