import assert from "node:assert/strict";
import { conciseSummary, extractQueryTarget, heuristicSourcePlan, isPiSherpaMetaDebugPrompt, isTraceLogMetricsPrompt, parseCompiledContextItems, postProcessCandidates, resolveModelFilterPool } from "../index";

type Candidate = Parameters<typeof postProcessCandidates>[0][number];

function candidate(partial: Partial<Candidate> & Pick<Candidate, "source">): Candidate {
  const raw = partial.raw ?? partial.summary ?? partial.source;
  return {
    handle: partial.handle ?? `ctx-${Math.random().toString(36).slice(2, 8)}`,
    type: partial.type ?? "file_snippet",
    source: partial.source,
    relevance: partial.relevance ?? 0.5,
    summary: partial.summary ?? raw,
    raw,
    inline: partial.inline ?? false,
  };
}

function sourcesFor(prompt: string, candidates: Candidate[], mode = "explicit"): string[] {
  return postProcessCandidates(candidates, prompt, mode).map((item) => item.source);
}

function assertIncludesAny(actual: string[], expectedFragment: string): void {
  assert.ok(
    actual.some((source) => source.includes(expectedFragment)),
    `expected one source to include ${expectedFragment}; got ${actual.join(", ")}`,
  );
}

function assertExcludesAny(actual: string[], forbiddenFragment: string): void {
  assert.ok(
    !actual.some((source) => source.includes(forbiddenFragment)),
    `expected no source to include ${forbiddenFragment}; got ${actual.join(", ")}`,
  );
}

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) { tests.push({ name, fn }); }

test("golden: code prompt keeps exact implementation file and strips generic noise", () => {
  const prompt = "fix parseSembleSearchOutput in lib/semble.ts";
  const actual = sourcesFor(prompt, [
    candidate({ type: "doc_snippet", source: "repo://README.md", relevance: 0.98, summary: "Project overview and broad setup" }),
    candidate({ type: "doc_snippet", source: "file://~/.pi/agent/skills/allium/SKILL.md", relevance: 0.95, summary: "Skill instructions unrelated to Semble parser" }),
    candidate({ type: "file_snippet", source: "repo://package.json", relevance: 0.9, summary: "package metadata" }),
    candidate({ type: "git_status", source: "git://status", relevance: 0.85, summary: " M README.md" }),
    candidate({ type: "file_snippet", source: "repo://lib/semble.ts:42", relevance: 0.55, summary: "function parseSembleSearchOutput(output: string)" }),
  ]);
  assertIncludesAny(actual, "repo://lib/semble.ts:42");
  assertExcludesAny(actual, "README.md");
  assertExcludesAny(actual, "/.pi/agent/skills/");
  assertExcludesAny(actual, "package.json");
  assertExcludesAny(actual, "git://status");
});

test("golden: git status is only returned when the prompt asks for changed files", () => {
  const candidates = [
    candidate({ type: "git_status", source: "git://status", relevance: 0.9, summary: " M index.ts" }),
    candidate({ type: "file_snippet", source: "repo://index.ts:100", relevance: 0.35, summary: "retrieval status handling" }),
  ];
  assertExcludesAny(sourcesFor("explain retrieval status handling", candidates), "git://status");
  assertIncludesAny(sourcesFor("review git status and changed files", candidates), "git://status");
});

test("golden: explicit skill prompts may include skill docs, ordinary code prompts may not", () => {
  const skill = candidate({ type: "doc_snippet", source: "file://~/.pi/agent/skills/use-sherpa/SKILL.md", relevance: 0.8, summary: "Use Sherpa before non-trivial tasks" });
  assertExcludesAny(sourcesFor("fix source planning in index.ts", [skill]), "/.pi/agent/skills/");
  assertIncludesAny(sourcesFor("review the use-sherpa skill instructions", [skill]), "/.pi/agent/skills/");
});

test("golden: pi-sherpa prompt routes to extension code instead of unrelated research memory", () => {
  const prompt = "review pi-sherpa context curation quality";
  const actual = sourcesFor(prompt, [
    candidate({ type: "research_memory", source: "kb://research/AI/hipporag-long-term-memory-rag.md", relevance: 0.8, summary: "Graph memory research paper" }),
    candidate({ type: "pi_extension_route", source: "file://~/.pi/agent/extensions/pi-sherpa", relevance: 0.7, summary: "Pi extension route: pi-sherpa" }),
    candidate({ type: "pi_extension_file", source: "file://~/.pi/agent/extensions/pi-sherpa/index.ts:1145", relevance: 0.65, summary: "async function compileContextWithModel" }),
  ]);
  assertIncludesAny(actual, "extensions/pi-sherpa");
  assertExcludesAny(actual, "hipporag-long-term-memory-rag.md");
});

test("golden: compressed summaries preserve expand pointers", () => {
  const hint = " (expand with /sherpa:expand ctx-42)";
  const compacted = conciseSummary(`${"x".repeat(1000)}${hint}`, 120);
  assert.ok(compacted.endsWith(hint), `expected compacted summary to preserve expand hint; got ${compacted}`);
  assert.ok(compacted.length <= 121 + hint.length, "summary should remain compact while preserving pointer");
});

test("golden: source planner includes files for Sherpa quality review", () => {
  const plan = heuristicSourcePlan("review pi-sherpa context curation quality", "explicit");
  assert.ok(plan.sources.includes("files"), `expected files source; got ${plan.sources.join(", ")}`);
  assert.ok(plan.sources.includes("project_memory"), `expected project_memory source; got ${plan.sources.join(", ")}`);
});

