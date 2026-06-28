import { focusAllowsGenericSource, genericSourceClass } from "./generic-source";
import { isGloballyNoisySource } from "./noise-filter";
import { isCodePrompt, isSourceLookupPrompt } from "./query-classifier";
import { extractQueryTarget } from "./query-target";
import {
  focusAllowsGitStatus,
  focusAllowsHistoricalMemory,
  focusAllowsPackageManifest,
  focusAllowsResearchMemory,
  isGenericNoiseSource,
  isHistoricalMemorySource,
  isPackageManifestSource,
  isRootReadmeSource,
  isStickyGenericSnippet,
  permitsRootReadme,
} from "./source-guards";

type ContextItemLike = {
  type: string;
  source: string;
  summary: string;
  raw?: string;
  relevance: number;
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

export function candidateSortKey(item: ContextItemLike, focus: string, mode: string) {
  const wantsSource = isCodePrompt(focus) || isSourceLookupPrompt(focus);
  const target = extractQueryTarget(focus);
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
  if (target.evidenceType === "docs" && item.type.includes("doc")) value += 0.14;
  if (isGloballyNoisySource(item.source)) value -= 2.0;
  if (item.type === "git_status" && !focusAllowsGitStatus(focus)) value -= 2.0;
  if (item.type === "research_memory" && !focusAllowsResearchMemory(focus)) value -= 1.5;
  if (isHistoricalMemorySource(item) && !focusAllowsHistoricalMemory(focus)) value -= 1.2;
  if (isPackageManifestSource(item.source) && !focusAllowsPackageManifest(focus)) value -= wantsSource ? 0.65 : 0.25;
  if (isRootReadmeSource(item.source) && !permitsRootReadme(focus)) value -= 1.0;
  if (item.source === "repo://README.md") value -= wantsSource ? 0.35 : 0.15;
  if (isGenericNoiseSource(item.source)) value -= wantsSource ? 0.3 : 0.12;
  if (isStickyGenericSnippet(item)) value -= 0.5;
  if (/repo:\/\/(docs\/sherpa-|\.pi\/sherpa-)/.test(item.source) && !/\bsherpa\b/i.test(focus)) value -= 0.45;
  return value;
}

export function postProcessCandidates<T extends ContextItemLike>(candidates: T[], focus: string, mode: string): T[] {
  const wantsSource = isCodePrompt(focus) || isSourceLookupPrompt(focus);
  const sorted = [...candidates].sort((a, b) => candidateSortKey(b, focus, mode) - candidateSortKey(a, focus, mode));
  const out: T[] = [];
  const seen = new Set<string>();
  let readmeCount = 0;
  for (const item of sorted) {
    if (isGloballyNoisySource(item.source)) continue;
    if (genericSourceClass(item.source) && !focusAllowsGenericSource(item.source, focus)) continue;
    if (item.type === "git_status" && !focusAllowsGitStatus(focus)) continue;
    if (item.type === "research_memory" && !focusAllowsResearchMemory(focus)) continue;
    if (isHistoricalMemorySource(item) && !focusAllowsHistoricalMemory(focus)) continue;
    if (isPackageManifestSource(item.source) && !focusAllowsPackageManifest(focus) && wantsSource) continue;
    const key = sourceDedupeKey(item.source);
    if (seen.has(key)) continue;
    if (isRootReadmeSource(item.source)) {
      if (!permitsRootReadme(focus)) continue;
      if (readmeCount >= 1) continue;
      if (wantsSource && isStickyGenericSnippet(item)) continue;
      readmeCount++;
    }
    if (candidateSortKey(item, focus, mode) < sourceCorrespondenceThreshold(focus, mode)) continue;
    if (wantsSource && /repo:\/\/(docs\/sherpa-|\.pi\/sherpa-)/.test(item.source) && !/\bsherpa\b/i.test(focus)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
