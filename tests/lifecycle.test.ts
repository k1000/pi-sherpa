/**
 * Sherpa lifecycle tests.
 * Run with: tsx tests/lifecycle.test.ts
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { postProcessCandidates } from "../index";
import { classifyTaskOutcome, compactScratchpad, compactScratchpadLifecycle, computeLifecycleStage, suggestVerificationCommands } from "../lib/lifecycle";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-lifecycle-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("classifyTaskOutcome detects core outcomes", () => {
  assert(classifyTaskOutcome("implemented and verified, tests passed").outcome === "completed", "expected completed");
  assert(classifyTaskOutcome("Results: 42 passed, 0 failed").outcome === "completed", "zero failed test summary should not be failure");
  assert(classifyTaskOutcome("blocked waiting on approval").outcome === "blocked", "expected blocked");
  assert(classifyTaskOutcome("typecheck failed with error").outcome === "failed", "expected failed");
  assert(classifyTaskOutcome("Frontend error logs showed a cascade. Fixed the retry loop and verified: bun test src/server/frontend.test.ts -> 48 pass").outcome === "completed", "fixed error logs with passing tests should be completed");
  assert(classifyTaskOutcome("rolled back discarded changes").outcome === "reverted", "expected reverted");
});

test("suggestVerificationCommands maps changed files to checks", () => {
  const advice = suggestVerificationCommands([
    "apps/workers/src/index.ts",
    "packages/shared/src/db/drizzle/schema/foo.ts",
    "catalog.csv",
  ]);
  assert(advice.commands.some((item) => item.command === "pnpm typecheck"), "missing TS typecheck");
  assert(advice.commands.some((item) => item.command === "pnpm --filter workers typecheck"), "missing workers typecheck");
  assert(advice.commands.some((item) => item.command === "pnpm db:generate"), "missing db generate");
  assert(advice.catalogReview, "expected catalog review");
});

test("suggestVerificationCommands recommends focused frontend checks", () => {
  const advice = suggestVerificationCommands(["src/server/public/client.js"]);
  assert(advice.commands.some((item) => item.command === "bun test src/server/frontend.test.ts"), "missing HyperPod frontend test");
});

test("computeLifecycleStage classifies active, fading, archived, defaults, and high-confidence immunity", () => {
  const now = Date.parse("2026-07-13T00:00:00.000Z");
  const daysAgo = (days: number) => now - days * 24 * 60 * 60 * 1000;
  assert(computeLifecycleStage(daysAgo(1), 3, now) === "active", "recent memories should be active");
  assert(computeLifecycleStage(daysAgo(31), 3, now) === "fading", "31 day old memories should be fading");
  assert(computeLifecycleStage(daysAgo(61), 3, now) === "archived", "61 day old memories should be archived");
  assert(computeLifecycleStage(daysAgo(365), 8, now) === "active", "high confidence memories should be immune");
  assert(computeLifecycleStage(undefined, undefined, now) === "active", "missing timestamp should default active");
});

test("postProcessCandidates filters archived items and downranks fading items", () => {
  const now = Date.parse("2026-07-13T00:00:00.000Z");
  const daysAgo = (days: number) => now - days * 24 * 60 * 60 * 1000;
  const active = { handle: "ctx-active", type: "project_memory", source: "kb://memory/active.md", relevance: 0.4, summary: "remember routing pattern", raw: "remember routing pattern", lastAccessedAt: daysAgo(1), confidence: 3 };
  const fading = { handle: "ctx-fading", type: "project_memory", source: "kb://memory/fading.md", relevance: 0.8, summary: "remember routing pattern", raw: "remember routing pattern", lastAccessedAt: daysAgo(31), confidence: 3 };
  const archived = { handle: "ctx-archived", type: "project_memory", source: "kb://memory/archived.md", relevance: 0.95, summary: "remember routing pattern", raw: "remember routing pattern", lastAccessedAt: daysAgo(61), confidence: 3 };
  const compat = { handle: "ctx-compat", type: "project_memory", source: "kb://memory/compat.md", relevance: 0.3, summary: "remember routing pattern", raw: "remember routing pattern" };
  const actual = postProcessCandidates([fading, archived, active, compat], "remember routing pattern", "explicit", now).map((item) => item.source);
  assert(!actual.includes("kb://memory/archived.md"), "archived item should be filtered");
  assert(actual.includes("kb://memory/compat.md"), "missing lifecycle fields should remain active-compatible");
  assert(actual.indexOf("kb://memory/active.md") < actual.indexOf("kb://memory/fading.md"), "fading item should rank below active despite higher base relevance");
});

test("compactScratchpadLifecycle moves archived entries and protects high-confidence entries", () => withTemp((dir) => {
  const now = Date.parse("2026-07-13T00:00:00.000Z");
  const sections = path.join(dir, "sections");
  mkdirSync(sections, { recursive: true });
  writeFileSync(path.join(sections, "todo.md"), [
    "### stale — 2026-04-01T00:00:00.000Z",
    "",
    "old note\nconfidence: 3",
    "",
    "### protected — 2026-04-01T00:00:00.000Z",
    "",
    "important note\nconfidence: 9",
    "",
    "### recent — 2026-07-01T00:00:00.000Z",
    "",
    "recent note",
    "",
  ].join("\n"));
  const result = compactScratchpadLifecycle(dir, { now });
  assert(result.archived.includes("todo.md"), "expected lifecycle archive");
  const remaining = readFileSync(path.join(sections, "todo.md"), "utf8");
  const archived = readFileSync(path.join(dir, ".archived", "todo.md"), "utf8");
  assert(archived.includes("old note"), "stale low-confidence entry should move to archive");
  assert(!remaining.includes("old note"), "stale entry should be removed from active section");
  assert(remaining.includes("important note"), "high-confidence stale entry should remain active");
  assert(remaining.includes("recent note"), "recent entry should remain active");
}));

test("compactScratchpad archives large sections", () => withTemp((dir) => {
  const sections = path.join(dir, "sections");
  mkdirSync(sections, { recursive: true });
  writeFileSync(path.join(sections, "todo.md"), "x".repeat(200));
  const result = compactScratchpad(dir, { maxBytes: 100 });
  assert(result.compacted.includes("todo.md"), "expected compaction");
  assert(existsSync(path.join(dir, "archive")), "missing archive");
  assert(readFileSync(path.join(sections, "todo.md"), "utf8").includes("compacted"), "missing compacted header");
}));

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
