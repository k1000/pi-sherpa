import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { ContextEvaluation } from "./evaluation";

export type DspyTraceCandidate = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
};

export type DspyTraceDecision = {
  source: string;
  baseRelevance?: number;
  finalRelevance: number;
  decision: "selected" | "rejected" | "suppressed" | "boosted";
  reasons: string[];
};

export type DspyTraceStageLabels = {
  processDecision: string;
  dataSufficiency: string;
  finalContext: string;
};

export type DspyTraceRecord = {
  version: 1;
  at: string;
  bundleId: string;
  focus: string;
  mode: string;
  stageLabels?: DspyTraceStageLabels;
  sourcePlan: { sources: string[]; reason: string; confidence: number; planner: string };
  indicators: { indicators: string[]; reason: string; confidence: number; planner: string };
  candidateCount: number;
  candidates: DspyTraceCandidate[];
  selected: DspyTraceCandidate[];
  curate: {
    abstain: boolean;
    abstainReason: string;
    confidence: number;
    planner: string;
    plannerReason?: string;
    rejected: Array<{ index: number; reason: string; source: string }>;
  };
  decisions?: DspyTraceDecision[];
  feedback?: {
    recentEvaluations?: number;
    qualitySummaryUsed?: boolean;
    penaltiesApplied?: number;
    boostsApplied?: number;
  };
  disposition?: string;
};

export type DspyTraceReport = {
  traces: number;
  averageCandidates: number;
  averageSelected: number;
  abstentionRate: number;
  decisions: { selected: number; rejected: number; suppressed: number; boosted: number };
  topSelected: Array<{ source: string; count: number }>;
  topRejected: Array<{ source: string; count: number }>;
  topSuppressed: Array<{ source: string; count: number }>;
  topReasons: Array<{ reason: string; count: number }>;
  topSourcePlanReasons: Array<{ reason: string; count: number }>;
  topCurationReasons: Array<{ reason: string; count: number }>;
  topProcessDecisions: Array<{ reason: string; count: number }>;
  topDataSufficiency: Array<{ reason: string; count: number }>;
  topFinalContext: Array<{ reason: string; count: number }>;
};

export type DspyTrainingExample = {
  stage: "planAndCurate";
  bundleId: string;
  focus: string;
  mode: string;
  input: {
    focus: string;
    mode: string;
    sourcePlan: DspyTraceRecord["sourcePlan"];
    indicators: DspyTraceRecord["indicators"];
    candidates: DspyTraceCandidate[];
  };
  expected: {
    selectedSources: string[];
    selectedHandles: string[];
    abstain: boolean;
    disposition?: string;
  };
  scores?: ContextEvaluation["scores"];
  taskOutcome?: ContextEvaluation["taskOutcome"];
  metric: number;
  weight: number;
  reflection?: string;
  improvementHint?: string;
};

const TRACE_DIR = "sherpa-traces";
const DSPY_DIR = path.join(".pi", "sherpa", "dspy");

export function compiledPromptFileName(kind: string): string {
  return `${kind}.prompt.json`;
}

export function readCompiledPrompt(cwd: string, compiledPromptPath: string, kind: string): { prompt: string; source: string; metadata?: Record<string, unknown> } | null {
  const base = path.isAbsolute(compiledPromptPath) ? compiledPromptPath : path.join(cwd, compiledPromptPath);
  const target = path.join(base, compiledPromptFileName(kind));
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    const prompt = parsed.prompt ?? parsed.systemPrompt ?? parsed.instructions;
    if (typeof prompt !== "string" || !prompt.trim()) return null;
    return { prompt, source: target, metadata: parsed };
  } catch {
    return null;
  }
}

function jsonlEscape(record: unknown): string {
  return JSON.stringify(record).replace(/\n/g, "\\n");
}

export function dspyTraceDir(cwd: string): string {
  return path.join(cwd, ".pi-memory", TRACE_DIR);
}

export function writeDspyTrace(cwd: string, record: DspyTraceRecord): string {
  const dir = dspyTraceDir(cwd);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(target, jsonlEscape(record) + "\n");
  return target;
}

export function readDspyTraces(cwd: string, limit = 2000): DspyTraceRecord[] {
  const dir = dspyTraceDir(cwd);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const out: DspyTraceRecord[] = [];
  for (const file of files) {
    const lines = readFileSync(path.join(dir, file), "utf8").split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as DspyTraceRecord;
        if (parsed?.version === 1 && parsed.bundleId) out.push(parsed);
      } catch { /* ignore malformed traces */ }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function topCounts(items: string[], limit = 8): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([source, count]) => ({ source, count }));
}

function reasonCounts(items: string[], limit = 8): Array<{ reason: string; count: number }> {
  return topCounts(items, limit).map(({ source, count }) => ({ reason: source, count }));
}

