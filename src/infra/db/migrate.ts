import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "./pool.js";
import { loggerFor } from "../logging/logger.js";

const log = loggerFor("migrate");

const SCHEMA_PATH = fileURLToPath(new URL("../../../db/schema.sql", import.meta.url));

export async function migrate(): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, "utf8");
  await pool.query(sql);
  log.info("schema applied");
}

// Executed directly (`npm run migrate`) rather than imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await migrate();
  } catch (err) {
    log.error({ err }, "migration failed");
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