test("golden: Sherpa trace/log prompts route to runtime traces and dspy implementation", () => {
  const prompt = "pi-sherpa tracing recent calls implementation and where logs/metrics are stored";
  const plan = heuristicSourcePlan(prompt, "explicit");
  const actual = sourcesFor(prompt, [
    candidate({ type: "sherpa_trace_location", source: "repo://.pi-memory/sherpa-traces", relevance: 0.7, summary: "Active trace directory" }),
    candidate({ type: "pi_sherpa_debug_file", source: "file://~/.pi/agent/extensions/pi-sherpa/lib/dspy.ts", relevance: 0.65, summary: "writeDspyTrace dspyTraceDir readDspyTraces" }),
    candidate({ type: "project_memory", source: "kb://journal/2026-06-15.md", relevance: 0.95, summary: "old Sherpa journal" }),
  ]);
  assert.ok(isTraceLogMetricsPrompt(prompt));
  assert.ok(isPiSherpaMetaDebugPrompt(prompt));
  assert.ok(plan.sources.includes("files"), `expected files source; got ${plan.sources.join(", ")}`);
  assertIncludesAny(actual, ".pi-memory/sherpa-traces");
  assertIncludesAny(actual, "pi-sherpa/lib/dspy.ts");
  assertExcludesAny(actual, "kb://journal");
});

test("golden: sidecar model filters candidates even when the deterministic prefilter empties the pool", () => {
  // Directive: whatever Sherpa delivers must be filtered by the sidecar model before
  // reaching the main model. A prefilter-empty pool with surviving raw candidates must
  // route to the model (not heuristic-abstain); only a truly empty search bypasses it.
  const noise = candidate({ type: "research_memory", source: "kb://journal/2026-05-01.md", relevance: 0.95, summary: "old research journal" });
  const weak = candidate({ type: "file_snippet", source: "repo://index.ts:10", relevance: 0.05, summary: "low relevance hit" });

  // prefilter empties (neither survives generic/threshold rules) but raw candidates exist → model must filter
  const routed = resolveModelFilterPool([], [noise, weak]);
  assert.ok(routed, "non-empty raw candidates must route to the sidecar model");
  assert.equal(routed?.length, 2, "all raw candidates are handed to the model to judge");

  // when the prefilter keeps candidates, those are used unchanged (existing behavior preserved)
  const kept = candidate({ type: "file_snippet", source: "repo://index.ts", relevance: 0.5, summary: "impl" });
  assert.deepEqual(resolveModelFilterPool([kept], [noise]), [kept]);

  // only a truly empty search (zero raw candidates) bypasses the model
  assert.equal(resolveModelFilterPool([], []), undefined);
});

test("golden: query target extraction identifies action, targets, and evidence type", () => {
  const target = extractQueryTarget("fix context compiler in pi-sherpa index.ts");
  assert.equal(target.action, "fix");
  assert.equal(target.evidenceType, "code");
  assert.ok(target.targetTerms.includes("compiler"), `expected compiler in ${target.targetTerms.join(",")}`);
  assert.ok(target.negativeSources.includes("git_status"), "git should be negative unless requested");
});

test("golden: old journal memory is stripped unless history/session is requested", () => {
  const journal = candidate({ type: "project_memory", source: "kb://journal/2026-06-15.md", relevance: 0.9, summary: "Old Sherpa finding" });
  const file = candidate({ type: "file_snippet", source: "repo://index.ts:1110", relevance: 0.4, summary: "compileContextWithModel" });
  assertExcludesAny(sourcesFor("review pi-sherpa context curation quality", [journal, file]), "kb://journal");
  assertIncludesAny(sourcesFor("review previous session journal about pi-sherpa", [journal, file]), "kb://journal");
});

test("golden: research memory is stripped unless research is requested", () => {
  const research = candidate({ type: "research_memory", source: "kb://research/AI/hipporag-long-term-memory-rag.md", relevance: 0.9, summary: "RAG paper" });
  assertExcludesAny(sourcesFor("review pi-sherpa context curation quality", [research]), "hipporag");
  assertIncludesAny(sourcesFor("review research paper hipporag for agent memory", [research]), "hipporag");
});

test("golden: target term matches boost exact source over adjacent context", () => {
  const actual = sourcesFor("fix context compiler", [
    candidate({ type: "file_snippet", source: "repo://lib/unrelated.ts:1", relevance: 0.5, summary: "context setup" }),
    candidate({ type: "file_snippet", source: "repo://index.ts:1110", relevance: 0.4, summary: "compileContextWithModel context compiler" }),
  ]);
  assert.equal(actual[0], "repo://index.ts:1110");
});

test("golden: unified context compiler parser keeps valid unique indexes capped at 3", () => {
  assert.deepEqual(parseCompiledContextItems({ items: [
    { index: 1, summary: "use this file", why: "exact target" },
    { index: "0", summary: "fallback route" },
    { index: 99, summary: "bad" },
    { index: 1, summary: "duplicate" },
    { index: 2, summary: "third" },
    { index: 3, summary: "fourth should be capped" },
  ] }, 4), [
    { index: 1, summary: "use this file", why: "exact target" },
    { index: 0, summary: "fallback route", why: undefined },
    { index: 2, summary: "third", why: undefined },
  ]);
});

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