export function summarizeDspyTraces(traces: DspyTraceRecord[]): DspyTraceReport {
  const avg = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const decisions = traces.flatMap((trace) => trace.decisions ?? []);
  const selected = decisions.filter((d) => d.decision === "selected");
  const rejected = decisions.filter((d) => d.decision === "rejected");
  const suppressed = decisions.filter((d) => d.decision === "suppressed");
  const boosted = decisions.filter((d) => d.decision === "boosted");
  const decisionReasonCounts = reasonCounts(decisions.flatMap((d) => d.reasons), 10);
  return {
    traces: traces.length,
    averageCandidates: avg(traces.map((t) => t.candidateCount || t.candidates?.length || 0)),
    averageSelected: avg(traces.map((t) => t.selected?.length || 0)),
    abstentionRate: traces.length ? traces.filter((t) => t.curate?.abstain).length / traces.length : 0,
    decisions: { selected: selected.length, rejected: rejected.length, suppressed: suppressed.length, boosted: boosted.length },
    topSelected: topCounts([...selected, ...boosted].map((d) => d.source)),
    topRejected: topCounts(rejected.map((d) => d.source)),
    topSuppressed: topCounts(suppressed.map((d) => d.source)),
    topReasons: decisionReasonCounts,
    topSourcePlanReasons: reasonCounts(traces.map((trace) => trace.sourcePlan?.reason ?? ""), 10),
    topCurationReasons: reasonCounts(traces.map((trace) => trace.curate?.plannerReason || trace.curate?.abstainReason || ""), 10),
    topProcessDecisions: reasonCounts(traces.map((trace) => trace.stageLabels?.processDecision ?? ""), 10),
    topDataSufficiency: reasonCounts(traces.map((trace) => trace.stageLabels?.dataSufficiency ?? ""), 10),
    topFinalContext: reasonCounts(traces.map((trace) => trace.stageLabels?.finalContext ?? ""), 10),
  };
}

function compositeMetric(evaluation?: ContextEvaluation): number {
  if (!evaluation) return 0.5;
  const { relevance, precision, recall } = evaluation.scores;
  return Math.max(0, Math.min(1, (0.35 * relevance) + (0.30 * precision) + (0.30 * recall) + (evaluation.taskOutcome === "completed" ? 0.05 : 0)));
}

function exampleFromTrace(trace: DspyTraceRecord, evaluation?: ContextEvaluation): DspyTrainingExample {
  const metric = compositeMetric(evaluation);
  return {
    stage: "planAndCurate",
    bundleId: trace.bundleId,
    focus: trace.focus,
    mode: trace.mode,
    input: {
      focus: trace.focus,
      mode: trace.mode,
      sourcePlan: trace.sourcePlan,
      indicators: trace.indicators,
      candidates: trace.candidates,
    },
    expected: {
      selectedSources: trace.selected.map((item) => item.source),
      selectedHandles: trace.selected.map((item) => item.handle),
      abstain: trace.curate.abstain,
      disposition: trace.disposition,
    },
    scores: evaluation?.scores,
    taskOutcome: evaluation?.taskOutcome,
    metric,
    weight: evaluation ? 1 : 0.35,
    reflection: evaluation?.reflection,
    improvementHint: evaluation?.improvementHint,
  };
}

export function exportDspyDataset(cwd: string, evaluations: ContextEvaluation[], options: { limit?: number; devRatio?: number } = {}): { trainPath: string; devPath: string; metaPath: string; train: number; dev: number; traces: number; matchedEvaluations: number; averageMetric: number; highScoringExamples: number; lowScoringExamples: number } {
  const traces = readDspyTraces(cwd, options.limit ?? 2000);
  const evalByBundle = new Map(evaluations.map((e) => [e.bundleId, e]));
  const examples = traces.map((trace) => exampleFromTrace(trace, evalByBundle.get(trace.bundleId)));
  const evaluatedExamples = examples.filter((example) => Boolean(example.scores));
  const averageMetric = evaluatedExamples.length
    ? evaluatedExamples.reduce((sum, example) => sum + example.metric, 0) / evaluatedExamples.length
    : 0;
  const highScoringExamples = evaluatedExamples.filter((example) => example.metric >= 0.8).length;
  const lowScoringExamples = evaluatedExamples.filter((example) => example.metric < 0.6).length;
  const devRatio = Math.max(0.05, Math.min(0.5, options.devRatio ?? 0.2));
  const devEvery = Math.max(2, Math.round(1 / devRatio));
  const train: DspyTrainingExample[] = [];
  const dev: DspyTrainingExample[] = [];
  examples.forEach((example, index) => (index % devEvery === 0 ? dev : train).push(example));

  const dir = path.join(cwd, DSPY_DIR);
  mkdirSync(dir, { recursive: true });
  const trainPath = path.join(dir, "train.jsonl");
  const devPath = path.join(dir, "dev.jsonl");
  const metaPath = path.join(dir, "README.md");
  writeFileSync(trainPath, train.map(jsonlEscape).join("\n") + (train.length ? "\n" : ""));
  writeFileSync(devPath, dev.map(jsonlEscape).join("\n") + (dev.length ? "\n" : ""));
  writeFileSync(metaPath, [
    "# Sherpa DSPy Dataset",
    "",
    "Generated from `.pi-memory/sherpa-traces/*.jsonl` plus Obsidian Sherpa evaluations.",
    "Use these JSONL files with an offline DSPy-style prompt-feedback compiler or a real DSPy optimizer to compile retrieval/curation prompts.",
    "",
    `- traces: ${traces.length}`,
    `- evaluations matched: ${traces.filter((t) => evalByBundle.has(t.bundleId)).length}`,
    `- train examples: ${train.length}`,
    `- dev examples: ${dev.length}`,
    `- evaluated average metric: ${averageMetric.toFixed(3)}`,
    `- high-scoring evaluated examples: ${highScoringExamples}`,
    `- low-scoring evaluated examples: ${lowScoringExamples}`,
    "",
    "Primary metric suggestion: weighted relevance/precision/recall composite in each example's `metric` field.",
  ].join("\n"));

  return { trainPath, devPath, metaPath, train: train.length, dev: dev.length, traces: traces.length, matchedEvaluations: traces.filter((t) => evalByBundle.has(t.bundleId)).length, averageMetric, highScoringExamples, lowScoringExamples };
}
