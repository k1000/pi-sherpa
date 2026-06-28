/**
 * Conditional Source Activation tests.
 * Run with: bun tests/conditional-source.test.ts
 */

import {
  evaluateSource,
  filterActiveSources,
  listSourceStatus,
  type ConditionalSource,
  type ActivationContext,
} from "../lib/conditional-source";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function assertEqual(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const allEnabled: ActivationContext = {
  taskType: "refactor",
  query: "How does the error pipeline work?",
  enabledSources: new Set(["files", "git", "docs", "session", "semble", "graphify", "project_memory", "web", "logs"]),
};

test("source without conditions is always active when enabled", () => {
  const source: ConditionalSource = { id: "files", label: "Source files" };
  assertEqual(evaluateSource(source, allEnabled), "active", "files should be active");
});

test("source is skipped when not in enabled set", () => {
  const source: ConditionalSource = { id: "web", label: "Web" };
  const ctx: ActivationContext = { enabledSources: new Set(["files", "git"]) };
  assertEqual(evaluateSource(source, ctx), "skipped", "web should be skipped");
});

test("taskType condition filters correctly", () => {
  const source: ConditionalSource = {
    id: "logs", label: "Log files",
    when: { taskType: ["debug", "investigate"] },
  };
  const debugCtx: ActivationContext = { ...allEnabled, taskType: "debug" };
  const refactorCtx: ActivationContext = { ...allEnabled, taskType: "refactor" };
  assertEqual(evaluateSource(source, debugCtx), "active", "logs active for debug");
  assertEqual(evaluateSource(source, refactorCtx), "inactive", "logs inactive for refactor");
});

test("queryPattern condition matches", () => {
  const source: ConditionalSource = {
    id: "web", label: "Web",
    when: { queryPattern: ["search", "find", "latest"] },
  };
  const searchCtx: ActivationContext = { ...allEnabled, query: "Find the latest news" };
  const codeCtx: ActivationContext = { ...allEnabled, query: "How is the error handler wired?" };
  assertEqual(evaluateSource(source, searchCtx), "active", "web active for search query");
  assertEqual(evaluateSource(source, codeCtx), "inactive", "web inactive for code query");
});

test("requireSources condition (AND)", () => {
  const source: ConditionalSource = {
    id: "semantic_memory", label: "Semantic memory",
    when: { requireSources: ["project_memory"] },
  };
  const withBoth: ActivationContext = { ...allEnabled, enabledSources: new Set(["project_memory", "semantic_memory"]) };
  const withoutProj: ActivationContext = { ...allEnabled, enabledSources: new Set(["semantic_memory"]) };
  assertEqual(evaluateSource(source, withBoth), "active", "active when required source present");
  assertEqual(evaluateSource(source, withoutProj), "inactive", "inactive when required source missing");
});

test("excludeWhenSources implements fallback pattern", () => {
  const fallbackSource: ConditionalSource = {
    id: "duckduckgo", label: "DuckDuckGo",
    when: { excludeWhenSources: ["web"] },
  };
  const withWeb: ActivationContext = { ...allEnabled, enabledSources: new Set(["web", "duckduckgo"]) };
  const withoutWeb: ActivationContext = { ...allEnabled, enabledSources: new Set(["files", "duckduckgo"]) };
  assertEqual(evaluateSource(fallbackSource, withWeb), "inactive", "fallback hidden when web available");
  assertEqual(evaluateSource(fallbackSource, withoutWeb), "active", "fallback shown when web unavailable");
});

test("filterActiveSources filters correctly", () => {
  const result = filterActiveSources(
    ["files", "logs", "semble"],
    { taskType: "refactor", query: "error in the handler", enabledSources: new Set(["files", "logs", "semble"]) },
  );
  assert(result.includes("files"), "files always passes");
  // logs requires taskType debug/investigate/diagnose, filtered out with refactor
  assert(result.includes("semble"), "semble passes with refactor taskType");
});

test("listSourceStatus returns all source statuses", () => {
  const statusList = listSourceStatus(allEnabled);
  const allIds = statusList.map((s) => s.id);
  assert(allIds.includes("files"), "files in status list");
  assert(allIds.includes("web"), "web in status list");
  assert(allIds.includes("graphify"), "graphify in status list");
});

// ── Run ──
for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
