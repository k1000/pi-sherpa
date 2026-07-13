import assert from "node:assert/strict";
import { heuristicSourcePlan } from "../index";
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

console.log("source-plan tests passed=9");
