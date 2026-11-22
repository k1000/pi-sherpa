/**
 * Sherpa Semble CLI integration tests.
 * Run with: tsx tests/semble.test.ts
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSembleSearchOutput, readSembleState, writeSembleState } from "../lib/semble";
import { addInquirerCandidates } from "../lib/basic-candidate-sources";
import { MemoryApiStore } from "../../archivist/lib/memory-api";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
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

test("Inquirer candidates return empty for missing config", async () => {
  const added: unknown[] = [];
  await addInquirerCandidates(undefined, "remember source routing", (...args) => added.push(args));
  assert(added.length === 0, `expected no candidates, got ${added.length}`);
});

test("Inquirer candidates return empty when API search fails", async () => {
  const original = MemoryApiStore.prototype.search;
  try {
    MemoryApiStore.prototype.search = async function () { throw new Error("network unavailable"); };
    const added: unknown[] = [];
    await addInquirerCandidates({ enabled: true, url: "http://localhost:3000", searchLimit: 3 }, "remember source routing", (...args) => added.push(args));
    assert(added.length === 0, `expected no candidates on API failure, got ${added.length}`);
  } finally {
    MemoryApiStore.prototype.search = original;
  }
});

test("Inquirer vector search results become memory candidates", async () => {
  const original = MemoryApiStore.prototype.search;
  try {
    MemoryApiStore.prototype.search = async function (query: { text: string; limit?: number }) {
      assert(query.text === "remember source routing", "expected focus text to be searched");
      assert(query.limit === 3, "expected configured search limit");
      return [{ artifact: { id: "artifact-1", title: "Routing lesson", summary: "Use source plans for retrieval." }, score: 0.82 }];
    };
    const added: Array<{ type: string; source: string; raw: string; relBoost?: number }> = [];
    await addInquirerCandidates({ enabled: true, url: "http://localhost:3000", searchLimit: 3, tokenEnv: "MEMORY_API_TOKEN" }, "remember source routing", (type, source, raw, relBoost) => added.push({ type, source, raw, relBoost }));
    assert(added.length === 1, `expected one candidate, got ${added.length}`);
    assert(added[0]!.type === "inquirer_memory", "expected inquirer memory type");
    assert(added[0]!.source === "inquirer_memory://artifact-1", "expected stable inquirer source label");
    assert(added[0]!.raw.includes("Routing lesson"), "expected artifact title in raw text");
    assert(added[0]!.relBoost === 0.82, "expected relevance from vector score");
  } finally {
    MemoryApiStore.prototype.search = original;
  }
});

for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
