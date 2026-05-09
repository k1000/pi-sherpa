/**
 * Sherpa automation tests.
 * Run with: tsx tests/automation.test.ts
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutomationState, discoverRunnableAutomations, formatRunnableAutomation, parseAutomationMetadata, recordAutomationRun, updateAutomationCandidates } from "../lib/automation";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

function withRepo(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-automation-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("updateAutomationCandidates proposes project-native TypeScript automation", () => withRepo((dir) => {
  writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  const state = createAutomationState();
  const text = '{"command":"pnpm vitest run packages/foo.test.ts"}';
  assert(updateAutomationCandidates(state, text, 3, dir).length === 0, "first observation should not create candidate");
  updateAutomationCandidates(state, text, 3, dir);
  const candidates = updateAutomationCandidates(state, text, 3, dir);
  assert(candidates.length === 1, "third observation should create exactly one command candidate");
  assert(candidates[0]!.command === "pnpm vitest run packages/foo.test.ts", "third observation should create command candidate");
  assert(candidates[0]!.markdown.includes("scripts/*.ts"), "should prefer TypeScript scripts");
}));

test("unsafe automations are not proposed", () => {
  const state = createAutomationState();
  const text = '{"command":"rm -rf node_modules"}';
  updateAutomationCandidates(state, text, 1);
  assert(updateAutomationCandidates(state, text, 1).length === 0, "unsafe command should be ignored");
});

test("discoverRunnableAutomations lists package and repo scripts", () => withRepo((dir) => {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", deploy: "git push origin main" } }));
  mkdirSync(path.join(dir, "scripts"));
  writeFileSync(path.join(dir, "scripts", "check.ts"), "console.log('ok')");
  writeFileSync(path.join(dir, "scripts", "check.py"), "print('ok')");
  const automations = discoverRunnableAutomations(dir);
  assert(automations.some((item) => item.name === "typecheck" && item.command === "pnpm run typecheck"), "missing package script");
  assert(automations.some((item) => item.name === "scripts/check.ts" && item.command.includes("tsx")), "missing ts script");
  assert(automations.some((item) => item.name === "scripts/check.py" && item.command.includes("python3")), "missing python script");
  assert(automations.find((item) => item.name === "deploy")?.safety === "needs-approval", "deploy should need approval");
}));

test("python projects prefer Python automation", () => withRepo((dir) => {
  writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname='demo'\n");
  const state = createAutomationState();
  const text = '{"command":"pytest tests/test_demo.py"}';
  const candidates = updateAutomationCandidates(state, text, 1, dir);
  assert(candidates.length === 1, "expected candidate");
  assert(candidates[0]!.markdown.includes("scripts/*.py"), "should prefer Python scripts");
}));

test("script metadata controls purpose, timeout, env, and side effects", () => {
  const metadata = parseAutomationMetadata(`/**\n * @sherpa-purpose Check workers\n * @sherpa-timeout 45000\n * @sherpa-env POSTGRES_URI NODE_ENV\n * @sherpa-side-effects none\n * @sherpa-safe true\n */`);
  assert(metadata.purpose === "Check workers", "wrong purpose");
  assert(metadata.timeoutMs === 45000, "wrong timeout");
  assert(metadata.requiredEnv?.includes("POSTGRES_URI"), "missing env");
  assert(metadata.sideEffects === "none", "wrong side effects");
  assert(metadata.safety === "safe", "wrong safety");
});

test("automation run telemetry records outcomes", () => {
  const state = createAutomationState();
  const automation = { name: "check", kind: "repo-script" as const, command: "node scripts/check.js", cwd: process.cwd(), safety: "safe" as const };
  recordAutomationRun(state, automation, "passed", 12);
  recordAutomationRun(state, automation, "failed", 7, "boom");
  assert(state.runStats.check?.runs === 2, "wrong run count");
  assert(state.runStats.check?.failures === 1, "wrong failure count");
  assert(formatRunnableAutomation(automation, state.runStats.check).includes("runs=2"), "format missing stats");
});

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
