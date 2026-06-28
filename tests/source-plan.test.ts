import assert from "node:assert/strict";
import { heuristicSourcePlan } from "../index";

function assertSources(prompt: string, expected: string[]) {
  const plan = heuristicSourcePlan(prompt, "auto");
  for (const source of expected) {
    assert.ok(plan.sources.includes(source as never), `${prompt} should include ${source}; got ${plan.sources.join(", ")}`);
  }
  return plan;
}

const codePlan = assertSources("fix failing parseSembleSearchOutput test in lib/semble.ts", ["files", "semble"]);
assert.ok(!codePlan.sources.includes("project_memory" as never), `code-reduced prompt should not require project_memory; got ${codePlan.sources.join(", ")}`);

assertSources("explain the end-to-end architecture flow for graph memory retrieval", ["files", "semble", "docs", "project_memory"]);
assertSources("what convention do we use for graph memory in surrealdb", ["project_memory"]);
assertSources("review recent git diff for source routing changes", ["git"]);
assertSources("review recent sherpa performance, does it provide usefull data, all is working corectly ?", ["docs", "project_memory", "files"]);

console.log("source-plan tests passed=5");
