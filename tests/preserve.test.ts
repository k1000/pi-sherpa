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

test("routeReflection routes critical process notes to Obsidian", () => {
  assert(routeReflection({ type: "process", importance: "critical", tags: [], title: "Critical process", summary: "Critical process lessons should be durable when they describe important operational decisions." }) === "obsidian", "critical process should route to Obsidian");
});

test("routeReflection respects explicit target routing", () => {
  assert(routeReflection({ type: "knowledge", importance: "high", tags: ["invariant"], title: "Targeted", summary: "Explicit target routing should preserve caller-selected project destinations.", hasTarget: true }) === "project", "explicit target should route to project destination");
});

test("evaluatePersistence discards too-brief and one-off notes", () => {
  assert(evaluatePersistence({ type: "knowledge", title: "Tiny", summary: "Too short", importance: "high", tags: [] }).decision === "discard", "brief note should discard");
  assert(evaluatePersistence({ type: "knowledge", title: "Fixed line 42", summary: "Fixed line 42 in a specific case after a local typo caused a display issue for one page only.", importance: "high", tags: [] }).decision === "discard", "one-off note should discard");
});

test("evaluatePersistence discards generic model-known knowledge", () => {
  const decision = evaluatePersistence({
    type: "knowledge",
    title: "Python list comprehension reminder",
    summary: "Python has list comprehension syntax for transforming arrays and filtering items, which is general language knowledge rather than a project-specific operating rule.",
    importance: "high",
    tags: ["general"],
  });
  assert(decision.decision === "discard", "generic language note should discard");
  assert(decision.reason.includes("Generic knowledge"), "generic discard reason should be explicit");
});

test("evaluatePersistence discards medium importance notes without structural value", () => {
  const decision = evaluatePersistence({
    type: "knowledge",
    title: "Local observation",
    summary: "The latest local run noted terminal colors during this session and gives no lasting guidance for future tasks or teams.",
    importance: "medium",
    tags: ["sherpa"],
  });
  assert(decision.decision === "discard", "medium non-structural note should discard");
  assert(decision.destination === "scratchpad", "medium non-structural note should remain scratchpad-level");
});

test("evaluatePersistence discards high-importance notes with only generic tags", () => {
  const decision = evaluatePersistence({
    type: "knowledge",
    title: "Broad coding note",
    summary: "A broad note about everyday development habits and editor preferences that lacks concrete project context or durable guidance for later work.",
    importance: "high",
    tags: ["general", "coding"],
  });
  assert(decision.decision === "discard", "generic-tag note should discard");
  assert(decision.reason.includes("Tags too generic"), "generic-tag discard reason should be explicit");
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

test("evaluatePersistence preserves explicit target structural lessons to project", () => {
  const decision = evaluatePersistence({
    type: "knowledge",
    title: "Explicit preservation target invariant",
    summary: "Durable preservation with an explicit target must respect the caller-selected project destination and should not silently reroute the lesson to a different memory home.",
    importance: "high",
    tags: ["sherpa", "invariant"],
    hasTarget: true,
  });
  assert(decision.decision === "persist", "explicit target structural lesson should persist");
  assert(decision.destination === "project", "explicit target structural lesson should route to project");
  assert(decision.confidence === "high", "explicit target structural lesson should keep high confidence");
});

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
