import { focusAllowsGenericSource, genericSourceClass } from "./generic-source";
import { isGloballyNoisySource } from "./noise-filter";
import { computeLifecycleStage, type LifecycleStage } from "./lifecycle";
import { isCodePrompt, isSourceLookupPrompt } from "./query-classifier";
import { extractQueryTarget } from "./query-target";
import {
  focusAllowsGitStatus,
  focusAllowsHistoricalMemory,
  focusAllowsInquirerMemory,
  focusAllowsPackageManifest,
  focusAllowsResearchMemory,
  isGenericNoiseSource,
  isHistoricalMemorySource,
  isPackageManifestSource,
  isRootReadmeSource,
  isStickyGenericSnippet,
  permitsRootReadme,
  focusAllowsSurrealMemory,
  isRuntimeLogSource,
  isSherpaTraceSource,
  focusAllowsRuntimeLogs,
  focusAllowsSherpaTraces,
} from "./source-guards";

type ContextItemLike = {
  type: string;
  source: string;
  summary: string;
  raw?: string;
  relevance: number;
  lastAccessedAt?: number;
  accessCount?: number;
  lifecycle_stage?: LifecycleStage;
  confidence?: number;
};

export function sourceCorrespondenceThreshold(focus: string, mode: string) {
  const wantsSource = isCodePrompt(focus) || isSourceLookupPrompt(focus);
  if (mode === "front-door") return wantsSource ? 0.16 : 0.08;
  if (mode === "explicit") return wantsSource ? 0.22 : 0.14;
  return wantsSource ? 0.16 : 0.08;
}

export function sourceDedupeKey(source: string) {
  if (source.startsWith("repo://README.md")) return "repo://README.md";
  return source.replace(/:\d+(?::\d+)?$/, "");
}

/**
 * True when a URL candidate merely echoes a URL the user already typed in the
 * prompt. Re-emitting it as retrieved context adds no information.
 */
export function focusMentionsUrl(focus: string, source: string) {
  const url = source.trim().replace(/\/+$/, "");
  return url.length > 8 && (focus.includes(url) || focus.includes(`${url}/`));
}

/**
 * True when a manifest's own package directory is named in the prompt, e.g. the
 * focus mentions `tdd_loop` and the candidate is `.../tdd_loop/package.json`.
 * In that case the manifest is on-topic even without generic dependency words.
 */
