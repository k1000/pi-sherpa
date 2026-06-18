/**
 * Session FTS5 Search — Cross-session recall via SQLite FTS5.
 *
 * Indexes the HyperPod session log (JSONL) into a local SQLite database
 * with full-text search. Tracks last-indexed position for incremental updates.
 *
 * Ported from Hermes Agent's FTS5 cross-session recall mechanism.
 * See: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
 */

import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

// ── Types ───────────────────────────────────────────────────────────

export type SessionSearchMatch = {
  id: number;
  sessionId: string;
  ts: string;
  kind: string;
  snippet: string;
  rank: number;
};

export type SessionInfo = {
  sessionId: string;
  entryCount: number;
  firstTs: string;
  lastTs: string;
};

export type SessionSearchResult = {
  matches: SessionSearchMatch[];
  totalMatches: number;
  dbPath: string;
  sessionLogPath: string;
};

export type SessionSearchConfig = {
  /** Path to the SQLite FTS5 database file. Default: ~/.pi-memory/session-search.db */
  dbPath?: string;
  /** Path to the session log JSONL file. Default: ~/hyperpod-tmp/session.jsonl */
  sessionLogPath?: string;
  /** Maximum results per search query. Default: 10 */
  maxResults?: number;
};

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = ".pi-memory/session-search.db";
const DEFAULT_SESSION_LOG = "hyperpod-tmp/session.jsonl";

// ── DB wrapper ─────────────────────────────────────────────────────

export class SessionSearchDb {
  private db: SqliteDatabase;
  private ftsAvailable = false;
  private dbPath: string;
  private sessionLogPath: string;
  private maxResults: number;

  constructor(baseDir: string, config?: SessionSearchConfig) {
    this.dbPath = path.resolve(baseDir, config?.dbPath ?? DEFAULT_DB_PATH);
    this.sessionLogPath = path.resolve(
      config?.sessionLogPath ?? path.join(homedir(), DEFAULT_SESSION_LOG),
    );
    this.maxResults = config?.maxResults ?? 10;

    // Ensure parent directory exists
    const dir = path.dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = openSqliteDatabase(this.dbPath, "Sherpa session search");

    // Enable WAL for concurrent safety
    this.db.exec("PRAGMA journal_mode=WAL");

    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_entries (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      )
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_entries_fts USING fts5(
          session_id,
          ts,
          kind,
          text,
          content='session_entries',
          content_rowid='rowid'
        )
      `);
      // Triggers to keep FTS in sync when the runtime provides FTS5.
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS session_entries_ai AFTER INSERT ON session_entries BEGIN
          INSERT INTO session_entries_fts(rowid, session_id, ts, kind, text)
          VALUES (new.rowid, new.session_id, new.ts, new.kind, new.text);
        END
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS session_entries_ad AFTER DELETE ON session_entries BEGIN
          INSERT INTO session_entries_fts(session_entries_fts, rowid, session_id, ts, kind, text)
          VALUES ('delete', old.rowid, old.session_id, old.ts, old.kind, old.text);
        END
      `);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  /**
   * Get the byte offset up to which the session log has been indexed.
   * Returns 0 if never indexed.
   */
  private getLastIndexedOffset(): number {
    const row = this.db.query(
      "SELECT value FROM session_meta WHERE key = 'last_indexed_offset'",
    ).get() as { value: string } | null;
    return row ? Number(row.value) : 0;
  }

  private setMeta(key: string, value: string | number): void {
    this.db.query(
      "INSERT OR REPLACE INTO session_meta (key, value) VALUES (?, ?)",
    ).run(key, String(value));
  }

  private setLastIndexedOffset(offset: number): void {
    this.setMeta("last_indexed_offset", offset);
  }

  private resetIndexProgress(): void {
    this.db.exec("DELETE FROM session_entries");
    if (this.ftsAvailable) this.db.exec("DELETE FROM session_entries_fts");
    this.setLastIndexedOffset(0);
  }

  /**
   * Get the total number of indexed entries.
   */
  getIndexedEntryCount(): number {
    const row = this.db.query(
      "SELECT COUNT(*) as count FROM session_entries",
    ).get() as { count: number };
    return row?.count ?? 0;
  }

