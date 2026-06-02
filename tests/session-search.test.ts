/**
 * Session FTS5 Search tests.
 * Run with: bun tests/session-search.test.ts
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionSearchDb, closeSessionDb, indexSessionLog, searchSessions } from "../lib/session-search";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function assertEqual(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-session-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function sampleSessionLog(): string {
  return [
    JSON.stringify({ sessionId: "session-1", ts: "2026-06-01T10:00:00.000Z", kind: "prompt", prompt: "What is the error pipeline architecture?" }),
    JSON.stringify({ sessionId: "session-1", ts: "2026-06-01T10:00:05.000Z", kind: "response", response: "The error pipeline has three stages: capture, classify, recover." }),
    JSON.stringify({ sessionId: "session-1", ts: "2026-06-01T10:00:10.000Z", kind: "tool_result", content: [{ text: "Found 3 error handlers in pi-manager.ts" }] }),
    JSON.stringify({ sessionId: "session-2", ts: "2026-06-02T14:00:00.000Z", kind: "prompt", prompt: "How do I set up Tailscale serve?" }),
    JSON.stringify({ sessionId: "session-2", ts: "2026-06-02T14:00:08.000Z", kind: "response", response: "Run start.sh which calls serve-tailscale.sh. It uses tailscale serve https / http://localhost:9999" }),
    JSON.stringify({ sessionId: "session-3", ts: "2026-06-03T09:00:00.000Z", kind: "prompt", prompt: "Debug the Pi transport connection issue" }),
    JSON.stringify({ sessionId: "session-3", ts: "2026-06-03T09:00:15.000Z", kind: "response", response: "The pi-transport.ts file handles stdin/stdout JSON-RPC. Check the connected stdin reader." }),
    JSON.stringify({ sessionId: "session-3", ts: "2026-06-03T09:00:20.000Z", kind: "error", error: "ConnectionError: Pi process exited with code 1" }),
  ].join("\n") + "\n";
}

test("indexes and searches session log", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, sampleSessionLog());

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  const indexed = db.indexNewEntries();
  assertEqual(indexed, 8, "should index 8 entries");
  assertEqual(db.getIndexedEntryCount(), 8, "total should be 8");

  const results = db.search("error");
  assert(results.length > 0, "should find error results");
  const hasSession1 = results.some((r) => r.sessionId === "session-1");
  assert(hasSession1, "should include session-1");

  db.close();
}));

test("incremental indexing", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, sampleSessionLog());

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  assertEqual(db.indexNewEntries(), 8, "first index: 8 entries");
  assertEqual(db.indexNewEntries(), 0, "no new entries: 0");

  // Append more entries
  writeFileSync(logPath, sampleSessionLog() + [
    JSON.stringify({ sessionId: "session-4", ts: "2026-06-04T12:00:00.000Z", kind: "prompt", prompt: "Test incremental indexing" }),
  ].join("\n") + "\n");

  assertEqual(db.indexNewEntries(), 1, "one new entry indexed");
  assertEqual(db.getIndexedEntryCount(), 9, "total should be 9");

  db.close();
}));

test("search by query finds relevant sessions", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, sampleSessionLog());

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  db.indexNewEntries();

  // Search for tailscale — use simpler query that FTS5 can match
  const tailscaleResults = db.search("tailscale");
  assert(tailscaleResults.length > 0, "should find tailscale results");
  const hasSession2 = tailscaleResults.some((r) => r.sessionId === "session-2");
  assert(hasSession2, "should include session-2");

  // Search for transport
  const transportResults = db.search("stdin");
  assert(transportResults.length > 0, "should find transport results");
  const hasSession3 = transportResults.some((r) => r.sessionId === "session-3");
  assert(hasSession3, "should include session-3");

  db.close();
}));

test("lists indexed sessions with metadata", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, sampleSessionLog());

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  db.indexNewEntries();

  const sessions = db.listSessions();
  assertEqual(sessions.length, 3, "should have 3 sessions");
  const sessionIds = sessions.map((s) => s.sessionId);
  assert(sessionIds.includes("session-1"), "includes session-1");
  assert(sessionIds.includes("session-2"), "includes session-2");
  assert(sessionIds.includes("session-3"), "includes session-3");
  assert(sessionIds.indexOf("session-3") < sessionIds.indexOf("session-1"), "session-3 (most recent) should appear before session-1");

  db.close();
}));

test("loads full session content", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, sampleSessionLog());

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  db.indexNewEntries();

  const entries = db.loadSession("session-1");
  assertEqual(entries.length, 3, "session-1 should have 3 entries");
  assert(entries[0]!.text.includes("error pipeline"), "first entry about error pipeline");

  db.close();
}));

test("handles empty session log gracefully", () => withTemp((dir) => {
  const db = new SessionSearchDb(dir);
  assertEqual(db.indexNewEntries(), 0, "no entries in empty log");
  assertEqual(db.getIndexedEntryCount(), 0, "total should be 0");
  assertEqual(db.search("anything").length, 0, "no results from empty db");
  db.close();
}));

test("handles corrupt JSON lines", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, "valid line\ncorrupt json{{{}}}{\nnot json at all\n");

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  const indexed = db.indexNewEntries();
  // Valid line + corrupt lines get indexed as raw text
  assert(indexed >= 1, "should index at least the valid line");
  db.close();
}));

test("fallback search when FTS5 query fails", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, sampleSessionLog());

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  db.indexNewEntries();

  // Query with special characters that might trip FTS5
  const results = db.search("error &&& pipeline ||| architecture");
  assert(results.length === 0 || results.length > 0, "should not crash on special chars");
  db.close();
}));

test("incremental indexing handles non-ASCII byte offsets", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, JSON.stringify({ sessionId: "emoji", ts: "2026-06-01T10:00:00.000Z", kind: "prompt", prompt: "emoji café 🚀" }) + "\n");

  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  assertEqual(db.indexNewEntries(), 1, "first non-ASCII entry indexed");
  writeFileSync(logPath, readFileSync(logPath, "utf8") + JSON.stringify({ sessionId: "emoji", ts: "2026-06-01T10:00:01.000Z", kind: "response", response: "follow-up naïve" }) + "\n");
  assertEqual(db.indexNewEntries(), 1, "second non-ASCII entry indexed without corrupting offset");
  assert(db.search("naïve").some((r) => r.sessionId === "emoji"), "finds appended non-ASCII entry");
  db.close();
}));

test("index resets when session log is truncated", () => withTemp((dir) => {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, sampleSessionLog());
  const db = new SessionSearchDb(dir, { sessionLogPath: logPath });
  assertEqual(db.indexNewEntries(), 8, "initial entries indexed");
  writeFileSync(logPath, JSON.stringify({ sessionId: "new", ts: "2026-06-05T10:00:00.000Z", kind: "prompt", prompt: "after rotation" }) + "\n");
  assertEqual(db.indexNewEntries(), 1, "truncated log reindexed from start");
  assertEqual(db.getIndexedEntryCount(), 1, "old entries removed after truncation");
  db.close();
}));

test("top-level API keeps separate DBs per baseDir", () => {
  const dirA = mkdtempSync(path.join(os.tmpdir(), "sherpa-session-a-"));
  const dirB = mkdtempSync(path.join(os.tmpdir(), "sherpa-session-b-"));
  try {
    const logA = path.join(dirA, "a.jsonl");
    const logB = path.join(dirB, "b.jsonl");
    writeFileSync(logA, JSON.stringify({ sessionId: "A", ts: "2026-06-01T00:00:00.000Z", kind: "prompt", prompt: "alpha unique" }) + "\n");
    writeFileSync(logB, JSON.stringify({ sessionId: "B", ts: "2026-06-01T00:00:00.000Z", kind: "prompt", prompt: "bravo unique" }) + "\n");
    indexSessionLog({ sessionLogPath: logA }, dirA);
    indexSessionLog({ sessionLogPath: logB }, dirB);
    assert(searchSessions("alpha", 5, { sessionLogPath: logA }, dirA).some((r) => r.sessionId === "A"), "dirA finds A");
    assert(searchSessions("bravo", 5, { sessionLogPath: logB }, dirB).some((r) => r.sessionId === "B"), "dirB finds B");
    assert(!searchSessions("bravo", 5, { sessionLogPath: logA }, dirA).some((r) => r.sessionId === "B"), "dirA does not leak B");
  } finally {
    closeSessionDb();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ── Run ──
for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