export function focusMentionsPackageDir(focus: string, source: string) {
  const path = source.replace(/^repo:\/\//, "").replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?$/, "");
  const parts = path.split("/").filter(Boolean);
  const dir = parts.length >= 2 ? parts[parts.length - 2] : "";
  return dir.length >= 3 && focus.toLowerCase().includes(dir.toLowerCase());
}

export function candidateSortKey(item: ContextItemLike, focus: string, mode: string, now?: number) {
  const wantsSource = isCodePrompt(focus) || isSourceLookupPrompt(focus);
  const target = extractQueryTarget(focus);
  const isEvalQuery = /\b(eval|metrics|quality|relevance|precision|recall|improvement)\b/i.test(focus);
  let value = item.relevance;
  if (wantsSource) {
    value += item.type === "file" ? 0.35
      : item.type === "doc_snippet" ? -0.25
      : 0;
  }
  const haystack = `${item.source}\n${item.summary}\n${item.raw ?? ""}`.toLowerCase();
  const targetHits = target.targetTerms.filter((term) => haystack.includes(term.replace(/[-_]/g, "")) || haystack.replace(/[-_]/g, "").includes(term.replace(/[-_]/g, ""))).length;
  if (targetHits) value += Math.min(0.45, targetHits * 0.12);
  if (target.evidenceType === "code" && (item.type.includes("file") || item.type.includes("semantic_code"))) value += 0.18;
  if (item.type === "pi_extension_route") value -= target.evidenceType === "code" || wantsSource ? 0.75 : 0.35;
  if (target.evidenceType === "docs" && item.type.includes("doc")) value += 0.14;
  if (isGloballyNoisySource(item.source)) value -= 2.0;
  if (item.source.includes("sherpa-evaluations") && !isEvalQuery) value -= 0.6;
  if ((target.targetTerms.length > 0) && (target.targetTerms.some((term) => item.source.includes(term) || item.summary.toLowerCase().includes(term)))) {
    value += 0.2;
  }
  if (item.type === "git_status" && !focusAllowsGitStatus(focus)) value -= 2.0;
  if (item.type === "research_memory" && !focusAllowsResearchMemory(focus)) value -= 1.5;
  if (item.type === "inquirer_memory" && !focusAllowsInquirerMemory(focus)) value -= 1.0;
  if (isHistoricalMemorySource(item) && !focusAllowsHistoricalMemory(focus)) value -= 1.2;
  if (isPackageManifestSource(item.source) && !focusAllowsPackageManifest(focus) && !focusMentionsPackageDir(focus, item.source)) value -= wantsSource ? 0.65 : 0.25;
  if (isRootReadmeSource(item.source) && !permitsRootReadme(focus)) value -= 1.0;
  if (item.source === "repo://README.md") value -= wantsSource ? 0.35 : 0.15;
  if (isGenericNoiseSource(item.source)) value -= wantsSource ? 0.3 : 0.12;
  if (isStickyGenericSnippet(item)) value -= 0.5;
  if (/repo:\/\/(docs\/sherpa-|\.pi\/sherpa-)/.test(item.source) && !/\bsherpa\b/i.test(focus)) value -= 0.45;
  const lifecycleStage = item.lifecycle_stage ?? computeLifecycleStage(item.lastAccessedAt, item.confidence, now ?? Date.now());
  if (lifecycleStage === "archived") return Number.NEGATIVE_INFINITY;
  if (lifecycleStage === "fading") value *= 0.5;
  // Apply ACT-R recency + frequency boost: 0.6 original + 0.2 recency + 0.2 frequency
  const halfLifeDays = 14;
  const baselineCount = 5;
  const recencyScore = item.lastAccessedAt !== undefined
    ? decayScore(item.lastAccessedAt, now ?? Date.now(), halfLifeDays)
    : 1.0;
  const freqScore = frequencyScore(item.accessCount ?? 0, baselineCount);
  value = 0.6 * value + 0.2 * recencyScore + 0.2 * freqScore;
  return value;
}

const CODE_KIND_TYPES = new Set(["file", "pi_extension_file", "file_exact"]);

/** Directory key for context diversity (last 4 path components). */
export function parentDirKey(source: string): string {
  const p = source.replace(/^repo:\/\//, "").replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?$/, "");
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.slice(-4).join("/");
}

/**
 * True when a `file_exact` source points at a bare directory or filesystem root
 * with no filename. A directory listing is not usable context on its own.
 */
function isBareDirectorySource(source: string) {
  const p = source.replace(/^repo:\/\//, "").replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?$/, "").replace(/\/+$/, "");
  const last = p.split("/").filter(Boolean).pop() ?? "";
  return last.length > 0 && !last.includes(".");
}

/** Sherpa's own config file is only relevant to Sherpa-specific prompts. */
function isSherpaOwnConfigSource(source: string) {
  return /(?:^|\/)sherpa\.config\.json(?::\d+)?$/i.test(source.replace(/^repo:\/\//, "").replace(/^file:\/\//, ""));
}

function focusAllowsSherpaConfig(focus: string) {
  return /\b(sherpa|sidecar)\b/i.test(focus);
}

/**
 * Agent-managed index/route tables (memory catalog, extension route map). They
 * describe the agent's own wiring, not the user's project, so they only belong in
 * context when the prompt is actually about catalogs or routing.
 */
function isAgentMetadataIndex(source: string) {
  return /(?:^|\/)(?:catalog\.csv|routes\.csv|routes\.md)(?::\d+)?$/i.test(source.replace(/^repo:\/\//, "").replace(/^file:\/\//, ""));
}

function focusAllowsAgentMetadata(focus: string) {
  return /\b(catalog|route|routes|routing|index|taxonomy|table)\b/i.test(focus);
}

/**
 * kb:// durable memory is a precision risk: a note with no lexical connection to
 * the prompt is almost never the context the agent needs. Requires at least one
 * query-target term (>=3 chars) to appear in the candidate text.
 */
function projectMemoryMatchesFocus(item: ContextItemLike, focus: string) {
  const terms = extractQueryTarget(focus).targetTerms
    .map((term) => term.toLowerCase().replace(/[-_]/g, ""))
    .filter((term) => term.length >= 3);
  if (!terms.length) return true;
  const haystack = `${item.source}\n${item.summary}\n${item.raw ?? ""}`.toLowerCase().replace(/[-_]/g, "");
  return terms.some((term) => haystack.includes(term));
}

export function postProcessCandidates<T extends ContextItemLike>(candidates: T[], focus: string, mode: string, now?: number): T[] {
  const wantsSource = isCodePrompt(focus) || isSourceLookupPrompt(focus);
  const _now = now ?? Date.now();
  const sorted = [...candidates].sort((a, b) => candidateSortKey(b, focus, mode, _now) - candidateSortKey(a, focus, mode, _now));
  const out: T[] = [];
  const seen = new Set<string>();
  let readmeCount = 0;
  for (const item of sorted) {
    const lifecycleStage = item.lifecycle_stage ?? computeLifecycleStage(item.lastAccessedAt, item.confidence, _now);
    if (lifecycleStage === "archived") continue;
    if (isGloballyNoisySource(item.source)) continue;
    if (genericSourceClass(item.source) && !focusAllowsGenericSource(item.source, focus)) continue;
    if (item.type === "git_status" && !focusAllowsGitStatus(focus)) continue;
    if (item.type === "research_memory" && !focusAllowsResearchMemory(focus)) continue;
    if (item.type === "inquirer_memory" && !focusAllowsInquirerMemory(focus)) continue;
    if (isHistoricalMemorySource(item) && !focusAllowsHistoricalMemory(focus)) continue;
    if (item.type === "project_memory" && !projectMemoryMatchesFocus(item, focus)) continue;
    if ((item.type === "file_exact" || item.type === "file" || item.type === "file_snippet") && isBareDirectorySource(item.source)) continue;
    if (isSherpaOwnConfigSource(item.source) && !focusAllowsSherpaConfig(focus)) continue;
    if (isAgentMetadataIndex(item.source) && !focusAllowsAgentMetadata(focus)) continue;
    if (isPackageManifestSource(item.source) && !focusAllowsPackageManifest(focus) && wantsSource && !focusMentionsPackageDir(focus, item.source)) continue;
    if (item.type === "surreal_memory" && !focusAllowsSurrealMemory(focus)) continue;
    if (isRuntimeLogSource(item.source) && !focusAllowsRuntimeLogs(focus)) continue;
    // Sherpa's own traces additionally require a Sherpa-specific trace/log/metrics
    // question: generic "logs" or "trace provenance" prompts are about other systems.
    if (isSherpaTraceSource(item.source) && !focusAllowsSherpaTraces(focus)) continue;
    if (item.type === "url_reference" && focusMentionsUrl(focus, item.source)) continue;
    const key = sourceDedupeKey(item.source);
    if (seen.has(key)) continue;
    if (isRootReadmeSource(item.source)) {
      if (!permitsRootReadme(focus)) continue;
      if (readmeCount >= 1) continue;
      if (wantsSource && isStickyGenericSnippet(item)) continue;
      readmeCount++;
    }
    if (candidateSortKey(item, focus, mode, _now) < sourceCorrespondenceThreshold(focus, mode)) continue;
    if (wantsSource && /repo:\/\/(docs\/sherpa-|\.pi\/sherpa-)/.test(item.source) && !/\bsherpa\b/i.test(focus)) continue;
    seen.add(key);
    out.push(item);
  }
  // Context diversity: don't spend the whole top slots on one directory or on one
  // kind. Extras are kept but pushed behind candidates from other directories and
  // kinds. Route stubs (directory pointers) are content-free, so they rank last.
  const primary: T[] = [];
  const overflow: T[] = [];
  const routeOverflow: T[] = [];
  const dirCounts = new Map<string, number>();
  let codeKindCount = 0;
  // Only diversify by kind when another kind is actually available; otherwise
  // keep the directory-diversity order for all-code pools.
  const hasNonCodeKind = out.some((item) => !CODE_KIND_TYPES.has(item.type) && item.type !== "pi_extension_route");
  for (const item of out) {
    if (item.type === "pi_extension_route") { routeOverflow.push(item); continue; }
    const dirKey = parentDirKey(item.source);
    const count = dirCounts.get(dirKey) ?? 0;
    if (count >= 2) { overflow.push(item); continue; }
    const isCodeKind = CODE_KIND_TYPES.has(item.type);
    if (hasNonCodeKind && isCodeKind && codeKindCount >= 2) { overflow.push(item); continue; }
    if (isCodeKind) codeKindCount++;
    dirCounts.set(dirKey, count + 1);
    primary.push(item);
  }
  return [...primary, ...overflow, ...routeOverflow];
}

/**
 * ACT-R-inspired exponential decay score based on time since last access.
 * Returns 1.0 for today, ~0.5 for halfLifeDays ago, ~0.25 for 2x halfLife.
 */
export function decayScore(lastAccessTimestamp: number, now: number, halfLifeDays: number = 14): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceAccess = Math.max(0, (now - lastAccessTimestamp) / msPerDay);
  return Math.exp(-daysSinceAccess / halfLifeDays);
}

/**
 * Frequency score based on access count, capped at 1.0.
 * Reaches baseline (1.0) when accessCount >= baselineCount * 2.
 */
export function frequencyScore(accessCount: number, baselineCount: number = 5): number {
  return Math.min(1.0, accessCount / (baselineCount * 2));
}

/**
 * Apply recency + frequency boost to a candidate's score.
 * finalScore = 0.6 * originalRelevance + 0.2 * recencyScore + 0.2 * frequencyScore.
 */
export function applyRecencyBoost(item: ContextItemLike, now: number): number {
  const halfLifeDays = 14;
  const baselineCount = 5;

  // If no lastAccessedAt, default to max recency (1.0) — no penalty for missing data
  const recencyScore = item.lastAccessedAt !== undefined
    ? decayScore(item.lastAccessedAt, now, halfLifeDays)
    : 1.0;

  const freqScore = frequencyScore(item.accessCount ?? 0, baselineCount);

  return 0.6 * item.relevance + 0.2 * recencyScore + 0.2 * freqScore;
}