  /**
   * Index any new entries from the session log.
   * Returns the number of new entries indexed.
   */
  indexNewEntries(): number {
    if (!existsSync(this.sessionLogPath)) return 0;

    let lastOffset = this.getLastIndexedOffset();
    const fileSize = statSync(this.sessionLogPath).size;

    if (fileSize < lastOffset) {
      this.resetIndexProgress();
      lastOffset = 0;
    }
    if (fileSize === lastOffset) return 0; // Nothing new

    const buffer = readFileSync(this.sessionLogPath);
    const remaining = buffer.subarray(lastOffset).toString("utf8");
    const lines = remaining.split("\n").filter(Boolean);

    if (lines.length === 0) {
      this.setLastIndexedOffset(fileSize);
      return 0;
    }

    const insertStmt = this.db.query(
      "INSERT INTO session_entries (session_id, ts, kind, text) VALUES (?, ?, ?, ?)",
    );

    let indexed = 0;
    const insertEntries = this.db.transaction((inputLines: string[]) => {
      for (const line of inputLines) {
        const parsed = parseSessionLogLine(line);
        insertStmt.run(parsed.sessionId, parsed.ts, parsed.kind, parsed.text);
        indexed++;
      }
    });
    insertEntries(lines);

    this.setLastIndexedOffset(fileSize);
    this.setMeta("last_indexed_size", fileSize);
    this.setMeta("last_indexed_at", new Date().toISOString());
    return indexed;
  }

