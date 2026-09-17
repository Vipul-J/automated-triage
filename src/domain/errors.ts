/** Base for every error this system raises deliberately. */
export abstract class TriageError extends Error {
  abstract readonly code: string;
  /** Whether a retry could plausibly succeed. Drives the fallback ladder. */
  abstract readonly retryable: boolean;

  constructor(message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** A stage exceeded its slice of the 3-minute budget. */
export class StageTimeoutError extends TriageError {
  readonly code = "STAGE_TIMEOUT";
  readonly retryable = true;
  constructor(stage: string, budgetMs: number) {
    super(`Stage '${stage}' exceeded its ${budgetMs}ms budget`, { stage, budgetMs });
  }
}

/** The model returned something that does not satisfy the schema. */
export class InvalidModelOutputError extends TriageError {
  readonly code = "INVALID_MODEL_OUTPUT";
  readonly retryable = true;
}

/** The model declined. Fail-safe: this routes to a human, never to a retry. */
export class ModelRefusalError extends TriageError {
  readonly code = "MODEL_REFUSAL";
  readonly retryable = false;
}

/** A proposed team is not in the live catalog allow-list. */
export class UnknownTeamError extends TriageError {
  readonly code = "UNKNOWN_TEAM";
  readonly retryable = false;
  constructor(team: string) {
    super(`Team '${team}' is not an active entry in the service catalog`, { team });
  }
}

/** The ticket changed underneath us - a human took over, or it already escalated. */
export class ConcurrentModificationError extends TriageError {
  readonly code = "CONCURRENT_MODIFICATION";
  readonly retryable = false;
}

export class TicketingAdapterError extends TriageError {
  readonly code = "TICKETING_ADAPTER";
  constructor(message: string, readonly retryable: boolean, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}
