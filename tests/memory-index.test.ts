/**
 * Sherpa Memory Index tests.
 * Run with: bun tests/memory-index.test.ts
 */

import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeSherpaMemoryIndexes, indexSherpaMemory, searchSherpaMemory } from "../lib/memory-index";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function assertEqual(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-memory-index-"));
  try { fn(dir); } finally { closeSherpaMemoryIndexes(); rmSync(dir, { recursive: true, force: true }); }
}

function seedMemoryFiles(dir: string) {
  const sections = path.join(dir, ".pi-memory", "scratchpad", "sections");
  mkdirSync(sections, { recursive: true });
  writeFileSync(path.join(sections, "observation.md"), [
    "# observation",
    "",
    "### Nudge — 2026-06-02T12:00:00.000Z",
    "",
    "Project uses SQLite FTS5 for session and memory indexing.",
  ].join("\n"));
  writeFileSync(path.join(sections, "distill_candidate.md"), [
    "# distill_candidate",
    "",
    "### Procedure — 2026-06-02T12:10:00.000Z",
    "",
    "When indexing memory, keep Markdown canonical and SQLite as search layer.",
  ].join("\n"));

  writeFileSync(path.join(dir, "catalog.csv"), [
    "id,scope,project,type,path,title,summary,tags",
    "memory.sqlite,project,sherpa,pattern,wiki/procedures/sqlite.md,SQLite Memory Index,FTS5-backed searchable memory index,sherpa|sqlite",
  ].join("\n") + "\n");

  const evalDir = path.join(dir, "wiki", "evidence", "sherpa-evaluations");
  mkdirSync(evalDir, { recursive: true });
  writeFileSync(path.join(evalDir, "bundle-abc.md"), [
    "---",
    "bundle_id: bundle-abc",
    "task_outcome: completed",
    "relevance: 0.9",
    "precision: 0.8",
    "recall: 0.7",
    "improvement_hint: \"prefer memory index for recall\"",
    "evaluated_at: 2026-06-02T12:20:00.000Z",
    "---",
    "",
    "# Sherpa Evaluation",
    "Memory index retrieval was helpful.",
  ].join("\n"));

  appendFileSync(path.join(dir, ".pi-memory", "scratchpad", "nudge-digest.jsonl"), JSON.stringify({ digest: "abc123", ts: "2026-06-02T12:00:00.000Z" }) + "\n");
}

test("indexes scratchpad, catalog, evaluations, and nudge digests", () => withTemp((dir) => {
  seedMemoryFiles(dir);
  const stats = indexSherpaMemory(dir, { evaluationRoot: dir });
  assert(stats.documents >= 4, `documents indexed: ${stats.documents}`);
  assertEqual(stats.scratchpadEntries, 2, "scratchpad entries");
  assertEqual(stats.catalogEntries, 1, "catalog entries");
  assertEqual(stats.evaluations, 1, "evaluations");
  assertEqual(stats.dedupHashes, 1, "dedup hashes");
  assert(stats.sourcePaths >= 3, "source paths counted");
  assert(stats.kindCounts.some((k) => k.kind.startsWith("scratchpad")), "kind counts include scratchpad");
  assert(Boolean(stats.lastIndexedAt), "last indexed timestamp set");
}));

test("searches indexed scratchpad and catalog content", () => withTemp((dir) => {
  seedMemoryFiles(dir);
  indexSherpaMemory(dir, { evaluationRoot: dir });
  const scratchpadResults = searchSherpaMemory(dir, "SQLite FTS5", 10);
  assert(scratchpadResults.some((r) => r.kind.startsWith("scratchpad")), "finds scratchpad result");
  const catalogResults = searchSherpaMemory(dir, "SQLite Memory Index", 10);
  assert(catalogResults.some((r) => r.kind.startsWith("catalog")), "finds catalog result");

  const evalResults = searchSherpaMemory(dir, "prefer memory index", 10);
  assert(evalResults.some((r) => r.kind === "evaluation"), "finds evaluation result");
}));

test("reindex is idempotent", () => withTemp((dir) => {
  seedMemoryFiles(dir);
  const first = indexSherpaMemory(dir, { evaluationRoot: dir });
  const second = indexSherpaMemory(dir, { evaluationRoot: dir });
  assertEqual(second.documents, first.documents, "documents stable after reindex");
  assertEqual(second.scratchpadEntries, first.scratchpadEntries, "scratchpad stable after reindex");
}));

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