  /**
   * Full-text search across all indexed sessions.
   */
  search(query: string, limit?: number): SessionSearchMatch[] {
    const effectiveLimit = Math.min(limit ?? this.maxResults, 100);
    const safeQuery = sanitizeFts5Query(query);
    if (!this.ftsAvailable || !safeQuery) return this.fallbackSearch(query, effectiveLimit);
    try {
      const rows = this.db.query(`
        SELECT e.rowid as id, e.session_id as sessionId, e.ts, e.kind,
               snippet(session_entries_fts, 4, '<b>', '</b>', '…', 40) as snippet,
               rank
        FROM session_entries_fts
        JOIN session_entries e ON e.rowid = session_entries_fts.rowid
        WHERE session_entries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(safeQuery, effectiveLimit) as SessionSearchMatch[];

      return rows;
    } catch {
      // If FTS5 is unavailable in this runtime or query fails, fall back to LIKE search.
      return this.fallbackSearch(query, effectiveLimit);
    }
  }

  private fallbackSearch(query: string, limit: number): SessionSearchMatch[] {
    const likeQuery = `%${query.replace(/[%_]/g, "\\$&")}%`;
    const rows = this.db.query(`
      SELECT rowid as id, session_id as sessionId, ts, kind,
             substr(text, 1, 160) as snippet,
             0.0 as rank
      FROM session_entries
      WHERE text LIKE ? ESCAPE '\\'
      ORDER BY rowid DESC
      LIMIT ?
    `).all(likeQuery, limit) as SessionSearchMatch[];
    return rows;
  }

  /**
   * Get a summary of all indexed sessions.
   */
  listSessions(): SessionInfo[] {
    const rows = this.db.query(`
      SELECT session_id as sessionId,
             COUNT(*) as entryCount,
             MIN(ts) as firstTs,
             MAX(ts) as lastTs
      FROM session_entries
      GROUP BY session_id
      ORDER BY lastTs DESC
      LIMIT 100
    `).all() as SessionInfo[];
    return rows;
  }

  /**
   * Load all entries for a given session.
   */
  loadSession(sessionId: string): Array<{ ts: string; kind: string; text: string }> {
    const rows = this.db.query(`
      SELECT ts, kind, text
      FROM session_entries
      WHERE session_id = ?
      ORDER BY rowid ASC
      LIMIT 500
    `).all(sessionId) as Array<{ ts: string; kind: string; text: string }>;
    return rows;
  }

  /**
   * Rebuild the FTS index from scratch (e.g., after schema changes).
   */
  rebuildIndex(): void {
    this.db.exec("DELETE FROM session_entries_fts");
    this.db.exec(`
      INSERT INTO session_entries_fts(rowid, session_id, ts, kind, text)
      SELECT rowid, session_id, ts, kind, text FROM session_entries
    `);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

type ParsedSessionLogLine = { sessionId: string; ts: string; kind: string; text: string };

type SessionLogEntry = Record<string, unknown>;

function contentTextParts(content: unknown): string[] {
  if (!content) return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => typeof item === "object" && item && "text" in item ? String((item as { text?: unknown }).text ?? "") : "")
    .filter(Boolean);
}

function payloadTextParts(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as { text?: unknown; message?: unknown; content?: unknown };
  return [p.text, p.message, p.content].filter(Boolean).map(String);
}

function messageTextParts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => typeof message === "object" && message && "content" in message ? String((message as { content?: unknown }).content ?? "") : "")
    .filter(Boolean);
}

function sessionEntryText(entry: SessionLogEntry, fallback: string): string {
  const text = [
    entry.prompt,
    entry.response,
    entry.text,
    ...contentTextParts(entry.content),
    ...payloadTextParts(entry.payload),
    entry.error,
    ...messageTextParts(entry.messages),
  ].filter(Boolean).map(String).join("\n").slice(0, 10_000);
  return text || fallback.slice(0, 10_000);
}

function parseSessionLogLine(line: string): ParsedSessionLogLine {
  try {
    const entry = JSON.parse(line) as SessionLogEntry;
    return {
      sessionId: String(entry.sessionId ?? entry.session_id ?? "unknown"),
      ts: String(entry.ts ?? entry.timestamp ?? new Date().toISOString()),
      kind: String(entry.kind ?? entry.type ?? "unknown"),
      text: sessionEntryText(entry, line),
    };
  } catch {
    return { sessionId: "unknown", ts: new Date().toISOString(), kind: "unknown", text: line.slice(0, 10_000) };
  }
}

function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Removes or escapes characters that could cause syntax errors,
 * while preserving valid FTS5 operators (AND, OR, NOT, *, ").
 */
function sanitizeFts5Query(query: string): string {
  if (!query.trim()) return "";

  // Simple single-word queries don't need sanitization
  if (/^[\w@./_-]+$/.test(query.trim())) return query.trim();

  // For complex queries, wrap the whole thing as a phrase search
  // to avoid FTS5 syntax errors from special characters
  const cleaned = query.replace(/['"]/g, "").trim();
  if (!cleaned) return "";

  // If it's a simple phrase, use phrase search
  if (/^[\w\s]+$/.test(cleaned)) return `"${cleaned}"`;

  // Otherwise, extract meaningful words and OR them
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!;
  return words.map((w) => `${w}*`).join(" ");
}

// ── Top-level convenience API ───────────────────────────────────────

export type SessionSearchApiConfig = SessionSearchConfig;

const _dbByKey = new Map<string, SessionSearchDb>();

function dbKey(config?: SessionSearchApiConfig, baseDir?: string): string {
  const dir = baseDir ?? process.cwd();
  const dbPath = path.resolve(dir, config?.dbPath ?? DEFAULT_DB_PATH);
  const sessionLogPath = path.resolve(config?.sessionLogPath ?? path.join(homedir(), DEFAULT_SESSION_LOG));
  return `${dbPath}\n${sessionLogPath}`;
}

function getDb(config?: SessionSearchApiConfig, baseDir?: string): SessionSearchDb {
  const key = dbKey(config, baseDir);
  let db = _dbByKey.get(key);
  if (!db) {
    db = new SessionSearchDb(baseDir ?? process.cwd(), config);
    _dbByKey.set(key, db);
  }
  return db;
}

/**
 * Index new entries and return count. Call once at Sherpa startup.
 */
export function indexSessionLog(config?: SessionSearchApiConfig, baseDir?: string): number {
  return getDb(config, baseDir).indexNewEntries();
}

/**
 * Search indexed sessions by text query.
 */
export function searchSessions(
  query: string,
  limit?: number,
  config?: SessionSearchApiConfig,
  baseDir?: string,
): SessionSearchMatch[] {
  return getDb(config, baseDir).search(query, limit);
}

/**
 * Load all entries for a session.
 */
export function loadSession(
  sessionId: string,
  config?: SessionSearchApiConfig,
  baseDir?: string,
): Array<{ ts: string; kind: string; text: string }> {
  return getDb(config, baseDir).loadSession(sessionId);
}

/**
 * List all indexed sessions with metadata.
 */
export function listSessions(
  config?: SessionSearchApiConfig,
  baseDir?: string,
): SessionInfo[] {
  return getDb(config, baseDir).listSessions();
}

/**
 * Get total indexed entry count.
 */
export function getIndexedEntryCount(config?: SessionSearchApiConfig, baseDir?: string): number {
  return getDb(config, baseDir).getIndexedEntryCount();
}

/**
 * Close the global database connection. Call on shutdown.
 */
export function closeSessionDb(): void {
  for (const db of _dbByKey.values()) db.close();
  _dbByKey.clear();
}
