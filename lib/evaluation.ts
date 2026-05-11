import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export type ContextBundleRecord = {
  bundleId: string;
  timestamp: number;
  focus: string;
  mode: string;
  items: Array<{
    handle: string;
    type: string;
    source: string;
    summary: string;
    inline?: boolean;
  }>;
};

export type ContextEvaluation = {
  bundleId: string;
  taskOutcome: "completed" | "partial" | "failed" | "reverted" | "blocked" | "unknown";
  scores: {
    relevance: number;   // 0-1: did context match user intent?
    precision: number;   // 0-1: how much was actually used?
    recall: number;      // 0-1: did we miss key things?
  };
  noise: string[];       // Sources that were distracting/irrelevant
  missed: string[];      // Important things we should have found
  reflection: string;    // Free-form analysis
  improvementHint: string; // One-line prompt addition for future retrieval
  evaluatedAt: string;
};

const EVAL_DIR = "wiki/evidence/sherpa-evaluations";

export function createBundleId(): string {
  return `bundle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function stashBundle(state: { bundleRecords?: Map<string, ContextBundleRecord> }, record: ContextBundleRecord): void {
  if (!state.bundleRecords) state.bundleRecords = new Map();
  state.bundleRecords.set(record.bundleId, record);
  // Keep only recent 20 to avoid memory bloat
  const keys = [...state.bundleRecords.keys()];
  for (const k of keys.slice(0, keys.length - 20)) state.bundleRecords.delete(k);
}

export function getBundle(state: { bundleRecords?: Map<string, ContextBundleRecord> }, bundleId: string): ContextBundleRecord | undefined {
  return state.bundleRecords?.get(bundleId);
}

export function writeEvaluation(projectRoot: string, evalRecord: ContextEvaluation): string {
  const dir = path.join(projectRoot, EVAL_DIR);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${evalRecord.bundleId}.md`);
  const note = [
    "---",
    `bundle_id: ${evalRecord.bundleId}`,
    `task_outcome: ${evalRecord.taskOutcome}`,
    `relevance: ${evalRecord.scores.relevance}`,
    `precision: ${evalRecord.scores.precision}`,
    `recall: ${evalRecord.scores.recall}`,
    `noise: [${evalRecord.noise.join(", ")}]`,
    `missed: [${evalRecord.missed.join(", ")}]`,
    `improvement_hint: ${JSON.stringify(evalRecord.improvementHint)}`,
    `evaluated_at: ${evalRecord.evaluatedAt}`,
    "type: evidence",
    "source: sherpa-self-evaluation",
    "---",
    "",
    `# Sherpa Evaluation: ${evalRecord.bundleId}`,
    "",
    "## Reflection",
    "",
    evalRecord.reflection,
    "",
  ].join("\n");
  writeFileSync(target, note);
  return target;
}

export function readRecentEvaluations(projectRoot: string, limit = 50): ContextEvaluation[] {
  const dir = path.join(projectRoot, EVAL_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, limit);

  const out: ContextEvaluation[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(path.join(dir, file), "utf8");
      const frontmatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatch) continue;
      const fm: Record<string, string> = {};
      for (const line of frontmatch[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      out.push({
        bundleId: fm.bundle_id ?? file.replace(/\.md$/, ""),
        taskOutcome: (fm.task_outcome as any) ?? "unknown",
        scores: {
          relevance: Number(fm.relevance ?? 0.5),
          precision: Number(fm.precision ?? 0.5),
          recall: Number(fm.recall ?? 0.5),
        },
        noise: tryParseArray(fm.noise),
        missed: tryParseArray(fm.missed),
        reflection: raw.replace(/^---[\s\S]*?---\n*/, "").trim(),
        improvementHint: JSON.parse(fm.improvement_hint ?? '""'),
        evaluatedAt: fm.evaluated_at ?? new Date().toISOString(),
      });
    } catch { /* ignore malformed */ }
  }
  return out;
}

function tryParseArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.replace(/^\[/, "[").replace(/\]$/, "]"));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function summarizeEvaluations(evals: ContextEvaluation[]): {
  averageRelevance: number;
  averagePrecision: number;
  averageRecall: number;
  topNoise: Array<{ source: string; count: number }>;
  topMissed: Array<{ pattern: string; count: number }>;
  topHints: Array<{ hint: string; count: number }>;
} {
  const avg = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const relevanceScores = evals.map((e) => e.scores.relevance);
  const precisionScores = evals.map((e) => e.scores.precision);
  const recallScores = evals.map((e) => e.scores.recall);

  const noiseCounts = new Map<string, number>();
  for (const e of evals) for (const n of e.noise) noiseCounts.set(n, (noiseCounts.get(n) ?? 0) + 1);

  const missedCounts = new Map<string, number>();
  for (const e of evals) for (const m of e.missed) missedCounts.set(m, (missedCounts.get(m) ?? 0) + 1);

  const hintCounts = new Map<string, number>();
  for (const e of evals) if (e.improvementHint) hintCounts.set(e.improvementHint, (hintCounts.get(e.improvementHint) ?? 0) + 1);

  return {
    averageRelevance: avg(relevanceScores),
    averagePrecision: avg(precisionScores),
    averageRecall: avg(recallScores),
    topNoise: [...noiseCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([source, count]) => ({ source, count })),
    topMissed: [...missedCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pattern, count]) => ({ pattern, count })),
    topHints: [...hintCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([hint, count]) => ({ hint, count })),
  };
}
