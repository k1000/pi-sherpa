import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { explicitPathCandidates, readExplicitSource } from "../lib/exact-source";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-exact-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("explicitPathCandidates ignores system binaries from shell output", () => withTemp((dir) => {
  const candidates = explicitPathCandidates("/bin/bash: line 1: 40043 Killed: 9 bun src/server/index.ts", dir);
  assert.ok(!candidates.includes("/bin/bash"), "should not include /bin/bash");
}));

test("readExplicitSource skips binary files", () => withTemp((dir) => {
  const binary = path.join(dir, "binary.bin");
  writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  assert.equal(readExplicitSource(binary), undefined);
}));

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
