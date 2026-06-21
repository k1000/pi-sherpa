import type { ContextBundleRecord, ContextEvaluation, SherpaQualitySummary } from "./evaluation";
import { focusAllowsGenericSource, genericSourceClass } from "./generic-source";
import type { TaskOutcome } from "./lifecycle";

export type TaskFileEvidence = {
  readFiles: string[];
  writtenFiles: string[];
  /** Files explicitly mentioned/cited in the final answer or task transcript. */
  referencedFiles?: string[];
  /** Full git-status dirty set. Kept for diagnostics/backcompat; not recall ground truth. */
  changedFiles: string[];
};

export type EvalTaskKind = "code_edit" | "debug" | "docs" | "meta_analysis" | "ops" | "unknown";

export type PostTaskEvaluationInput = {
  bundle: ContextBundleRecord;
  outcome: TaskOutcome;
  files: TaskFileEvidence;
  finalText?: string;
};

function uniq(items: string[]): string[] {
  return [...new Set(items.map((s) => s.replace(/\\/g, "/")).filter(Boolean))];
}

export function sourceToRepoPath(source: string): string | undefined {
  if (!source.startsWith("repo://")) return undefined;
  const withoutScheme = source.slice("repo://".length);
  const lineTrimmed = withoutScheme.replace(/:\d+(?::\d+)?$/, "");
  return lineTrimmed.replace(/^\/+/, "");
}

function sourceCoversPath(source: string, file: string): boolean {
  const repoPath = sourceToRepoPath(source);
  if (!repoPath) return false;
  const normalizedSource = repoPath.toLowerCase();
  const normalizedFile = file.replace(/\\/g, "/").toLowerCase();
  return normalizedFile === normalizedSource || normalizedFile.startsWith(`${normalizedSource.replace(/\/$/, "")}/`);
}

const GENERIC_BASENAME_TERMS = new Set([
  "page.tsx", "page",
  "index.ts", "index",
  "types.ts", "types",
  "actions.ts", "actions",
  "queries.ts", "queries",
  "skill.md", "skill",
]);

function basenameTerms(file: string): string[] {
  const base = file.split("/").pop() ?? file;
  const stem = base.replace(/\.[^.]+$/, "");
  return [base, stem]
    .filter((s) => s.length >= 4)
    .map((s) => s.toLowerCase())
    .filter((s) => !GENERIC_BASENAME_TERMS.has(s));
}

function normalizedPathFragment(file: string): string {
  return file.replace(/\\/g, "/").replace(/^repo:\/\//, "").replace(/^\/+/, "").toLowerCase();
}

function isGenericNoiseSource(source: string): boolean {
  return Boolean(genericSourceClass(source));
}

function genericNoiseReason(item: ContextBundleRecord["items"][number]): string | undefined {
  const text = `${item.source}\n${item.summary}`.toLowerCase();
  if (text.includes("if websocket fails, stick falls back")) return "stale device fallback snippet";
  if (text.includes("falls back to get /agent/jobs/{id} polling")) return "stale polling fallback snippet";
  if (text.includes("sherpa returned low-confidence context")) return "meta retrieval note";
  if (text.includes("surface route contamination warnings")) return "meta retrieval warning";
  if (isGenericNoiseSource(item.source)) return "generic/meta source class";
  return undefined;
}

function itemLooksUsefulForFile(item: ContextBundleRecord["items"][number], file: string): boolean {
  if (sourceCoversPath(item.source, file)) return true;
  const haystack = `${item.source}\n${item.summary}`.toLowerCase();
  return basenameTerms(file).some((term) => haystack.includes(term));
}

function isGenericNoise(item: ContextBundleRecord["items"][number]): boolean {
  return Boolean(genericNoiseReason(item));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function isDocumentationFile(file: string): boolean {
  return /(^|\/)(readme|docs?|documentation|adr|adrs)(\/|\.|$)/i.test(file) || /\.(md|mdx|rst|adoc|txt)$/i.test(file);
}

function isSourceFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|php|rb|sql|json|ya?ml|toml)$/i.test(file) && !isDocumentationFile(file);
}

export function classifyEvalTaskKind(input: PostTaskEvaluationInput): EvalTaskKind {
  const text = `${input.bundle.focus}\n${input.finalText ?? ""}`.toLowerCase();
  const touched = uniq([...input.files.readFiles, ...input.files.writtenFiles, ...(input.files.referencedFiles ?? [])]);
  if (input.files.writtenFiles.some(isSourceFile)) return "code_edit";
  if (input.files.writtenFiles.length && input.files.writtenFiles.every(isDocumentationFile)) return "docs";
  if (/\b(error|exception|crash|failed|failing|bug|debug|investigate|fix)\b/.test(text)) return "debug";
  if (/\b(review|assess|evaluate|performance|quality|across projects|all projects|pathway|recommendations?|sherpa|serpa|retrieval evaluation)\b/.test(text)) return "meta_analysis";
  if (/\b(restart|reload|deploy|service|server|process|logs?|status|health|ssh|port)\b/.test(text)) return "ops";
  if (touched.length && touched.every(isDocumentationFile)) return "docs";
  if (touched.some(isSourceFile)) return "code_edit";
  return "unknown";
}

