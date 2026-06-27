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
  assert.equal(result.stopReason, "model chose to stop");
});

test("model-driven search: gathered candidates returned when model never delivers", async () => {
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
  assert.equal(result.delivered, false);
  assert.equal(result.candidates.length, 1, "gathered candidates still surface for upstream model re-filter");
  assert.equal(result.candidates[0].source, "repo://a.ts");
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

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}`); console.log(String((e as Error).message).split("\n").slice(0, 6).join("\n")); }
}
console.log(`\n${tests.length} tests: ${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
