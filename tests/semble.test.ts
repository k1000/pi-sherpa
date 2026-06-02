/**
 * Sherpa Semble CLI integration tests.
 * Run with: tsx tests/semble.test.ts
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSembleSearchOutput, readSembleState, writeSembleState } from "../lib/semble";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

test("parseSembleSearchOutput parses markdown results", () => {
  const results = parseSembleSearchOutput(`Search results for: 'auth flow' (mode=hybrid)

## 1. src/auth.ts:10-24  [score=0.123]
\`\`\`ts
export function authenticate(user: User) {
  return verify(user.token);
}
\`\`\`

## 2. tests/auth.test.ts:5-8  [score=0.045]
\`\`\`ts
it("authenticates users", () => {});
\`\`\`
`);
  assert(results.length === 2, `expected 2 results, got ${results.length}`);
  assert(results[0]!.filePath === "src/auth.ts", "expected first file path");
  assert(results[0]!.startLine === 10 && results[0]!.endLine === 24, "expected line range");
  assert(results[0]!.score === 0.123, "expected parsed score");
  assert(results[0]!.content.includes("authenticate"), "expected code content");
});

test("parseSembleSearchOutput ignores malformed or empty blocks", () => {
  const results = parseSembleSearchOutput(`## 1. src/empty.ts:1-2  [score=0.1]
\`\`\`ts

\`\`\`

not a result
`);
  assert(results.length === 0, `expected no results, got ${results.length}`);
});

test("Semble state is persisted under .pi/sherpa", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-semble-state-"));
  try {
    writeSembleState(root, { lastHead: "abc123", lastCheckedAt: "2026-05-19T00:00:00.000Z", lastResultCount: 2 });
    const raw = readFileSync(path.join(root, ".pi", "sherpa", "semble-state.json"), "utf8");
    assert(raw.includes("abc123"), "expected state file to contain head");
    const state = readSembleState(root);
    assert(state.lastHead === "abc123", "expected persisted head");
    assert(state.lastResultCount === 2, "expected persisted result count");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
