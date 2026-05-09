/**
 * Sherpa preserve decision tests.
 * Run with: tsx tests/preserve.test.ts
 */

import { evaluatePersistence, routeReflection } from "../lib/preserve";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

test("routeReflection defaults durable knowledge to Obsidian", () => {
  assert(routeReflection({ type: "knowledge", importance: "medium", tags: ["sherpa"], title: "Durable", summary: "Durable memory should use Obsidian." }) === "obsidian", "knowledge should default to Obsidian");
  assert(routeReflection({ type: "automation", importance: "medium", tags: ["automation"], title: "Auto", summary: "Automation lessons should be durable skills." }) === "obsidian", "automation should default to Obsidian");
});

test("routeReflection keeps non-critical process notes in scratchpad", () => {
  assert(routeReflection({ type: "process", importance: "medium", tags: [], title: "Process", summary: "Temporary process note." }) === "scratchpad", "process should go to scratchpad");
});

test("evaluatePersistence discards too-brief and one-off notes", () => {
  assert(evaluatePersistence({ type: "knowledge", title: "Tiny", summary: "Too short", importance: "high", tags: [] }).decision === "discard", "brief note should discard");
  assert(evaluatePersistence({ type: "knowledge", title: "Fixed line 42", summary: "Fixed line 42 in a specific case after a local typo caused a display issue for one page only.", importance: "high", tags: [] }).decision === "discard", "one-off note should discard");
});

test("evaluatePersistence preserves structural lessons to Obsidian", () => {
  const decision = evaluatePersistence({
    type: "knowledge",
    title: "Sherpa memory routing invariant",
    summary: "Durable Sherpa memory must route to Obsidian project memory by default and should never use repo-local compatibility folders unless explicit targetPath requests it.",
    importance: "high",
    tags: ["sherpa", "invariant"],
  });
  assert(decision.decision === "persist", "structural lesson should persist");
  assert(decision.destination === "obsidian", "structural lesson should route to Obsidian");
  assert(decision.confidence === "high", "structural high importance should be high confidence");
});

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
