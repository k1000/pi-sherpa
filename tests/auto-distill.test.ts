/**
 * Auto-Distillation tests.
 * Run with: bun tests/auto-distill.test.ts
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkAutoDistill,
  prepareDistillPayloads,
  getAutoDistillStatus,
  markAutoDistillRun,
  type DistillTrigger,
  type AutoDistillConfig,
} from "../lib/auto-distill";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function assertEqual(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-distill-"));
  mkdirSync(path.join(dir, "sections"), { recursive: true });
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function makeConfig(dir: string, overrides?: Partial<AutoDistillConfig>): AutoDistillConfig {
  return { scratchpadRoot: dir, minChangedFiles: 3, enabled: true, ...overrides };
}

function makeTrigger(overrides?: Partial<DistillTrigger>): DistillTrigger {
  return { outcome: "completed", changedFiles: 5, hasDistillCandidates: true, ...overrides };
}

function writeDistillCandidates(dir: string, count: number) {
  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(
      `### Distill entry ${i + 1}\n\nThis is distill candidate number ${i + 1} with some procedural knowledge about TypeScript configuration.`
    );
  }
  writeFileSync(
    path.join(dir, "sections", "distill_candidate.md"),
    `# distill_candidate\n\n${entries.join("\n\n")}\n`,
    "utf8"
  );
}

test("triggers on completed task with sufficient changed files and candidates", () => withTemp((dir) => {
  writeDistillCandidates(dir, 2);
  const result = checkAutoDistill(makeTrigger(), makeConfig(dir));
  assert(result.shouldTrigger, "should trigger auto-distill");
  assert(result.newCandidates.length >= 2, `should find at least 2 candidates (found ${result.newCandidates.length})`);
  assert(result.reason.includes("completed"), "reason mentions completion");
}));

test("does not trigger when disabled", () => withTemp((dir) => {
  writeDistillCandidates(dir, 2);
  const result = checkAutoDistill(makeTrigger(), makeConfig(dir, { enabled: false }));
  assert(!result.shouldTrigger, "should not trigger when disabled");
}));

test("does not trigger when outcome is not completed", () => withTemp((dir) => {
  writeDistillCandidates(dir, 2);
  const result = checkAutoDistill(
    makeTrigger({ outcome: "failed" }),
    makeConfig(dir)
  );
  assert(!result.shouldTrigger, "should not trigger on failed");
  assert(result.reason.includes("failed"), "reason mentions failed");
}));

test("does not trigger when file changes are below threshold", () => withTemp((dir) => {
  writeDistillCandidates(dir, 2);
  const result = checkAutoDistill(
    makeTrigger({ changedFiles: 1 }),
    makeConfig(dir)
  );
  assert(!result.shouldTrigger, "should not trigger with 1 changed file");
  assert(result.reason.includes("1"), "reason mentions file count");
}));

test("does not trigger without distill candidates", () => withTemp((dir) => {
  // No distill candidate file written
  const result = checkAutoDistill(makeTrigger(), makeConfig(dir));
  assert(!result.shouldTrigger, "should not trigger without candidates");
  assert(result.reason.includes("candidate"), "reason mentions candidates");
}));

test("respects suppress marker file", () => withTemp((dir) => {
  writeDistillCandidates(dir, 2);
  writeFileSync(path.join(dir, ".auto-distill-mode"), "AUTO_DISTILL_OFF", "utf8");
  const result = checkAutoDistill(makeTrigger(), makeConfig(dir));
  assert(!result.shouldTrigger, "should be suppressed");
  assert(result.reason.includes("suppressed"), "reason mentions suppression");
}));

test("prepareDistillPayloads extracts correct fields", () => withTemp((dir) => {
  writeDistillCandidates(dir, 2);
  const check = checkAutoDistill(makeTrigger(), makeConfig(dir));
  assert(check.shouldTrigger, "should trigger");

  const payloads = prepareDistillPayloads(check.newCandidates);
  assert(payloads.length >= 2, `at least 2 payloads (got ${payloads.length})`);
  const hasDistillEntry = payloads.some((p) => p.task.includes("Distill entry"));
  assert(hasDistillEntry, "at least one payload has a distill entry title");
  const hasAutoDistillTrigger = payloads.some((p) => p.trigger === "auto-distill");
  assert(hasAutoDistillTrigger, "at least one payload has auto-distill trigger");
  const hasDomain = payloads.some((p) => p.domain.length > 0);
  assert(hasDomain, "domain should be detected");
}));

test("getAutoDistillStatus returns current state", () => withTemp((dir) => {
  writeDistillCandidates(dir, 1);
  const status = getAutoDistillStatus(makeConfig(dir));
  assert(status.enabled, "should be enabled");
  assert(!status.suppressed, "should not be suppressed");
  assertEqual(status.minChangedFiles, 3, "min 3 files");
  assert(status.lastRun === null, "no previous run");
  assert(status.candidateCount >= 1, "at least 1 candidate");
}));

test("getAutoDistillStatus detects suppression", () => withTemp((dir) => {
  writeFileSync(path.join(dir, ".auto-distill-mode"), "AUTO_DISTILL_OFF", "utf8");
  const status = getAutoDistillStatus(makeConfig(dir));
  assert(status.suppressed, "should detect suppression");
}));

test("markAutoDistillRun prevents immediate retrigger", () => withTemp((dir) => {
  writeDistillCandidates(dir, 2);
  const first = checkAutoDistill(makeTrigger(), makeConfig(dir));
  assert(first.shouldTrigger, "first check should trigger");
  markAutoDistillRun(dir);
  const second = checkAutoDistill(makeTrigger(), makeConfig(dir));
  assert(!second.shouldTrigger, "second check should not retrigger same candidates");
}));

// ── Run ──
for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
