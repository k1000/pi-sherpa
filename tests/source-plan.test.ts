import assert from "node:assert/strict";
import { heuristicSourcePlan } from "../index";
import { parsePlannedIndicators, parsePlannedSourcePlan, sourcePlanningMessage } from "../lib/source-planning";
import { retrievalEnabled } from "../lib/source-activation";
import { focusAllowsInquirerMemory } from "../lib/source-guards";

function assertSources(prompt: string, expected: string[]) {
  const plan = heuristicSourcePlan(prompt, "auto");
  for (const source of expected) {
    assert.ok(plan.sources.includes(source as never), `${prompt} should include ${source}; got ${plan.sources.join(", ")}`);
  }
  return plan;
}

const codePlan = assertSources("fix failing parseSembleSearchOutput test in lib/semble.ts", ["files", "semble"]);
assert.ok(!codePlan.sources.includes("project_memory" as never), `code-reduced prompt should not require project_memory; got ${codePlan.sources.join(", ")}`);

assertSources("explain the end-to-end architecture flow for graph memory retrieval", ["files", "semble", "docs", "project_memory", "inquirer"]);
assertSources("what convention do we use for graph memory in surrealdb", ["project_memory", "inquirer"]);
assertSources("review recent git diff for source routing changes", ["git"]);
assertSources("review recent sherpa performance, does it provide usefull data, all is working corectly ?", ["docs", "project_memory", "inquirer", "files"]);

assert.ok(focusAllowsInquirerMemory("remember the source routing convention"), "memory prompts should allow inquirer source");
assert.ok(!focusAllowsInquirerMemory("fix failing parser test"), "code-only prompts should not allow inquirer source");
assert.equal(retrievalEnabled({ config: { sources: { inquirer: false } } }, { sources: ["inquirer"] })("inquirer"), false, "disabled inquirer config should not retrieve");
assert.equal(retrievalEnabled({ config: { sources: { inquirer: true } } }, { sources: ["inquirer"] })("inquirer"), true, "enabled inquirer config should retrieve");

const plannerPrompt = sourcePlanningMessage("fix source planner").content
  .filter((part): part is { type: "text"; text: string } => part.type === "text")
  .map((part) => part.text)
  .join("\n");
assert.match(plannerPrompt, /Return ONLY valid JSON matching this exact shape/, "requires one unambiguous JSON response");
assert.equal((plannerPrompt.match(/Return as JSON|Also return as JSON/g) ?? []).length, 0, "does not ask the model for competing JSON objects");

const plannerFallback = { indicators: ["fallback"], reason: "fallback", confidence: 0.3, planner: "heuristic" as const };
assert.deepEqual(
  parsePlannedIndicators({ indicators: '{"indicators":["sourcePlanningMessage"],"reason":"tool JSON","confidence":0.9}' }, plannerFallback),
  { indicators: ["sourcePlanningMessage"], reason: "tool JSON", confidence: 0.9, planner: "llm" },
  "accepts Qwen JSON-string tool arguments for indicators",
);

const sourceState = { config: { sources: { files: true, semble: true, docs: true, project_memory: true, inquirer: true } } };
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "fix source planner", "explicit", { sourcePlan: { sources: ["files"], reason: "code fix", confidence: 0.8 } })?.sources,
  ["files", "semble"],
  "accepts object-shaped sourcePlan payloads",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "fix source planner", "explicit", { source_selection: { selected_sources: ["docs", "project_memory"], rationale: "docs and memory" } })?.sources,
  ["docs", "project_memory"],
  "accepts snake_case source selection payloads",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "fix source planner", "explicit", { sourceSelection: { selected: ["files"], why: "code fix" } })?.sources,
  ["files", "semble"],
  "accepts selected alias in camelCase sourceSelection payloads",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "fix source planner", "explicit", { sources: { enabled_sources: ["docs"] } })?.sources,
  ["docs"],
  "accepts enabled_sources alias in sources payloads",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "fix source planner", "explicit", { sources: '{"sources":["files"],"reason":"tool JSON","confidence":0.9}' })?.sources,
  ["files", "semble"],
  "accepts Qwen JSON-string tool arguments for sources",
);

console.log("source-plan tests passed=17");