const INTENT_STOPWORDS = new Set([
  "about", "after", "again", "based", "before", "current", "files", "from", "good", "into", "need", "problems", "project", "projects", "review", "should", "task", "there", "those", "where", "with", "would",
]);

function intentTerms(input: PostTaskEvaluationInput): string[] {
  const text = `${input.bundle.focus}\n${input.finalText ?? ""}`.toLowerCase();
  return uniq((text.match(/[a-z][a-z0-9_-]{4,}/g) ?? [])
    .map((term) => term.replace(/[-_]/g, ""))
    .filter((term) => !INTENT_STOPWORDS.has(term)))
    .slice(0, 40);
}

function itemLooksUsefulForIntent(item: ContextBundleRecord["items"][number], terms: string[]): boolean {
  if (!terms.length || isGenericNoise(item)) return false;
  const haystack = `${item.source}\n${item.summary}`.toLowerCase().replace(/[-_]/g, "");
  return terms.some((term) => haystack.includes(term));
}

function evaluationUsedFiles(input: PostTaskEvaluationInput): string[] {
  // Recall ground truth should be task-local evidence only. The full git dirty
  // set often contains pre-existing work and creates false misses for lookup
  // prompts, so changedFiles is intentionally excluded from usedFiles.
  return uniq([
    ...input.files.readFiles,
    ...input.files.writtenFiles,
    ...(input.files.referencedFiles ?? []),
  ]);
}

function usefulSourcesForEvaluation(items: ContextBundleRecord["items"], usedFiles: string[], taskKind: EvalTaskKind, terms: string[]): Set<string> {
  const usefulSources = new Set<string>();
  for (const item of items) {
    if (usedFiles.some((file) => itemLooksUsefulForFile(item, file))) usefulSources.add(item.source);
    else if ((taskKind === "meta_analysis" || taskKind === "ops" || taskKind === "docs") && itemLooksUsefulForIntent(item, terms)) usefulSources.add(item.source);
  }
  return usefulSources;
}

function evaluationRecall(usedFiles: string[], coveredFiles: string[], usefulSources: Set<string>, items: ContextBundleRecord["items"], taskKind: EvalTaskKind): number {
  if (usedFiles.length) return coveredFiles.length / usedFiles.length;
  if (taskKind === "meta_analysis" || taskKind === "ops" || taskKind === "docs") return usefulSources.size ? 0.8 : 0.2;
  return items.length ? 0.6 : 0.2;
}

function evaluationImprovementHint(missed: string[], noise: string[], taskKind: EvalTaskKind): string {
  if (missed.length) return "Boost exact paths, filenames, and files later read/edited by the agent; penalize generic docs when source files are missed.";
  if (!noise.length) return "Keep concise source-grounded context and preserve current routing.";
  return taskKind === "meta_analysis"
    ? "For meta-analysis, prefer evaluation evidence and system-memory notes; suppress generic mission/docs unless explicitly requested."
    : "Penalize repeated generic documentation snippets and meta-review docs unless the query asks for them.";
}

function retrievalVerdict(scores: { relevance: number; precision: number; recall: number }): string {
  if (scores.relevance >= 0.7 && scores.precision >= 0.6 && scores.recall >= 0.6) return "useful";
  if (scores.relevance >= 0.35 || scores.precision >= 0.4 || scores.recall >= 0.4) return "partial";
  return "miss";
}

function evaluationReflection(input: PostTaskEvaluationInput, taskKind: EvalTaskKind, usedFiles: string[], coveredFiles: string[], missed: string[], noise: string[], scores: { relevance: number; precision: number; recall: number }): string {
  const verdict = retrievalVerdict(scores);
  return [
    `Automatic post-task evaluation for ${input.bundle.bundleId}.`,
    `Focus: ${input.bundle.focus}`,
    `Task kind: ${taskKind}.`,
    `Outcome: ${input.outcome}.`,
    `Retrieval verdict: ${verdict} (relevance=${scores.relevance}, precision=${scores.precision}, recall=${scores.recall}).`,
    `Used files: ${usedFiles.length ? usedFiles.join(", ") : "none detected"}.`,
    `Covered files: ${coveredFiles.length ? coveredFiles.join(", ") : "none"}.`,
    missed.length ? `Missed files: ${missed.join(", ")}.` : "No missed files detected from tool/change evidence.",
    noise.length ? `Noise sources: ${uniq(noise).join(", ")}.` : "No obvious noisy sources detected.",
    verdict === "miss" ? "Likely cause: selected context did not overlap the files or intent evidence seen during the task; improve routing, exact path matching, or source filtering." : "Likely cause: selected context overlapped enough task evidence to be useful; keep tuning noisy and missed sources from the lists above.",
  ].join("\n");
}

