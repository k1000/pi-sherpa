import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

export type CatalogRow = Record<string, string>;
export type ScoredRow = { row: CatalogRow; relevance: number };

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ",") { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}

export function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function readCsvRows(target: string): CatalogRow[] {
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, "utf8").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]!).map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: CatalogRow = {};
    header.forEach((key, index) => { row[key] = cells[index] ?? ""; });
    return row;
  });
}

export function readProjectCatalog(projectRoot: string): CatalogRow[] {
  return readCsvRows(path.join(projectRoot, "catalog.csv")).filter((row) => row.id && row.path);
}

export function resolveCatalogPath(projectRoot: string, rowPath: string): string {
  if (!rowPath) return projectRoot;
  if (rowPath.startsWith("repo://")) return path.join(projectRoot, rowPath.slice("repo://".length));
  if (rowPath.startsWith("file://")) return new URL(rowPath).pathname;
  if (path.isAbsolute(rowPath)) return rowPath;
  return path.resolve(projectRoot, rowPath);
}

function scoreText(query: string, text: string): number {
  const words = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  let hits = 0;
  for (const w of words) if (text.toLowerCase().includes(w)) hits++;
  return words.size ? hits / words.size : 0.1;
}

const DEFAULT_CATALOG_FIELDS = [
  "id", "scope", "project", "area", "category", "type", "title", "summary",
  "aliases", "tags", "related", "based_on", "supports", "implements",
  "derives_from", "applies_research", "applied_by_project", "generalizes_from",
  "specializes", "routes", "keywords",
];

export function catalogMatches(
  root: string,
  focus: string,
  options: { limit?: number; threshold?: number; fields?: string[] } = {},
): ScoredRow[] {
  const { limit = 8, threshold = 0.08, fields = DEFAULT_CATALOG_FIELDS } = options;
  return readProjectCatalog(root)
    .map((row) => ({
      row,
      relevance: scoreText(
        focus,
        fields.map((f) => row[f]).filter(Boolean).join("\n"),
      ),
    }))
    .filter((item) => item.relevance > threshold)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

export function readGlobalTaxonomy(): CatalogRow[] {
  return readCsvRows("/Users/kamil/Documents/articles/taxonomy.csv").filter((row) => row.kind && row.id);
}

export const DEFAULT_CATALOG_HEADER = [
  "id", "scope", "project", "area", "category", "type", "path", "title", "summary",
  "aliases", "tags", "status", "confidence", "updated", "based_on", "supports",
  "implements", "derives_from", "related", "applies_research", "applied_by_project",
  "generalizes_from", "specializes", "routes", "keywords",
];

function readCatalogHeader(target: string): string[] {
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  return existing.trim() ? parseCsvLine(existing.split(/\r?\n/)[0]!) : DEFAULT_CATALOG_HEADER;
}

function writeCatalogRows(target: string, header: string[], rows: CatalogRow[]): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, header.join(",") + "\n" + rows.map((row) => header.map((key) => csvCell(row[key] ?? "")).join(",")).join("\n") + (rows.length ? "\n" : ""));
}

export function appendCatalogRow(projectRoot: string, row: CatalogRow): void {
  const target = path.join(projectRoot, "catalog.csv");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const header = readCatalogHeader(target);
  if (row.id && readProjectCatalog(projectRoot).some((existingRow) => existingRow.id === row.id)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existing.trim()) writeFileSync(target, header.join(",") + "\n");
  appendFileSync(target, header.map((key) => csvCell(row[key] ?? "")).join(",") + "\n");
}

export function upsertCatalogRow(projectRoot: string, row: CatalogRow): void {
  const target = path.join(projectRoot, "catalog.csv");
  const header = [...new Set([...readCatalogHeader(target), ...Object.keys(row)])];
  const rows = readProjectCatalog(projectRoot);
  const idx = rows.findIndex((existing) => existing.id === row.id);
  const merged = idx >= 0 ? { ...rows[idx], ...row } : row;
  if (idx >= 0) rows[idx] = merged;
  else rows.push(merged);
  writeCatalogRows(target, header, rows);
}

export function auditCatalog(projectRoot: string): {
  catalogPath: string;
  rows: number;
  missingRequired: string[];
  brokenPaths: Array<{ id: string; path: string }>;
  directoryRows: number;
  fileRows: number;
  likelyOverIndexedDirs: Array<{ dir: string; fileRows: number }>;
  missingSummaries: string[];
  duplicateIds: string[];
} {
  const catalogPath = path.join(projectRoot, "catalog.csv");
  const rows = readProjectCatalog(projectRoot);
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const brokenPaths: Array<{ id: string; path: string }> = [];
  const missingSummaries: string[] = [];
  const fileCountsByDir = new Map<string, number>();
  let directoryRows = 0;
  let fileRows = 0;

  for (const row of rows) {
    if (seen.has(row.id)) duplicateIds.push(row.id);
    seen.add(row.id);
    if (!row.summary?.trim()) missingSummaries.push(row.id);
    const target = resolveCatalogPath(projectRoot, row.path);
    try {
      const st = statSync(target);
      if (st.isDirectory()) directoryRows++;
      if (st.isFile()) {
        fileRows++;
        const dir = path.dirname(row.path.replace(/^repo:\/\//, ""));
        fileCountsByDir.set(dir, (fileCountsByDir.get(dir) ?? 0) + 1);
      }
    } catch {
      brokenPaths.push({ id: row.id, path: row.path });
    }
  }

  return {
    catalogPath,
    rows: rows.length,
    missingRequired: existsSync(catalogPath) ? [] : ["catalog.csv"],
    brokenPaths,
    directoryRows,
    fileRows,
    likelyOverIndexedDirs: [...fileCountsByDir.entries()].filter(([, count]) => count > 5).map(([dir, count]) => ({ dir, fileRows: count })),
    missingSummaries,
    duplicateIds,
  };
}
