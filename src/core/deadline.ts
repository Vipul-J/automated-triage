import { StageTimeoutError } from "./errors.js";

export interface Deadline {
  readonly at: Date;
  remainingMs(): number;
  expired(): boolean;
}

export function deadlineAt(at: Date): Deadline {
  return {
    at,
    remainingMs: () => at.getTime() - Date.now(),
    expired: () => Date.now() >= at.getTime(),
  };
}

/**
 * Caps a stage at its slice of the budget. Every stage on the critical path runs
 * through this: with a hard escalation deadline, no component may block
 * indefinitely (design doc principle 3).
 */
export async function withTimeout<T>(
  stage: string,
  budgetMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new StageTimeoutError(stage, budgetMs)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort variant: on timeout or failure returns `fallback` and names the
 * source as degraded, rather than failing the ticket. Used for enrichment, where
 * missing context should cost confidence, not block the pipeline.
 */
export async function bestEffort<T>(
  source: string,
  budgetMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  fallback: T,
): Promise<{ value: T; degraded: string | null }> {
  try {
    const value = await withTimeout(source, budgetMs, fn);
    return { value, degraded: null };
  } catch {
    return { value: fallback, degraded: source };
  }
}

/** Measures a stage and records its duration into `timings`. */
export async function timed<T>(
  timings: Record<string, number>,
  stage: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[stage] = Math.round(performance.now() - start);
  }
}
