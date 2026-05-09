/**
 * Sherpa distillation tests.
 * Run with: tsx tests/distillation.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDistilledSkill, distillSlug, writeDistilledSkill } from "../lib/distillation";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-distillation-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("distillSlug creates stable bounded slugs", () => {
  assert(distillSlug("Experiment proof: task-level Sherpa distillation creates an Obsidian project skill").length <= 60, "slug too long");
  assert(distillSlug("!!!") === "distilled-sherpa-lesson", "empty slug fallback failed");
});

test("default distillation target is Obsidian project memory", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = buildDistilledSkill({ trigger: "pattern", task: "Durable task lesson", outcome: "Sherpa should preserve durable memory in Obsidian." }, cwd, obsidian);
  assert(result.destination === "obsidian", "expected obsidian destination");
  assert(result.skillPath.startsWith(path.join(obsidian, "wiki", "procedures")), "expected procedure under Obsidian semantic wiki");
  assert(!result.skillPath.includes(".pi-memory"), "should not write to .pi-memory by default");
}));

test("explicit targetPath is respected for compatibility output", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = buildDistilledSkill({ trigger: "pattern", task: "Compat lesson", outcome: "Explicit targetPath should be respected.", targetPath: ".pi-memory/.l3_skills/compat.md" }, cwd, obsidian);
  assert(result.destination === "explicit", "expected explicit destination");
  assert(result.skillPath === path.join(cwd, ".pi-memory/.l3_skills/compat.md"), "wrong explicit path");
}));

test("writeDistilledSkill writes markdown proof artifact", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = writeDistilledSkill({ trigger: "success", task: "Session distillation proof", outcome: "Lifecycle session distillation writes durable Markdown." }, cwd, obsidian);
  assert(existsSync(result.skillPath), "skill file missing");
  const text = readFileSync(result.skillPath, "utf8");
  assert(text.includes("## Current truth"), "missing current truth section");
  assert(text.includes("Lifecycle session distillation"), "missing outcome");
}));

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
