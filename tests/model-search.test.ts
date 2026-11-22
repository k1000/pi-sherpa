import assert from "node:assert/strict";
import { runModelSearchLoop, type ModelStep, type SearchTool } from "../lib/model-search";

function fakeTool(name: string, results: Array<{ source: string; summary: string }>): SearchTool {
  return {
    name,
    description: `fake ${name}`,
    async run() {
      return results.map((r) => ({ ...r, relevance: 0.5 }));
    },
  };
}

/** Scripted model: returns steps in sequence, then a default. */
function scriptedModel(steps: ModelStep[]) {
  let i = 0;
  return async (): Promise<ModelStep | undefined> => steps[i++] ?? { action: "stop", reason: "script exhausted" };
}

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

test("model-driven search: search → deliver surfaces delivered items", async () => {
  const tool = fakeTool("rg", [{ source: "repo://index.ts", summary: "impl" }]);
  const steps: ModelStep[] = [
    { action: "search", tool: "rg", query: "oasis", reason: "look" },
    { action: "deliver", items: [{ source: "repo://index.ts", summary: "the impl" }], reason: "enough" },
  ];
  const result = await runModelSearchLoop({
    focus: "find oasis impl",
    tools: { rg: tool },
    modelStep: scriptedModel(steps),
  });
  assert.equal(result.delivered, true);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.rounds, 2);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, "repo://index.ts");
  assert.equal(result.stopReason, "model delivered");
});

test("model-driven search: unknown tool does not crash, loop continues", async () => {
  const steps: ModelStep[] = [
    { action: "search", tool: "nope", query: "x", reason: "miss" },
    { action: "stop", reason: "give up" },
  ];
  const result = await runModelSearchLoop({
    focus: "x",
    tools: {},
    modelStep: scriptedModel(steps),
  });
  assert.equal(result.delivered, false);
  assert.equal(result.toolCalls, 0, "unknown tool must not count as a tool call");
  assert.equal(result.stopReason, "model chose to stop, nothing gathered");
});

test("model-driven search: stop with gathered context treated as delivered", async () => {
  const tool = fakeTool("rg", [{ source: "repo://a.ts", summary: "a" }]);
  const steps: ModelStep[] = [
    { action: "search", tool: "rg", query: "x", reason: "look" },
    { action: "stop", reason: "tired" },
  ];
  const result = await runModelSearchLoop({
    focus: "x",
    tools: { rg: tool },
    modelStep: scriptedModel(steps),
  });
  assert.equal(result.delivered, true, "stop with gathered context should act as deliver");
  assert.equal(result.candidates.length, 1, "gathered candidates still surface for upstream model re-filter");
  assert.equal(result.candidates[0].source, "repo://a.ts");
  assert.equal(result.stopReason, "stop with gathered context");
});

test("model-driven search: stop without gathered context returns empty delivered=false", async () => {
  const result = await runModelSearchLoop({
    focus: "x",
    tools: {},
    modelStep: async () => ({ action: "stop", reason: "nothing found" }),
  });
  assert.equal(result.delivered, false, "empty stop should still be delivered=false");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.stopReason, "model chose to stop, nothing gathered");
});

test("model-driven search: max rounds cap terminates the loop", async () => {
  // model always searches → would loop forever without the cap
  const tool = fakeTool("rg", [{ source: "repo://a.ts", summary: "a" }]);
  const result = await runModelSearchLoop({
    focus: "x",
    tools: { rg: tool },
    modelStep: async () => ({ action: "search", tool: "rg", query: "x", reason: "again" }),
    budget: { maxRounds: 2, maxToolCalls: 10 },
  });
  assert.ok(result.rounds <= 2, `rounds ${result.rounds} must respect cap`);
  assert.equal(result.stopReason, "max rounds");
});

