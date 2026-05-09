/**
 * Sherpa lifecycle tests.
 * Run with: tsx tests/lifecycle.test.ts
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyTaskOutcome, compactScratchpad, suggestVerificationCommands } from "../lib/lifecycle";

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
  assert(classifyTaskOutcome("rolled back discarded changes").outcome === "reverted", "expected reverted");
});

test("suggestVerificationCommands maps changed files to checks", () => {
  const advice = suggestVerificationCommands([
    "apps/workers/src/index.ts",
    "packages/shared/src/db/drizzle/schema/foo.ts",
    "routes.csv",
  ]);
  assert(advice.commands.some((item) => item.command === "pnpm typecheck"), "missing TS typecheck");
  assert(advice.commands.some((item) => item.command === "pnpm --filter workers typecheck"), "missing workers typecheck");
  assert(advice.commands.some((item) => item.command === "pnpm db:generate"), "missing db generate");
  assert(advice.routesReview, "expected route review");
});

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
