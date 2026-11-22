import assert from "node:assert/strict";
import { heuristicSourcePlan } from "../index";
import { parsePlannedIndicators, parsePlannedSourcePlan, routedFallbackPlan, sourcePlanningMessage } from "../lib/source-planning";
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

const internetPlan = assertSources("Search the internet for the latest TypeScript release", ["web"]);
assert.deepEqual(internetPlan.sources, ["web"], "an external-only request must not search local files or memory");
assert.deepEqual(routedFallbackPlan({ config: { sources: { web: true, files: true, docs: true, inquirer: true } } }, "Browse the internet for climate data", "front-door").sources, ["web"], "internet browsing activates web even without a search keyword");
assert.deepEqual(heuristicSourcePlan("Find the Inquirer API implementation in this repository", "front-door").sources, ["files", "semble"], "a code lookup mentioning Inquirer must not be mistaken for a memory lookup");
const oraclePlan = assertSources("Find the saved convention in Inquirer on Oracle", ["inquirer"]);
assert.deepEqual(oraclePlan.sources, ["inquirer"], "an explicit Oracle Inquirer lookup should not query local memory");
const localPlan = assertSources("Find the saved convention in local project memory", ["project_memory"]);
assert.deepEqual(localPlan.sources, ["project_memory"], "an explicit local memory lookup should not query Oracle Inquirer");
const mixedPlan = assertSources("Search the internet for current TypeScript guidance and compare with our repository implementation", ["web", "files", "semble"]);
assert.ok(mixedPlan.sources.includes("web") && mixedPlan.sources.includes("files"), "comparison requires both external and repo evidence");
const publicCatalogPlan = heuristicSourcePlan("Show me the list of models supported by Qwen Cloud", "front-door");
assert.deepEqual(publicCatalogPlan.sources, ["web"], "a public provider catalog is an implicit external-only request");
const publicPricingPlan = heuristicSourcePlan("Use official Alibaba documentation and provider evidence to compare public pricing with our local Token Plan configuration", "front-door");
assert.ok(publicPricingPlan.sources.includes("web") && publicPricingPlan.sources.includes("docs") && publicPricingPlan.sources.includes("files") && publicPricingPlan.sources.includes("semble"), "public documentation comparison keeps external and local configuration evidence");
assert.ok(heuristicSourcePlan("What is the current TypeScript release?", "front-door").sources.includes("web"), "a current release activates web");
assert.ok(!heuristicSourcePlan("pi-sherpa tracing current calls implementation location", "front-door").sources.includes("web"), "current local calls are not web research");
assert.ok(!heuristicSourcePlan("add local olmx model gemma-3-12b-it-qat-4bit", "front-door").sources.includes("web"), "a local model configuration request is not external research");
assert.ok(!heuristicSourcePlan("check ssh oracle and verify api.enquirer.app service is running", "front-door").sources.includes("web"), "an Oracle health check is not web research");

assert.ok(focusAllowsInquirerMemory("remember the source routing convention"), "memory prompts should allow inquirer source");
assert.ok(!focusAllowsInquirerMemory("fix failing parser test"), "code-only prompts should not allow inquirer source");
assert.ok(!focusAllowsInquirerMemory("review pi-sherpa context curation quality"), "bare 'context' is not memory intent and must not allow inquirer source");
assert.equal(retrievalEnabled({ config: { sources: { inquirer: false } } }, { sources: ["inquirer"] })("inquirer"), false, "disabled inquirer config should not retrieve");
assert.equal(retrievalEnabled({ config: { sources: { inquirer: true } } }, { sources: ["inquirer"] })("inquirer"), true, "enabled inquirer config should retrieve");

const plannerPrompt = sourcePlanningMessage("fix source planner").content
  .filter((part): part is { type: "text"; text: string } => part.type === "text")
  .map((part) => part.text)
  .join("\n");
assert.match(plannerPrompt, /Return ONLY valid JSON matching this exact shape/, "requires one unambiguous JSON response");
assert.equal((plannerPrompt.match(/Return as JSON|Also return as JSON/g) ?? []).length, 0, "does not ask the model for competing JSON objects");
assert.match(plannerPrompt, /Inquirer.*Oracle/i, "planner identifies the Oracle knowledge source");
assert.match(plannerPrompt, /project_memory.*local/i, "planner identifies local project memory");

const plannerFallback = { indicators: ["fallback"], reason: "fallback", confidence: 0.3, planner: "heuristic" as const };
assert.deepEqual(
  parsePlannedIndicators({ indicators: '{"indicators":["sourcePlanningMessage"],"reason":"tool JSON","confidence":0.9}' }, plannerFallback),
  { indicators: ["sourcePlanningMessage"], reason: "tool JSON", confidence: 0.9, planner: "llm" },
  "accepts Qwen JSON-string tool arguments for indicators",
);

const sourceState = { config: { sources: { files: true, semble: true, docs: true, project_memory: true, inquirer: true, web: true } } };
const repoRoute = { name: "repo", triggers: [], read: ["src"], docs: ["README.md"], skip: [], score: 1 };
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "Show me the list of models supported by Qwen Cloud", "front-door", { sources: { sources: ["web", "files", "docs"] } })?.sources,
  ["web"],
  "an implicit public-catalog request strips model-selected local sources",
);
assert.deepEqual(
  routedFallbackPlan(sourceState, "Search the internet for the latest TypeScript release", "front-door", repoRoute).sources,
  ["web"],
  "route-map hints must not override an external-only request",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "Search the internet for the latest TypeScript release", "front-door", { sources: { sources: ["web"] } }, repoRoute)?.sources,
  ["web"],
  "route-map hints must not append local retrieval to a web-only model plan",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "Find the saved convention in Inquirer on Oracle", "front-door", { sources: { sources: ["project_memory", "inquirer"] } })?.sources,
  ["inquirer"],
  "explicit Oracle lookup should not be redirected into local memory",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "Find the saved convention in local project memory", "front-door", { sources: { sources: ["project_memory", "inquirer"] } })?.sources,
  ["project_memory"],
  "explicit local lookup should not query Oracle Inquirer",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "Search the internet for the latest TypeScript release", "front-door", { sources: { sources: ["files", "docs", "project_memory", "inquirer", "web"] } })?.sources,
  ["web"],
  "a model cannot add local retrieval to an external-only request",
);
assert.deepEqual(
  parsePlannedSourcePlan(sourceState, "Search the internet for current TypeScript guidance and compare with our repository implementation", "front-door", { sources: { sources: ["web", "files"] } })?.sources,
  ["web", "files", "semble"],
  "mixed requests keep both sources",
);
assert.deepEqual(
  parsePlannedSourcePlan({ config: { sources: { ...sourceState.config.sources, web: false } } }, "Search the internet for the latest TypeScript release", "front-door", { sources: { sources: ["web", "files"] } })?.sources,
  undefined,
  "disabled web must not fall back to unrelated local retrieval",
);
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

console.log("source-plan tests passed");
