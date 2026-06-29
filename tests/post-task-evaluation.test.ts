/**
 * Sherpa post-task retrieval evaluation tests.
 * Run with: tsx tests/post-task-evaluation.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEvaluationFeedbackToCandidates, applyReflectionModelOutput, classifyEvalTaskKind, evaluatePostTaskContext } from "../lib/post-task-evaluation";
import { readQualitySummary, writeQualitySummary, summarizeEvaluations, type ContextBundleRecord, type ContextEvaluation } from "../lib/evaluation";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-eval-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function bundle(items: ContextBundleRecord["items"]): ContextBundleRecord {
  return {
    bundleId: "bundle-test",
    timestamp: Date.now(),
    focus: "test focus",
    mode: "explicit",
    items,
  };
}

test("scores high recall when bundle covers edited file", () => {
  const ev = evaluatePostTaskContext({
    bundle: bundle([{ handle: "ctx-1", type: "file_snippet", source: "repo://server/app.py", summary: "def _fail_stale_in_progress_jobs" }]),
    outcome: "completed",
    files: { readFiles: [], writtenFiles: ["server/app.py"], changedFiles: [] },
  });
  assert(ev.scores.recall === 1, `expected recall 1, got ${ev.scores.recall}`);
  assert(ev.scores.precision === 1, `expected precision 1, got ${ev.scores.precision}`);
  assert(ev.missed.length === 0, "expected no missed files");
});

test("marks missed files and noisy generic snippets", () => {
  const ev = evaluatePostTaskContext({
    bundle: bundle([
      { handle: "ctx-1", type: "doc_snippet", source: "repo://README.md", summary: "if WebSocket fails, Stick falls back to GET /agent/jobs/{id} polling" },
    ]),
    outcome: "completed",
    files: { readFiles: ["stick/st7789.py"], writtenFiles: [], changedFiles: [] },
  });
  assert(ev.scores.recall === 0, `expected recall 0, got ${ev.scores.recall}`);
  assert(ev.missed.includes("stick/st7789.py"), "expected missed st7789.py");
  assert(ev.noise.includes("repo://README.md"), "expected README noise");
});

test("does not treat pre-existing dirty git files as missed recall ground truth", () => {
  const ev = evaluatePostTaskContext({
    bundle: bundle([
      { handle: "ctx-1", type: "file_snippet", source: "repo://firmware/m5sticks3-arduino/M5VoiceTerminal/config.h.example", summary: "WIFI_SSID WIFI_PASSWORD" },
    ]),
    outcome: "completed",
    files: {
      readFiles: [],
      writtenFiles: [],
      referencedFiles: ["firmware/m5sticks3-arduino/M5VoiceTerminal/config.h.example"],
      changedFiles: ["Makefile", "routes.csv"],
    },
  });
  assert(ev.scores.recall === 1, `expected recall 1, got ${ev.scores.recall}`);
  assert(!ev.missed.includes("Makefile"), "dirty Makefile should not be a missed file");
  assert(!ev.missed.includes("routes.csv"), "dirty routes.csv should not be a missed file");
});

test("meta-analysis evaluates intent-matching memory without file ground truth", () => {
  const input = {
    bundle: bundle([
      { handle: "ctx-1", type: "other_project_memory", source: "kb://project/ClearStack/wiki/evidence/sherpa-distillation-experiment-2026-05-07.md", summary: "Sherpa distillation experiment proving task-level lifecycle routes durable outputs to Obsidian" },
      { handle: "ctx-2", type: "doc_snippet", source: "repo://docs/MISSION_PROMPT.md", summary: "Mission prompt template starts missions using Sherpa, Bob, Ralph and Archivist" },
    ]),
    outcome: "completed" as const,
    files: { readFiles: [], writtenFiles: [], changedFiles: [] },
    finalText: "Reviewed Sherpa performance across projects and evaluations.",
  };
  const ev = evaluatePostTaskContext(input);
  assert(classifyEvalTaskKind(input) === "meta_analysis", "expected meta_analysis task kind");
  assert(ev.scores.precision === 0.5, `expected one useful source of two, got precision ${ev.scores.precision}`);
  assert(ev.noise.includes("repo://docs/MISSION_PROMPT.md"), "expected generic mission prompt as noise");
});

test("feedback penalizes noise and boosts missed filename candidates", () => {
  const evals: ContextEvaluation[] = [{
    bundleId: "bundle-test",
    taskOutcome: "completed",
    scores: { relevance: 0.2, precision: 0, recall: 0 },
    noise: ["repo://README.md"],
    missed: ["stick/st7789.py"],
    reflection: "",
    improvementHint: "",
    evaluatedAt: new Date().toISOString(),
  }];
  const adjusted = applyEvaluationFeedbackToCandidates([
    { source: "repo://README.md", relevance: 0.7 },
    { source: "repo://stick/st7789.py", relevance: 0.4 },
  ], evals);
  assert(adjusted[0].relevance < 0.7, "expected README penalty");
  assert(adjusted[1].relevance > 0.4, "expected missed file boost");
});

test("feedback penalizes generic source classes even without exact prior noise", () => {
  const evals: ContextEvaluation[] = [{
    bundleId: "bundle-test",
    taskOutcome: "completed",
    scores: { relevance: 0.2, precision: 0, recall: 0 },
    noise: ["repo://README.md"],
    missed: ["packages/domains/compliance/registers/src/services/update-register-entry.ts"],
    reflection: "",
    improvementHint: "",
    evaluatedAt: new Date().toISOString(),
  }];
  const adjusted = applyEvaluationFeedbackToCandidates([
    { source: "file://~/.pi/agent/skills/allium/SKILL.md", relevance: 0.65 },
    { source: "repo://docs/MISSION_PROMPT.md", relevance: 0.75 },
    { source: "repo://packages/domains/compliance/registers/src/services/update-register-entry.ts", relevance: 0.35 },
  ], evals);
  assert(adjusted[0].relevance <= 0.2, "expected strong skill-doc generic penalty");
  assert(adjusted[1].relevance <= 0.3, "expected strong mission-doc generic penalty");
  assert(adjusted[2].relevance > 0.35, "expected exact missed filename boost");
});

test("project quality summary penalties apply even without recent eval objects", () => {
  const adjusted = applyEvaluationFeedbackToCandidates([
    { source: "repo://docs/MISSIONS.md", relevance: 0.8 },
    { source: "repo://src/server/public/client.js", relevance: 0.2 },
  ], [], {
    generatedAt: new Date().toISOString(),
    window: 100,
    count: 100,
    averageRelevance: 0.3,
    averagePrecision: 0.2,
    averageRecall: 0.6,
    topNoise: [{ source: "repo://docs/MISSIONS.md", count: 10 }],
    topMissed: [{ pattern: "src/server/public/client.js", count: 6 }],
    topHints: [],
  });
  assert(adjusted[0].relevance < 0.4, "expected quality summary noise penalty");
  assert(adjusted[1].relevance > 0.2, "expected quality summary missed-path boost");
});

test("generic source penalties are skipped when focus explicitly asks for that source class", () => {
  const evals: ContextEvaluation[] = [{
    bundleId: "bundle-test",
    taskOutcome: "completed",
    scores: { relevance: 0.2, precision: 0, recall: 0 },
    noise: [],
    missed: [],
    reflection: "",
    improvementHint: "",
    evaluatedAt: new Date().toISOString(),
  }];
  const adjusted = applyEvaluationFeedbackToCandidates([
    { source: "repo://docs/MISSIONS.md", relevance: 0.75 },
  ], evals, undefined, { focus: "Review the mission orchestrator and validator protocol" });
  assert(adjusted[0].relevance === 0.75, "mission docs should not be generically penalized for mission-focused queries");
});

test("quality summary can be written and read back", () => withTemp((dir) => {
  const evals: ContextEvaluation[] = [{
    bundleId: "bundle-test",
    taskOutcome: "completed",
    scores: { relevance: 0.4, precision: 0.25, recall: 0.75 },
    noise: ["repo://docs/MISSIONS.md"],
    missed: ["src/server/public/client.js"],
    reflection: "",
    improvementHint: "Prefer exact paths",
    evaluatedAt: new Date().toISOString(),
  }];
  writeQualitySummary(dir, evals);
  const summary = readQualitySummary(dir);
  assert(summary?.count === 1, "expected one evaluation in quality summary");
  assert(summary?.topNoise[0]?.source === "repo://docs/MISSIONS.md", "expected top noise source");
  assert(summary?.topMissed[0]?.pattern === "src/server/public/client.js", "expected top missed path");
}));

test("sidecar reflection output overrides usefulness, missed/noisy context, and lesson", () => {
  const base: ContextEvaluation = {
    bundleId: "bundle-test",
    taskOutcome: "unknown",
    scores: { relevance: 0.2, precision: 0.2, recall: 0.2 },
    noise: [],
    missed: [],
    reflection: "base reflection",
    improvementHint: "base hint",
    evaluatedAt: new Date().toISOString(),
  };
  const result = applyReflectionModelOutput(base, {
    outcome: "completed",
    sherpa_context_usefulness: "useful",
    missed_context: ["src/exact.ts"],
    noisy_context: ["repo://README.md"],
    lesson: "Exact source paths beat generic README context.",
    should_preserve: true,
    improvement_hint: "Boost exact source paths.",
    reason: "Agent used the exact path after reflection.",
  });
  assert(result.evalRecord.taskOutcome === "completed", "expected outcome override");
  assert(result.evalRecord.scores.relevance >= 0.75, "expected usefulness to boost relevance");
  assert(result.evalRecord.missed.includes("src/exact.ts"), "expected missed context");
  assert(result.evalRecord.noise.includes("repo://README.md"), "expected noisy context");
  assert(result.evalRecord.reflection.includes("Sidecar task reflection"), "expected sidecar reflection section");
  assert(result.shouldPreserve === true, "expected preserve flag");
  assert(result.lesson === "Exact source paths beat generic README context.", "expected lesson");
  assert(result.evalRecord.improvementHint === "Boost exact source paths.", "expected hint override");
});

test("feedback does not boost unrelated generic page.tsx candidates", () => {
  const evals: ContextEvaluation[] = [{
    bundleId: "bundle-test",
    taskOutcome: "completed",
    scores: { relevance: 0.2, precision: 0, recall: 0 },
    noise: [],
    missed: ["apps/clearops/app/(dashboard)/admin/compliance/registers/entries/[entryId]/page.tsx"],
    reflection: "",
    improvementHint: "",
    evaluatedAt: new Date().toISOString(),
  }];
  const adjusted = applyEvaluationFeedbackToCandidates([
    { source: "repo://apps/clearops/app/(dashboard)/admin/compliance/registers/entries/[entryId]/page.tsx", relevance: 0.25 },
    { source: "repo://apps/other/page.tsx", relevance: 0.25 },
  ], evals);
  assert(adjusted[0].relevance > 0.25, "expected exact page path boost");
  assert(adjusted[1].relevance === 0.25, "unrelated page.tsx should not be boosted by generic basename");
});

test("summarizeEvaluations computes averageConfidenceError from planner confidence vs recall", () => {
  const evals: ContextEvaluation[] = [
    makeBaseEval({ bundleId: "b1", plannerConfidence: 0.9, scores: { relevance: 0.8, precision: 0.7, recall: 0.8 } }),
    makeBaseEval({ bundleId: "b2", plannerConfidence: 0.6, scores: { relevance: 0.5, precision: 0.5, recall: 0.5 } }),
    makeBaseEval({ bundleId: "b3", plannerConfidence: 0.3, scores: { relevance: 0.3, precision: 0.3, recall: 0.2 } }),
  ];
  // confidence errors: |0.9-0.8|=0.1, |0.6-0.5|=0.1, |0.3-0.2|=0.1 → avg 0.1
  const summary = summarizeEvaluations(evals);
  assert(Math.abs(summary.averageConfidenceError - 0.1) < 0.001,
    `expected avg confidenceError 0.1, got ${summary.averageConfidenceError}`);
  assert(typeof summary.averageConfidenceError === "number", "averageConfidenceError should be a number");
});

test("summarizeEvaluations returns 0 confidenceError when no evals have plannerConfidence", () => {
  const evals: ContextEvaluation[] = [
    makeBaseEval({ bundleId: "b1" }),
    makeBaseEval({ bundleId: "b2" }),
  ];
  const summary = summarizeEvaluations(evals);
  assert(summary.averageConfidenceError === 0,
    `expected 0 confidenceError, got ${summary.averageConfidenceError}`);
});

function makeBaseEval(overrides: Partial<ContextEvaluation> & { bundleId: string }): ContextEvaluation {
  return {
    bundleId: overrides.bundleId,
    taskOutcome: overrides.taskOutcome ?? "unknown",
    scores: overrides.scores ?? { relevance: 0.5, precision: 0.5, recall: 0.5 },
    noise: overrides.noise ?? [],
    missed: overrides.missed ?? [],
    reflection: overrides.reflection ?? "",
    improvementHint: overrides.improvementHint ?? "",
    evaluatedAt: overrides.evaluatedAt ?? new Date().toISOString(),
    plannerConfidence: overrides.plannerConfidence ?? undefined,
  };
}

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
