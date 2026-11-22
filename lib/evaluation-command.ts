import {
  summarizeEvaluations,
  type ContextBundleRecord,
  type ContextEvaluation,
} from "./evaluation";

const EVALUATION_OUTCOMES = ["completed", "partial", "failed", "reverted", "blocked", "unknown"] as const;
type EvaluationOutcome = typeof EVALUATION_OUTCOMES[number];

function isEvaluationOutcome(value: string | undefined): value is EvaluationOutcome {
  return Boolean(value && (EVALUATION_OUTCOMES as readonly string[]).includes(value));
}

function clamp01(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function shiftScore(parts: string[], fallback: number): number {
  if (!parts.length) return fallback;
  const n = Number(parts[0]);
  if (!Number.isFinite(n)) return fallback;
  parts.shift();
  return clamp01(n, fallback);
}

export function parseEvaluationArgs(
  args: string | undefined,
  lastBundleId: string | undefined,
  lookupBundle: (bundleId: string) => ContextBundleRecord | undefined,
) {
  // Copy the array so that shiftScore's internal .shift() only mutates
  // our local copy, never the caller's argument.
  const parts = [...((args ?? "").trim().split(/\s+/).filter(Boolean))];
  const bundleId = parts[0]?.startsWith("bundle-") ? parts.shift()! : lastBundleId;
  const bundle = bundleId ? lookupBundle(bundleId) : undefined;
  const taskOutcome = isEvaluationOutcome(parts[0]) ? parts.shift()! : "unknown";
  return {
    bundleId,
    bundle,
    taskOutcome: taskOutcome as EvaluationOutcome,
    relevance: shiftScore(parts, bundle?.items.length ? 0.8 : 0.2),
    precision: shiftScore(parts, 0.6),
    recall: shiftScore(parts, 0.6),
    reflection: parts.join(" "),
  };
}

export function defaultEvaluationReflection(bundleId: string, bundle?: ContextBundleRecord): string {
  return bundle
    ? `Manual evaluation for ${bundle.bundleId}: ${bundle.items.length} item(s) returned for ${bundle.focus}`
    : `Manual evaluation for missing bundle ${bundleId}`;
}

export function evaluationImprovementHint(recall: number): string {
  return recall < 0.6
    ? "Prefer exact path and symbol matches before fuzzy project-orientation files."
    : "Keep concise source-grounded context and suppress noisy generic matches.";
}

export function formatEvaluationSummary(evals: ContextEvaluation[]): string {
  const summary = summarizeEvaluations(evals);
  return [
    `Sherpa evaluations: ${evals.length}`,
    `avg relevance=${summary.averageRelevance.toFixed(2)} precision=${summary.averagePrecision.toFixed(2)} recall=${summary.averageRecall.toFixed(2)}`,
    summary.averageConfidenceError > 0
      ? `avg confidenceError=${summary.averageConfidenceError.toFixed(3)} (0 = perfectly calibrated)`
      : "confidenceError: no planner confidence data yet",
    `top noise: ${summary.topNoise.map(n => `${n.source}×${n.count}`).join(", ") || "none"}`,
    `top missed: ${summary.topMissed.map(m => `${m.pattern}×${m.count}`).join(", ") || "none"}`,
    `top hints: ${summary.topHints.slice(0, 3).map(h => h.hint).join(" | ") || "none"}`,
  ].join("\n");
}
