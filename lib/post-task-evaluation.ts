import type { ContextBundleRecord, ContextEvaluation, SherpaQualitySummary } from "./evaluation";
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

function genericSourceClass(source: string): "mission" | "archivist" | "readme" | "skill" | undefined {
  const normalized = source.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("docs/mission_prompt.md") || normalized.includes("docs/missions.md")) return "mission";
  if (normalized.includes("documentation-drift") || normalized.includes("archivist_actionable_solutions.md") || normalized.includes("/wiki/systems/archivist-sherpa-gap-analysis.md")) return "archivist";
  if (normalized.startsWith("file://~/.pi/agent/skills/")) return "skill";
  if (normalized === "repo://readme.md" || normalized.endsWith("/readme.md") || normalized.includes("/readme.md:")) return "readme";
  return undefined;
}

function focusAllowsGenericSource(source: string, focus = ""): boolean {
  const f = focus.toLowerCase();
  switch (genericSourceClass(source)) {
    case "mission": return /\b(mission|missions|orchestrator|worker|validator|validation contract)\b/.test(f);
    case "archivist": return /\b(archivist|preserve|distill|documentation drift|obsidian|memory routing)\b/.test(f);
    case "skill": return /\b(skill|skills|agent skill|load skill)\b/.test(f);
    case "readme": return /\b(readme|overview|onboard|onboarding|project summary)\b/.test(f);
    default: return false;
  }
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

export function evaluatePostTaskContext(input: PostTaskEvaluationInput): ContextEvaluation {
  // Recall ground truth should be task-local evidence only. The full git dirty
  // set often contains pre-existing work and creates false misses for lookup
  // prompts, so changedFiles is intentionally excluded from usedFiles.
  const usedFiles = uniq([
    ...input.files.readFiles,
    ...input.files.writtenFiles,
    ...(input.files.referencedFiles ?? []),
  ]);
  const items = input.bundle.items ?? [];
  const taskKind = classifyEvalTaskKind(input);
  const terms = intentTerms(input);
  const coveredFiles = usedFiles.filter((file) => items.some((item) => itemLooksUsefulForFile(item, file)));
  const missed = usedFiles.filter((file) => !coveredFiles.includes(file));

  const usefulSources = new Set<string>();
  for (const item of items) {
    if (usedFiles.some((file) => itemLooksUsefulForFile(item, file))) usefulSources.add(item.source);
    else if ((taskKind === "meta_analysis" || taskKind === "ops" || taskKind === "docs") && itemLooksUsefulForIntent(item, terms)) usefulSources.add(item.source);
  }

  const noise = items
    .filter((item) => !usefulSources.has(item.source) || isGenericNoise(item))
    .map((item) => item.source);

  const recall = usedFiles.length
    ? coveredFiles.length / usedFiles.length
    : (taskKind === "meta_analysis" || taskKind === "ops" || taskKind === "docs")
      ? (usefulSources.size ? 0.8 : (items.length ? 0.2 : 0.2))
      : (items.length ? 0.6 : 0.2);
  const precision = items.length ? usefulSources.size / items.length : 0;
  const genericNoisePenalty = items.some(isGenericNoise) ? 0.2 : 0;
  const outcomeBonus = input.outcome === "completed" ? 0.1 : input.outcome === "failed" ? -0.1 : 0;
  const relevance = clamp01((precision * 0.45) + (recall * 0.45) + outcomeBonus - genericNoisePenalty);

  const reflection = [
    `Automatic post-task evaluation for ${input.bundle.bundleId}.`,
    `Focus: ${input.bundle.focus}`,
    `Task kind: ${taskKind}.`,
    `Outcome: ${input.outcome}.`,
    `Used files: ${usedFiles.length ? usedFiles.join(", ") : "none detected"}.`,
    `Covered files: ${coveredFiles.length ? coveredFiles.join(", ") : "none"}.`,
    missed.length ? `Missed files: ${missed.join(", ")}.` : "No missed files detected from tool/change evidence.",
    noise.length ? `Noise sources: ${uniq(noise).join(", ")}.` : "No obvious noisy sources detected.",
  ].join("\n");

  const improvementHint = missed.length
    ? "Boost exact paths, filenames, and files later read/edited by the agent; penalize generic docs when source files are missed."
    : noise.length
      ? taskKind === "meta_analysis"
        ? "For meta-analysis, prefer evaluation evidence and system-memory notes; suppress generic mission/docs unless explicitly requested."
        : "Penalize repeated generic documentation snippets and meta-review docs unless the query asks for them."
      : "Keep concise source-grounded context and preserve current routing.";

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
    reflection,
    improvementHint,
    evaluatedAt: new Date().toISOString(),
  };
}

export function applyEvaluationFeedbackToCandidates<T extends { source: string; relevance: number }>(
  candidates: T[],
  evals: ContextEvaluation[],
  quality?: SherpaQualitySummary,
  options: { focus?: string } = {},
): T[] {
  if (!evals.length && !quality) return candidates;
  const noisy = new Map<string, number>();
  const missedPaths = new Map<string, number>();
  const missedTerms = new Map<string, number>();
  for (const ev of evals.slice(0, 50)) {
    for (const source of ev.noise) noisy.set(source, (noisy.get(source) ?? 0) + 1);
    for (const miss of ev.missed) {
      const normalizedMiss = normalizedPathFragment(miss);
      if (normalizedMiss) missedPaths.set(normalizedMiss, (missedPaths.get(normalizedMiss) ?? 0) + 1);
      for (const term of basenameTerms(miss)) missedTerms.set(term, (missedTerms.get(term) ?? 0) + 1);
    }
  }
  for (const item of quality?.topNoise ?? []) noisy.set(item.source, Math.max(noisy.get(item.source) ?? 0, item.count));
  for (const item of quality?.topMissed ?? []) {
    const normalizedMiss = normalizedPathFragment(item.pattern);
    if (normalizedMiss) missedPaths.set(normalizedMiss, Math.max(missedPaths.get(normalizedMiss) ?? 0, item.count));
    for (const term of basenameTerms(item.pattern)) missedTerms.set(term, Math.max(missedTerms.get(term) ?? 0, item.count));
  }
  return candidates.map((candidate) => {
    let delta = 0;
    const source = candidate.source.toLowerCase();
    const exactNoise = noisy.get(candidate.source) ?? 0;
    if (exactNoise) delta -= Math.min(0.6, 0.2 * exactNoise);
    if (isGenericNoiseSource(candidate.source) && !focusAllowsGenericSource(candidate.source, options.focus)) delta -= 0.45;
    for (const [missedPath, count] of missedPaths) {
      if (source.includes(missedPath)) delta += Math.min(0.5, 0.25 * count);
    }
    for (const [term, count] of missedTerms) {
      if (source.includes(term)) delta += Math.min(0.35, 0.12 * count);
    }
    if (!delta) return candidate;
    return { ...candidate, relevance: clamp01(candidate.relevance + delta) };
  });
}
