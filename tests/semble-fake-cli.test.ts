import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchSemble, readSembleState, isUnsafeBroadSembleRoot } from "../lib/semble";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

const fakeSearchOutput = `Search results for: 'source routing' (mode=hybrid)

## 1. src/router.ts:4-8  [score=0.91]
\`\`\`ts
export function routeSourcePlan() { return ["files", "semble"]; }
\`\`\`

## 2. src/memory.ts:12-18  [score=0.72]
\`\`\`ts
export function queryEmbedding() { return "chunk.embedding"; }
\`\`\``;

test("searchSemble works with a fake CLI and persists HEAD-aware state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-semble-fake-"));
  const fake = path.join(root, "fake-semble.mjs");
  try {
    writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "search") process.exit(2);
if (!args.includes("--top-k")) process.exit(3);
process.stdout.write(${JSON.stringify(fakeSearchOutput)});
`);
    chmodSync(fake, 0o755);
    const results = await searchSemble(root, "source routing", { enabled: true, command: fake, topK: 2, timeoutMs: 2000 });
    assert(results.length === 2, `expected 2 fake CLI results, got ${results.length}`);
    assert(results[0]!.filePath === "src/router.ts", "expected first fake result file");
    assert(results[0]!.content.includes("routeSourcePlan"), "expected first fake result content");
    const state = readSembleState(root);
    assert(typeof state.lastCheckedAt === "string" && state.lastCheckedAt.length > 0, "expected state timestamp");
    assert(state.lastResultCount === 2, `expected lastResultCount=2, got ${state.lastResultCount}`);
    assert(!state.lastError, `did not expect lastError, got ${state.lastError}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe broad roots are detected before invoking Semble", () => {
  assert(isUnsafeBroadSembleRoot(os.homedir()), "expected home directory to be unsafe");
  assert(isUnsafeBroadSembleRoot(path.parse(os.homedir()).root), "expected filesystem root to be unsafe");
  assert(!isUnsafeBroadSembleRoot(path.join(os.homedir(), "Development", "example-project")), "expected nested project path to be safe");
});

test("searchSemble records failure state and returns empty results", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-semble-fail-"));
  const fake = path.join(root, "fake-semble-fail.mjs");
  try {
    writeFileSync(fake, `#!/usr/bin/env node
console.error("semantic index unavailable");
process.exit(7);
`);
    chmodSync(fake, 0o755);
    const results = await searchSemble(root, "source routing", { enabled: true, command: fake, topK: 2, timeoutMs: 2000 });
    assert(results.length === 0, `expected empty results on CLI failure, got ${results.length}`);
    const raw = readFileSync(path.join(root, ".pi", "sherpa", "semble-state.json"), "utf8");
    const state = readSembleState(root);
    assert(state.lastResultCount === 0, "expected lastResultCount=0 on failure");
    assert(typeof state.lastError === "string" && state.lastError.length > 0, "expected persisted lastError");
    assert(raw.includes("lastError"), "expected raw state to include lastError");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
