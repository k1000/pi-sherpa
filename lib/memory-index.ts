/**
 * SQLite-backed Sherpa Memory Index.
 *
 * Canonical knowledge remains in Markdown/CSV/JSONL. This module builds a local
 * SQLite/FTS5 index for fast search, structured metadata, dedup/state lookup,
 * and future analytics.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseCsvRows } from "./catalog";

export type MemoryIndexConfig = {
  dbPath?: string;
  scratchpadRoot?: string;
  catalogRoots?: string[];
  evaluationRoot?: string;
  nudgeDigestPath?: string;
};

export type MemoryIndexStats = {
  documents: number;
  scratchpadEntries: number;
  catalogEntries: number;
  evaluations: number;
  dedupHashes: number;
  dbPath: string;
};

export type MemorySearchResult = {
  id: string;
  kind: string;
  sourcePath: string;
  title: string;
  summary: string;
  snippet: string;
  rank: number;
};

const DEFAULT_DB_PATH = ".pi-memory/memory-index.db";
const SCRATCHPAD_SECTIONS = ["todo", "observation", "issue", "next", "distill_candidate"];

export class SherpaMemoryIndex {
  private db: Database;
  readonly dbPath: string;

  constructor(baseDir: string, config: MemoryIndexConfig = {}) {
    this.dbPath = path.resolve(baseDir, config.dbPath ?? DEFAULT_DB_PATH);
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = Database.open(this.dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        id UNINDEXED,
        kind,
        source_path,
        title,
        summary,
        body
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY,
        section TEXT NOT NULL,
        created_at TEXT,
        title TEXT,
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        source_path TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_entries (
        id TEXT PRIMARY KEY,
        catalog_path TEXT NOT NULL,
        row_id TEXT,
        scope TEXT,
        project TEXT,
        kind TEXT,
        path TEXT,
        title TEXT,
        summary TEXT,
        tags TEXT,
        hash TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        bundle_id TEXT,
        relevance REAL,
        precision REAL,
        recall REAL,
        evaluated_at TEXT,
        source_path TEXT NOT NULL,
        hash TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dedup_hashes (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  close(): void { this.db.close(); }

  indexAll(baseDir: string, config: MemoryIndexConfig = {}): MemoryIndexStats {
    const scratchpadRoot = path.resolve(baseDir, config.scratchpadRoot ?? ".pi-memory/scratchpad");
    this.indexScratchpad(scratchpadRoot);

    const catalogRoots = config.catalogRoots?.length ? config.catalogRoots : [baseDir];
    for (const root of catalogRoots) this.indexCatalog(path.resolve(baseDir, root));

    if (config.evaluationRoot) this.indexEvaluations(path.resolve(baseDir, config.evaluationRoot));
    if (config.nudgeDigestPath) this.indexDedupHashes(path.resolve(baseDir, config.nudgeDigestPath));
    else this.indexDedupHashes(path.join(scratchpadRoot, "nudge-digest.jsonl"));

    this.setState("last_indexed_at", new Date().toISOString());
    return this.stats();
  }

  indexScratchpad(scratchpadRoot: string): void {
    const sectionsDir = path.join(scratchpadRoot, "sections");
    if (!existsSync(sectionsDir)) return;
    for (const section of SCRATCHPAD_SECTIONS) {
      const filePath = path.join(sectionsDir, `${section}.md`);
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, "utf8");
      const entries = splitScratchpadEntries(raw);
      entries.forEach((entry, index) => {
        const id = stableId("scratchpad", filePath, section, String(index), entry.body);
        const hash = sha256(entry.body);
        this.upsertScratchpadEntry({ id, section, sourcePath: filePath, ...entry, hash });
        this.upsertDocument({ id, kind: `scratchpad:${section}`, sourcePath: filePath, title: entry.title || section, summary: summarize(entry.body), body: entry.body, hash });
      });
    }
  }

  indexCatalog(root: string): void {
    const catalogPath = path.join(root, "catalog.csv");
    if (!existsSync(catalogPath)) return;
    const rows = parseCsvRows(readFileSync(catalogPath, "utf8"));
    rows.forEach((row, index) => {
      const body = [row.id, row.scope, row.project, row.area, row.category, row.type, row.title, row.summary, row.aliases, row.tags, row.routes, row.keywords, row.path].filter(Boolean).join("\n");
      const id = stableId("catalog", catalogPath, row.id || String(index), body);
      const hash = sha256(body);
      this.upsertCatalogEntry({ id, catalogPath, row, hash });
      this.upsertDocument({ id, kind: `catalog:${row.type || "entry"}`, sourcePath: catalogPath, title: row.title || row.id || "Catalog entry", summary: row.summary || "", body, hash, scope: row.scope });
    });
  }

  indexEvaluations(root: string): void {
    const dir = path.join(root, "wiki", "evidence", "sherpa-evaluations");
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      const sourcePath = path.join(dir, file);
      const raw = readFileSync(sourcePath, "utf8");
      const fm = parseFrontmatter(raw);
      const bundleId = fm.bundle_id || file.replace(/\.md$/, "");
      const body = raw.replace(/^---[\s\S]*?---\n*/, "").trim();
      const id = stableId("evaluation", sourcePath, bundleId, raw);
      const hash = sha256(raw);
      this.upsertEvaluation({ id, bundleId, sourcePath, hash, fm });
      this.upsertDocument({ id, kind: "evaluation", sourcePath, title: `Sherpa evaluation ${bundleId}`, summary: fm.improvement_hint || summarize(body), body, hash });
    }
  }

  indexDedupHashes(digestPath: string): void {
    if (!existsSync(digestPath)) return;
    const stmt = this.db.query("INSERT OR REPLACE INTO dedup_hashes (hash, kind, created_at) VALUES (?, ?, ?)");
    for (const line of readFileSync(digestPath, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.digest) stmt.run(String(entry.digest), "nudge", entry.ts ?? null);
      } catch { /* ignore malformed digest lines */ }
    }
  }

  search(query: string, limit = 10): MemorySearchResult[] {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];
    const capped = Math.max(1, Math.min(100, Math.floor(limit)));
    try {
      return this.db.query(`
        SELECT d.id, d.kind, d.source_path as sourcePath, d.title, COALESCE(d.summary, '') as summary,
               snippet(documents_fts, 5, '<b>', '</b>', '…', 40) as snippet,
               rank
        FROM documents_fts
        JOIN documents d ON d.id = documents_fts.id
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(safe, capped) as MemorySearchResult[];
    } catch {
      const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
      return this.db.query(`
        SELECT id, kind, source_path as sourcePath, title, COALESCE(summary, '') as summary,
               summary as snippet,
               0.0 as rank
        FROM documents
        WHERE title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(like, like, capped) as MemorySearchResult[];
    }
  }

  stats(): MemoryIndexStats {
    const count = (table: string) => Number((this.db.query(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count ?? 0);
    return {
      documents: count("documents"),
      scratchpadEntries: count("scratchpad_entries"),
      catalogEntries: count("catalog_entries"),
      evaluations: count("evaluations"),
      dedupHashes: count("dedup_hashes"),
      dbPath: this.dbPath,
    };
  }

  private upsertDocument(input: { id: string; kind: string; sourcePath: string; title: string; summary: string; body: string; hash: string; scope?: string }): void {
    const updatedAt = fileUpdatedAt(input.sourcePath);
    this.db.query(`
      INSERT OR REPLACE INTO documents (id, source_path, kind, scope, title, summary, hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.sourcePath, input.kind, input.scope ?? null, input.title, input.summary, input.hash, updatedAt);
    this.db.query("DELETE FROM documents_fts WHERE id = ?").run(input.id);
    this.db.query("INSERT INTO documents_fts (id, kind, source_path, title, summary, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.kind, input.sourcePath, input.title, input.summary, input.body);
  }

  private upsertScratchpadEntry(input: { id: string; section: string; sourcePath: string; title: string; body: string; createdAt?: string; hash: string }): void {
    this.db.query(`
      INSERT OR REPLACE INTO scratchpad_entries (id, section, created_at, title, body, hash, source_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.section, input.createdAt ?? null, input.title, input.body, input.hash, input.sourcePath);
  }

  private upsertCatalogEntry(input: { id: string; catalogPath: string; row: Record<string, string>; hash: string }): void {
    const row = input.row;
    this.db.query(`
      INSERT OR REPLACE INTO catalog_entries (id, catalog_path, row_id, scope, project, kind, path, title, summary, tags, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.catalogPath, row.id ?? null, row.scope ?? null, row.project ?? null, row.type ?? row.kind ?? null, row.path ?? null, row.title ?? null, row.summary ?? null, row.tags ?? null, input.hash);
  }

  private upsertEvaluation(input: { id: string; bundleId: string; sourcePath: string; hash: string; fm: Record<string, string> }): void {
    this.db.query(`
      INSERT OR REPLACE INTO evaluations (id, bundle_id, relevance, precision, recall, evaluated_at, source_path, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.bundleId, Number(input.fm.relevance ?? 0), Number(input.fm.precision ?? 0), Number(input.fm.recall ?? 0), input.fm.evaluated_at ?? null, input.sourcePath, input.hash);
  }

  private setState(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, new Date().toISOString());
  }
}

const _indexes = new Map<string, SherpaMemoryIndex>();

function indexKey(baseDir: string, config: MemoryIndexConfig = {}): string {
  return path.resolve(baseDir, config.dbPath ?? DEFAULT_DB_PATH);
}

export function getSherpaMemoryIndex(baseDir: string, config: MemoryIndexConfig = {}): SherpaMemoryIndex {
  const key = indexKey(baseDir, config);
  let index = _indexes.get(key);
  if (!index) {
    index = new SherpaMemoryIndex(baseDir, config);
    _indexes.set(key, index);
  }
  return index;
}

export function indexSherpaMemory(baseDir: string, config: MemoryIndexConfig = {}): MemoryIndexStats {
  return getSherpaMemoryIndex(baseDir, config).indexAll(baseDir, config);
}

export function searchSherpaMemory(baseDir: string, query: string, limit = 10, config: MemoryIndexConfig = {}): MemorySearchResult[] {
  return getSherpaMemoryIndex(baseDir, config).search(query, limit);
}

export function closeSherpaMemoryIndexes(): void {
  for (const index of _indexes.values()) index.close();
  _indexes.clear();
}

function splitScratchpadEntries(raw: string): Array<{ title: string; body: string; createdAt?: string }> {
  const chunks = raw.split(/\n(?=###\s+)/).map((chunk) => chunk.trim()).filter((chunk) => chunk.startsWith("###"));
  if (chunks.length) return chunks.map((chunk) => {
    const title = chunk.match(/^###\s+(.+)/)?.[1]?.trim() ?? "Scratchpad entry";
    const createdAt = chunk.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)?.[0];
    return { title, createdAt, body: chunk.replace(/^###\s+.*\n?/, "").trim() };
  });
  const body = raw.replace(/^#.*\n?/, "").trim();
  return body ? [{ title: "Scratchpad", body }] : [];
}

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
  }
  return out;
}

function fileUpdatedAt(filePath: string): string {
  try { return statSync(filePath).mtime.toISOString(); }
  catch { return new Date().toISOString(); }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\0"), "utf8").digest("hex");
}

function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function sanitizeFtsQuery(query: string): string {
  const cleaned = query.replace(/["']/g, "").trim();
  if (!cleaned) return "";
  if (/^[\w@./_-]+$/.test(cleaned)) return cleaned;
  if (/^[\w\s-]+$/.test(cleaned)) return `"${cleaned}"`;
  const words = cleaned.split(/\W+/).filter((word) => word.length > 1);
  return words.length > 1 ? words.map((word) => `${word}*`).join(" ") : (words[0] ?? "");
}
