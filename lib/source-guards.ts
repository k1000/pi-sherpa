/** Source/focus guard predicates for retrieval filtering and ranking. */

type SourceLike = { type: string; source: string };
type StickySnippetLike = { type: string; source: string; summary: string; raw?: string };
type RelevanceItemLike = { type: string; source: string; relevance: number };

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

export function isSmallEditCandidate(focus: string, items: RelevanceItemLike[]) {
  const f = focus.toLowerCase();
  if (!/\b(fix|update|add|change|replace|correct)\b/.test(f)) return false;
  if (!/\b(typo|readme|doc|docs|markdown|comment|config|setting|prompt|prd|route map|route-map)\b/.test(f)) return false;
  const fileItems = items.filter(i => i.type.includes("file") || i.type.includes("doc"));
  return fileItems.length > 0 && fileItems.length <= 3 && items[0].relevance >= 0.35;
}

const GENERIC_NOISE_PATHS = [
  "/readme.md",
  "docs/mission_prompt.md",
  "docs/missions.md",
  "documentation-drift",
  "archivist_actionable_solutions.md",
  "/.pi/agent/skills/",
];

const GENERIC_NOISE_NEEDED: Array<{ path: string; focusRe: RegExp }> = [
  { path: "docs/mission_prompt.md", focusRe: /\b(mission|missions|orchestrator|worker|validator|validation contract)\b/i },
  { path: "docs/missions.md", focusRe: /\b(mission|missions|orchestrator|worker|validator|validation contract)\b/i },
  { path: "documentation-drift", focusRe: /\b(archivist|preserve|distill|documentation drift|obsidian|memory routing)\b/i },
  { path: "archivist_actionable_solutions.md", focusRe: /\b(archivist|preserve|distill|documentation drift|obsidian|memory routing)\b/i },
  { path: "/.pi/agent/skills/", focusRe: /\b(skill|skills|agent skill|load skill)\b/i },
  { path: "/readme.md", focusRe: /\b(readme|overview|onboard|onboarding|project summary)\b/i },
];

export function isGenericNoiseExplicitlyNeeded(source: string, focus: string): boolean {
  return GENERIC_NOISE_NEEDED.some((n) => source.includes(n.path) && n.focusRe.test(focus));
}

export function isGenericNoisePath(source: string): boolean {
  return GENERIC_NOISE_PATHS.some((p) => source.endsWith(p) || source.includes(p));
}

export function isLikelyGenericOpeningNoise(item: RelevanceItemLike, focus = ""): boolean {
  const source = item.source.toLowerCase();
  if (isGenericNoiseExplicitlyNeeded(source, focus.toLowerCase())) return false;
  return item.relevance < 0.25 || isGenericNoisePath(source);
}

export function fileSnippetAllowed(sourcePath: string, focus: string, mode: string) {
  if (mode !== "front-door") return true;
  const p = sourcePath.replace(/\\/g, "/").toLowerCase();
  const f = focus.toLowerCase();
  const wantsPi = /\b(pi|sherpa|agent|skill|theme|extension)\b/.test(f);
  const wantsEnv = /\b(env|environment|token|secret|config|configuration)\b/.test(f);
  if (!wantsPi && /(^|\/)\.pi\//.test(p)) return false;
  if (!wantsEnv && /(^|\/)\.env/.test(p)) return false;
  if (/implementation_summary\.md|backtest_results\.md|\.rsync-exclude|docker-compose|dockerfile/.test(p)) return false;
  return true;
}
