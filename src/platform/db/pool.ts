import pg from "pg";
import { config } from "../../config/index.js";
import { loggerFor } from "../logging/logger.js";

const log = loggerFor("db");

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => log.error({ err }, "idle client error"));

export type Queryable = Pick<pg.Pool, "query">;

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Waits for the database to accept connections.
 *
 * With a containerised Postgres the socket is listening before the server is
 * ready, and a cold container can take several seconds. Failing the whole
 * process on the first refused connection turns an ordinary startup race into a
 * crash loop, so boot retries briefly and only then gives up.
 */
export async function waitForDatabase(attempts = 10, baseDelayMs = 500): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query("SELECT 1");
      if (attempt > 1) log.info({ attempt }, "database ready");
      return;
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      log.warn({ attempt, attempts }, "database not ready, retrying");
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }

  throw new Error(
    `Database not reachable at ${config.db.url} after ${attempts} attempts. ` +
      `Is it running? Try: npm run db:up\nLast error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
