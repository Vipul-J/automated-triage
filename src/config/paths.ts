import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the project root by walking up to the nearest package.json.
 *
 * Paths to data and schema files were previously written as a fixed number of
 * `../` segments relative to whichever module needed them, which silently broke
 * the moment a file changed directory depth - the loader kept resolving, just to
 * the wrong place. Anchoring on the project root makes those references immune
 * to moves, and to being run from a different working directory.
 */
function findProjectRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the project root: no package.json found above src/config");
    }
    current = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot();

export const paths = Object.freeze({
  root: PROJECT_ROOT,
  /** Versioned seed data: catalog, routing memory, runbooks, templates. */
  data: resolve(PROJECT_ROOT, "data"),
  /** Database schema applied by the migrator. */
  schema: resolve(PROJECT_ROOT, "db", "schema.sql"),
});
