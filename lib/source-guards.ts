/** Source/focus guard predicates for retrieval filtering and ranking. */

type SourceLike = { type: string; source: string };
type StickySnippetLike = { type: string; source: string; summary: string; raw?: string };

export function isPackageManifestSource(source: string) {
  return /(?:^|\/)package\.json(?::\d+)?$/i.test(source.replace(/^repo:\/\//, ""))
    || /(?:^|\/)pnpm-workspace\.ya?ml(?::\d+)?$/i.test(source.replace(/^repo:\/\//, ""))
    || /(?:^|\/)\.fallowrc\.json(?::\d+)?$/i.test(source.replace(/^repo:\/\//, ""));
}

export function focusAllowsPackageManifest(focus: string) {
  return /\b(package\.json|pnpm|workspace|dependency|dependencies|script|scripts|npm|yarn|bun|fallow|manifest)\b/i.test(focus);
}

export function focusAllowsGitStatus(focus: string) {
  return /\b(git status|dirty|changed files?|uncommitted|commit|diff|staged|unstaged|review changes?|what changed)\b/i.test(focus);
}

export function focusAllowsResearchMemory(focus: string) {
  return /\b(research|paper|papers|arxiv|literature|study|studies|article|source material|external source|ai research|rag|graphrag|hipporag|sage)\b/i.test(focus);
}

export function focusAllowsHistoricalMemory(focus: string) {
  return /\b(previous|earlier|history|historical|journal|timeline|session|last time|recent session|past session|what happened|we discussed)\b/i.test(focus);
}

export function isHistoricalMemorySource(item: SourceLike) {
  const source = item.source.toLowerCase();
  return source.startsWith("kb://journal/") || source.includes("/journal/") || item.type === "session_recent";
}

export function isStickyGenericSnippet(item: StickySnippetLike) {
  const text = `${item.source}\n${item.summary}\n${item.raw ?? ""}`.toLowerCase();
  return text.includes("if websocket fails, stick falls back")
    || text.includes("falls back to get /agent/jobs/{id} polling")
    || text.includes("sherpa returned low-confidence context instead of abstaining")
    || text.includes("surface route contamination warnings when route names/paths do not exist");
}

export function permitsRootReadme(focus: string) {
  return /\b(root\s+readme|readme\.md|eth-lag-alpha|repo overview|project overview)\b/i.test(focus);
}

export function isRootReadmeSource(source: string) {
  const normalized = source.replace(/\\/g, "/").toLowerCase();
  return normalized === "repo://readme.md" || normalized.startsWith("repo://readme.md:");
}

export function isGenericNoiseSource(source: string) {
  const normalized = source.replace(/\\/g, "/").toLowerCase();
  return normalized === "repo://readme.md"
    || normalized.endsWith("/readme.md")
    || normalized.includes("/readme.md:")
    || normalized.startsWith("file://~/.pi/agent/skills/")
    || normalized.includes("/wiki/systems/archivist-sherpa-gap-analysis.md");
}
