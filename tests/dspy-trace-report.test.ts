/**
 * Sherpa DSPy trace report tests.
 * Run with: tsx tests/dspy-trace-report.test.ts
 */

import { summarizeDspyTraces, type DspyTraceRecord } from "../lib/dspy";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

function trace(partial: Partial<DspyTraceRecord>): DspyTraceRecord {
  return {
    version: 1,
    at: new Date().toISOString(),
    bundleId: "bundle-test",
    focus: "test focus",
    mode: "front-door",
    sourcePlan: { sources: ["files"], reason: "test", confidence: 0.5, planner: "heuristic" },
    indicators: { indicators: ["test"], reason: "test", confidence: 0.5, planner: "heuristic" },
    candidateCount: 3,
    candidates: [],
    selected: [{ handle: "ctx-1", type: "doc", source: "repo://a.ts", relevance: 0.8, summary: "" }],
    curate: { abstain: false, abstainReason: "", confidence: 0.5, planner: "heuristic", rejected: [] },
    ...partial,
  };
}

test("summarizeDspyTraces aggregates decisions and reasons", () => {
  const report = summarizeDspyTraces([
    trace({ decisions: [
      { source: "repo://a.ts", finalRelevance: 0.8, decision: "selected", reasons: ["selected_by_curator"] },
      { source: "repo://docs/MISSIONS.md", finalRelevance: 0.2, decision: "suppressed", reasons: ["generic_source:mission", "focus_does_not_allow_mission"] },
      { source: "repo://README.md", finalRelevance: 0.3, decision: "rejected", reasons: ["generic_source:readme"] },
    ] }),
    trace({ candidateCount: 5, selected: [], sourcePlan: { sources: ["files"], reason: "planner skipped: mode=explicit", confidence: 0.4, planner: "fallback" }, curate: { abstain: true, abstainReason: "weak", confidence: 0.1, planner: "heuristic", plannerReason: "curation skipped: remote model disabled", rejected: [] }, decisions: [
      { source: "repo://b.ts", finalRelevance: 0.7, decision: "boosted", reasons: ["missed_path_boost"] },
    ] }),
  ]);
  assert(report.traces === 2, "expected two traces");
  assert(report.averageCandidates === 4, `expected avg candidates 4, got ${report.averageCandidates}`);
  assert(report.abstentionRate === 0.5, `expected abstention rate .5, got ${report.abstentionRate}`);
  assert(report.decisions.selected === 1, "expected selected count");
  assert(report.decisions.boosted === 1, "expected boosted count");
  assert(report.decisions.rejected === 1, "expected rejected count");
  assert(report.decisions.suppressed === 1, "expected suppressed count");
  assert(report.topSuppressed[0]?.source === "repo://docs/MISSIONS.md", "expected suppressed mission doc");
  assert(report.topReasons.some((item) => item.reason === "generic_source:mission"), "expected mission reason");
  assert(report.topSourcePlanReasons.some((item) => item.reason === "planner skipped: mode=explicit"), "expected source planner reason");
  assert(report.topCurationReasons.some((item) => item.reason === "curation skipped: remote model disabled"), "expected curation reason");
});

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
