import { pool } from "../pool.js";
import type { CatalogEntry, Level } from "../../../domain/types.js";

interface CatalogRow {
  service: string;
  team: string;
  level: Level;
  charter: string;
  keywords: string[];
  active: boolean;
}

const toEntry = (r: CatalogRow): CatalogEntry => ({
  service: r.service,
  team: r.team,
  level: r.level,
  charter: r.charter,
  keywords: r.keywords,
  active: r.active,
});

/**
 * The catalog is the routing allow-list and the source of the enum handed to the
 * model. It is read from the database - never from a compiled-in constant - so a
 * team added or retired in the catalog takes effect without a redeploy, and the
 * allow-list can never drift from what operations actually maintains.
 *
 * Cached briefly because it sits on the 3-minute critical path and changes rarely.
 */
export class CatalogRepository {
  private cache?: { entries: CatalogEntry[]; expiresAt: number };

  constructor(private readonly ttlMs = 60_000) {}

  async listActive(): Promise<CatalogEntry[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.entries;

    const { rows } = await pool.query<CatalogRow>(
      `SELECT service, team, level, charter, keywords, active
         FROM service_catalog
        WHERE active = TRUE
        ORDER BY level, team`,
    );
    const entries = rows.map(toEntry);
    this.cache = { entries, expiresAt: now + this.ttlMs };
    return entries;
  }

  /** The allow-list the model's `recommendedTeam` enum is built from. */
  async activeTeamNames(): Promise<string[]> {
    return (await this.listActive()).map((e) => e.team);
  }

  async findByTeam(team: string): Promise<CatalogEntry | undefined> {
    return (await this.listActive()).find((e) => e.team === team);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  async replaceAll(entries: readonly CatalogEntry[]): Promise<void> {
    await pool.query("TRUNCATE service_catalog RESTART IDENTITY CASCADE");
    for (const e of entries) {
      await pool.query(
        `INSERT INTO service_catalog (service, team, level, charter, keywords, active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.service, e.team, e.level, e.charter, [...e.keywords], e.active],
      );
    }
    this.invalidate();
  }
}

export const catalogRepository = new CatalogRepository();