export function evaluatePostTaskContext(input: PostTaskEvaluationInput): ContextEvaluation {
  const usedFiles = evaluationUsedFiles(input);
  const items = input.bundle.items ?? [];
  const taskKind = classifyEvalTaskKind(input);
  const coveredFiles = usedFiles.filter((file) => items.some((item) => itemLooksUsefulForFile(item, file)));
  const missed = usedFiles.filter((file) => !coveredFiles.includes(file));
  const usefulSources = usefulSourcesForEvaluation(items, usedFiles, taskKind, intentTerms(input));
  const noise = items.filter((item) => !usefulSources.has(item.source) || isGenericNoise(item)).map((item) => item.source);
  const recall = evaluationRecall(usedFiles, coveredFiles, usefulSources, items, taskKind);
  const precision = items.length ? usefulSources.size / items.length : 0;
  const genericNoisePenalty = items.some(isGenericNoise) ? 0.2 : 0;
  const outcomeBonus = input.outcome === "completed" ? 0.1 : input.outcome === "failed" ? -0.1 : 0;
  const relevance = clamp01((precision * 0.45) + (recall * 0.45) + outcomeBonus - genericNoisePenalty);

  return {
    bundleId: input.bundle.bundleId,
    taskOutcome: input.outcome,
    scores: {
      relevance: Number(relevance.toFixed(2)),
      precision: Number(clamp01(precision).toFixed(2)),
      recall: Number(clamp01(recall).toFixed(2)),
    },
    noise: uniq(noise).slice(0, 20),
    missed: missed.slice(0, 20),
    reflection: evaluationReflection(input, taskKind, usedFiles, coveredFiles, missed, noise, { relevance, precision, recall }),
    improvementHint: evaluationImprovementHint(missed, noise, taskKind),
    evaluatedAt: new Date().toISOString(),
  };
}

type FeedbackSignals = {
  noisy: Map<string, number>;
  missedPaths: Map<string, number>;
  missedTerms: Map<string, number>;
};

function incrementSignal(map: Map<string, number>, key: string, count = 1): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function maxSignal(map: Map<string, number>, key: string, count: number): void {
  map.set(key, Math.max(map.get(key) ?? 0, count));
}

function addMissedPattern(signals: FeedbackSignals, pattern: string, count: number, mode: "increment" | "max"): void {
  const normalizedMiss = normalizedPathFragment(pattern);
  const update = mode === "increment" ? incrementSignal : maxSignal;
  if (normalizedMiss) update(signals.missedPaths, normalizedMiss, count);
  for (const term of basenameTerms(pattern)) update(signals.missedTerms, term, count);
}

function feedbackSignals(evals: ContextEvaluation[], quality?: SherpaQualitySummary): FeedbackSignals {
  const signals: FeedbackSignals = { noisy: new Map(), missedPaths: new Map(), missedTerms: new Map() };
  for (const ev of evals.slice(0, 50)) {
    for (const source of ev.noise) incrementSignal(signals.noisy, source);
    for (const miss of ev.missed) addMissedPattern(signals, miss, 1, "increment");
  }
  for (const item of quality?.topNoise ?? []) maxSignal(signals.noisy, item.source, item.count);
  for (const item of quality?.topMissed ?? []) addMissedPattern(signals, item.pattern, item.count, "max");
  return signals;
}

function missedSignalDelta(source: string, signals: FeedbackSignals): number {
  let delta = 0;
  for (const [missedPath, count] of signals.missedPaths) {
    if (source.includes(missedPath)) delta += Math.min(0.6, 0.3 * count);
  }
  for (const [term, count] of signals.missedTerms) {
    if (source.includes(term)) delta += Math.min(0.35, 0.12 * count);
  }
  return delta;
}

function candidateFeedbackDelta(candidate: { source: string }, signals: FeedbackSignals, focus?: string): number {
  const exactNoise = signals.noisy.get(candidate.source) ?? 0;
  const noiseDelta = exactNoise ? -Math.min(0.9, 0.25 * exactNoise) : 0;
  const genericDelta = isGenericNoiseSource(candidate.source) && !focusAllowsGenericSource(candidate.source, focus) ? -0.55 : 0;
  return noiseDelta + genericDelta + missedSignalDelta(candidate.source.toLowerCase(), signals);
}

export function applyEvaluationFeedbackToCandidates<T extends { source: string; relevance: number }>(
  candidates: T[],
  evals: ContextEvaluation[],
  quality?: SherpaQualitySummary,
  options: { focus?: string } = {},
): T[] {
  if (!evals.length && !quality) return candidates;
  const signals = feedbackSignals(evals, quality);
  return candidates.map((candidate) => {
    const delta = candidateFeedbackDelta(candidate, signals, options.focus);
    return delta ? { ...candidate, relevance: clamp01(candidate.relevance + delta) } : candidate;
  });
}