test("model-driven search: max tool-calls cap terminates the loop", async () => {
  const tool = fakeTool("rg", [{ source: "repo://a.ts", summary: "a" }]);
  const result = await runModelSearchLoop({
    focus: "x",
    tools: { rg: tool },
    modelStep: async () => ({ action: "search", tool: "rg", query: "x", reason: "again" }),
    budget: { maxRounds: 50, maxToolCalls: 2 },
  });
  assert.ok(result.toolCalls <= 2, `toolCalls ${result.toolCalls} must respect cap`);
  assert.equal(result.stopReason, "max tool calls");
});

test("model-driven search: dedupes repeated sources across rounds", async () => {
  const tool = fakeTool("rg", [{ source: "repo://dup.ts", summary: "same" }]);
  const steps: ModelStep[] = [
    { action: "search", tool: "rg", query: "1", reason: "a" },
    { action: "search", tool: "rg", query: "2", reason: "b" },
    { action: "deliver", items: [], reason: "done" },
  ];
  const result = await runModelSearchLoop({
    focus: "x",
    tools: { rg: tool },
    modelStep: scriptedModel(steps),
  });
  assert.equal(result.delivered, true);
  assert.equal(result.candidates.length, 1, "duplicate source must be deduped");
});

test("model-driven search: model error stops the loop safely", async () => {
  const result = await runModelSearchLoop({
    focus: "x",
    tools: {},
    modelStep: async () => { throw new Error("boom"); },
  });
  assert.equal(result.delivered, false);
  assert.equal(result.stopReason, "model step error");
  assert.equal(result.candidates.length, 0);
});

// ── Model-search tool implementation tests ────────────────────────────

import {
  MODEL_SEARCH_TOOL_MAX_RESULTS,
  makeFileFinderTool,
  makeMemorySearchTool,
} from "../lib/model-search-tools";

test("MODEL_SEARCH_TOOL_MAX_RESULTS constant is 20", () => {
  assert.equal(MODEL_SEARCH_TOOL_MAX_RESULTS, 20,
    "safety cap for model-search tool results");
});

test("makeFileFinderTool respects MAX_RESULTS cap with large limit", async () => {
  // Minimal mock ExtensionContext — only cwd is needed for pathSourceLabel
  const mockCtx = { cwd: process.cwd() } as any;
  const tool = makeFileFinderTool(mockCtx);
  // Pass a query that matches many files with an artificially large limit
  const results = await tool.run({ query: "config", limit: 1000 });
  assert.ok(
    results.length <= MODEL_SEARCH_TOOL_MAX_RESULTS,
    `expected ≤${MODEL_SEARCH_TOOL_MAX_RESULTS} results, got ${results.length}`,
  );
});

test("makeMemorySearchTool respects MAX_RESULTS cap with large limit", async () => {
  const tool = makeMemorySearchTool();
  const results = await tool.run({ query: "sherpa", limit: 1000 });
  assert.ok(
    results.length <= MODEL_SEARCH_TOOL_MAX_RESULTS,
    `expected ≤${MODEL_SEARCH_TOOL_MAX_RESULTS} results, got ${results.length}`,
  );
});

test("makeFileFinderTool returns empty for empty query", async () => {
  const mockCtx = { cwd: process.cwd() } as any;
  const tool = makeFileFinderTool(mockCtx);
  const results = await tool.run({ query: "" });
  assert.equal(results.length, 0, "empty query should return no results");
});

test("makeMemorySearchTool returns empty for empty query", async () => {
  const tool = makeMemorySearchTool();
  const results = await tool.run({ query: "" });
  assert.equal(results.length, 0, "empty query should return no results");
});

test("makeFileFinderTool caps at MAX_RESULTS even without explicit limit", async () => {
  const mockCtx = { cwd: process.cwd() } as any;
  const tool = makeFileFinderTool(mockCtx);
  const results = await tool.run({ query: "a" });
  assert.ok(
    results.length <= MODEL_SEARCH_TOOL_MAX_RESULTS,
    `default limit should cap at ${MODEL_SEARCH_TOOL_MAX_RESULTS}, got ${results.length}`,
  );
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}`); console.log(String((e as Error).message).split("\n").slice(0, 6).join("\n")); }
}
console.log(`\n${tests.length} tests: ${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
