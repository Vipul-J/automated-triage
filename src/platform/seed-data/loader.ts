import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../../config/paths.js";
import { LEVELS } from "../../core/types.js";

const CatalogEntrySchema = z.object({
  service: z.string().min(1),
  team: z.string().min(1),
  level: z.enum(LEVELS),
  charter: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  active: z.boolean(),
});

const HistoricalTicketSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  resolvedTeam: z.string().min(1),
  resolvedLevel: z.enum(LEVELS),
  service: z.string().min(1),
});

const RunbookSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  service: z.string().min(1),
  team: z.string().min(1),
  content: z.string().min(1),
});

const TemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
});

export type CatalogFileEntry = z.infer<typeof CatalogEntrySchema>;
export type HistoricalTicket = z.infer<typeof HistoricalTicketSchema>;
export type Runbook = z.infer<typeof RunbookSchema>;
export type ResponseTemplate = z.infer<typeof TemplateSchema>;

/** Data files are validated on load: a malformed row fails the seed, not a request. */
async function loadJson<T>(filename: string, schema: z.ZodType<T>): Promise<T[]> {
  const path = join(paths.data, filename);
  const raw = await readFile(path, "utf8");

  const parsed = z.array(schema).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - [${i.path.join(".")}] ${i.message}`)
      .join("\n");
    throw new Error(`Invalid data file ${filename}:\n${issues}`);
  }
  return parsed.data;
}

export const loadCatalog = () => loadJson("service-catalog.json", CatalogEntrySchema);
export const loadHistoricalTickets = () =>
  loadJson("historical-tickets.json", HistoricalTicketSchema);
export const loadRunbooks = () => loadJson("runbooks.json", RunbookSchema);
export const loadResponseTemplates = () => loadJson("response-templates.json", TemplateSchema);
