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
  const slug = distillSlug("Experiment proof: task-level Sherpa distillation creates an Obsidian project skill");
  assert(slug.length <= 60, "slug too long");
  assert(!slug.endsWith("-"), "slug should not end with separator after truncation");
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

test("recognized research domains route to shared research memory", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = buildDistilledSkill({ trigger: "pattern", task: "TypeScript routing lesson", outcome: "Reusable TypeScript lessons should route to shared research memory.", domain: "TypeScript" }, cwd, obsidian);
  assert(result.destination === "research", "expected research destination");
  assert(result.skillPath.startsWith(path.join(dir, "obsidian", "projects", "research", "typescript")), "expected shared research area path");
}));

test("research domain routing normalizes spaces and preserves nested areas", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const spaced = buildDistilledSkill({ trigger: "pattern", task: "Software engineering lesson", outcome: "Software engineering domains should normalize to a hyphenated research area.", domain: "Software Engineering" }, cwd, obsidian);
  const nested = buildDistilledSkill({ trigger: "pattern", task: "Grid trading lesson", outcome: "Nested trading domains should stay under the trading research area.", domain: "trading/grid" }, cwd, obsidian);
  assert(spaced.destination === "research", "expected spaced domain to route to research");
  assert(spaced.skillPath.startsWith(path.join(dir, "obsidian", "projects", "research", "software-engineering")), "expected normalized software-engineering area path");
  assert(nested.destination === "research", "expected nested trading domain to route to research");
  assert(nested.skillPath.startsWith(path.join(dir, "obsidian", "projects", "research", "trading", "grid")), "expected nested trading area path");
}));

test("unrecognized domains stay in project Obsidian memory", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = buildDistilledSkill({ trigger: "pattern", task: "Project-specific lesson", outcome: "Project-specific domains should stay in the project semantic wiki.", domain: "demo-app" }, cwd, obsidian);
  assert(result.destination === "obsidian", "expected project Obsidian destination");
  assert(result.skillPath.startsWith(path.join(obsidian, "wiki", "procedures")), "expected project procedure path");
}));

test("explicit relative targetPath is resolved from cwd", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = buildDistilledSkill({ trigger: "pattern", task: "Compat lesson", outcome: "Explicit targetPath should be respected.", targetPath: ".pi-memory/.l3_skills/compat.md" }, cwd, obsidian);
  assert(result.destination === "explicit", "expected explicit destination");
  assert(result.skillPath === path.join(cwd, ".pi-memory/.l3_skills/compat.md"), "wrong explicit relative path");
}));

test("explicit absolute targetPath is preserved exactly", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const targetPath = path.join(dir, "custom", "lesson.md");
  const result = buildDistilledSkill({ trigger: "pattern", task: "Absolute target lesson", outcome: "Absolute targetPath should not be rewritten.", targetPath }, cwd, obsidian);
  assert(result.destination === "explicit", "expected explicit destination");
  assert(result.skillPath === targetPath, "wrong explicit absolute path");
}));

test("explicit targetPath wins over research domain routing", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = buildDistilledSkill({ trigger: "pattern", task: "Explicit TypeScript lesson", outcome: "Explicit targetPath should override domain routing.", domain: "typescript", targetPath: "docs/lesson.md" }, cwd, obsidian);
  assert(result.destination === "explicit", "expected explicit destination");
  assert(result.skillPath === path.join(cwd, "docs", "lesson.md"), "explicit path should win over research domain");
}));

test("writeDistilledSkill creates parent directories for explicit targets", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = writeDistilledSkill({ trigger: "pattern", task: "Nested explicit lesson", outcome: "Explicit target writes should create missing parent directories.", targetPath: "docs/nested/lesson.md" }, cwd, obsidian);
  assert(result.destination === "explicit", "expected explicit destination");
  assert(result.skillPath === path.join(cwd, "docs", "nested", "lesson.md"), "wrong explicit nested path");
  assert(existsSync(result.skillPath), "explicit target file missing");
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

test("writeDistilledSkill includes optional evidence context", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = writeDistilledSkill({ trigger: "success", task: "Context-backed lesson", outcome: "Distillation should preserve concise supporting evidence.", context: "Verified by bun scripts/check-extension.ts." }, cwd, obsidian);
  assert(existsSync(result.skillPath), "skill file missing");
  const text = readFileSync(result.skillPath, "utf8");
  assert(text.includes("## Evidence / context"), "missing evidence context section");
  assert(text.includes("Verified by bun scripts/check-extension.ts."), "missing evidence context body");
}));

test("writeDistilledSkill writes research metadata for research domains", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = writeDistilledSkill({ trigger: "pattern", task: "Python research lesson", outcome: "Reusable Python lessons should include research metadata.", domain: "python" }, cwd, obsidian);
  assert(existsSync(result.skillPath), "research skill file missing");
  const text = readFileSync(result.skillPath, "utf8");
  assert(text.includes("area: python"), "missing research area frontmatter");
  assert(text.includes("category: distillation"), "missing research category frontmatter");
  assert(text.includes("Research area:** python"), "missing research area body marker");
}));

test("writeDistilledSkill keeps project artifacts free of research metadata", () => withTemp((dir) => {
  const cwd = path.join(dir, "repo");
  const obsidian = path.join(dir, "obsidian", "projects", "Demo");
  const result = writeDistilledSkill({ trigger: "pattern", task: "Project procedure lesson", outcome: "Project procedures should use semantic wiki metadata only.", domain: "demo-app" }, cwd, obsidian);
  assert(existsSync(result.skillPath), "project skill file missing");
  const text = readFileSync(result.skillPath, "utf8");
  assert(text.includes("Related: none yet"), "missing project wiki related marker");
  assert(!text.includes("category: distillation"), "project artifact should not include research category");
  assert(!text.includes("Research area:**"), "project artifact should not include research body marker");
}));

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
