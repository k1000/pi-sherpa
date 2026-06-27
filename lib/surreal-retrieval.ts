import type { MemoryApiStore, MemoryResult } from "./memory-store";
import { extractSearchTerms } from "./source-planning";

type SearchIndicatorsLike = { indicators: string[] };
export type SurrealSearchLimits = { constrainedLimit: number; broadFallbackLimit: number };

/** Helpers for associative Surreal/memory-api retrieval. */

export function surrealArtifactIdFromSource(source: string): string | undefined {
  if (!source.startsWith("surreal://")) return undefined;
  return decodeURIComponent(source.slice("surreal://".length));
}

export function associativeMemoryProbes(focus: string, indicators: SearchIndicatorsLike): string[] {
  const probes = [
    focus,
    indicators.indicators.join(" "),
    ...indicators.indicators.slice(0, 6),
    extractSearchTerms(focus, 8).join(" "),
  ].map((probe) => probe.replace(/\s+/g, " ").trim()).filter((probe) => probe.length >= 3);
  return [...new Set(probes)].slice(0, 8);
}

export function inferSurrealMemoryTypes(focus: string): string[] | undefined {
  const f = focus.toLowerCase();
  const types = new Set<string>();
  if (/\b(claim|fact|assertion|invariant|truth)\b/.test(f)) types.add("claim");
  if (/\b(procedure|workflow|runbook|how\s+to|steps|process)\b/.test(f)) types.add("procedure");
  if (/\b(decision|rationale|adr|tradeoff)\b/.test(f)) types.add("decision");
  if (/\b(evidence|commit|source|proof|why)\b/.test(f)) types.add("evidence");
  if (/\b(file|path|module|component|implementation|code)\b/.test(f)) types.add("source-file");
  if (/\b(entity|symbol|concept|term|alias)\b/.test(f)) types.add("entity");
  return types.size ? [...types] : undefined;
}

export function inferSurrealResearchArea(focus: string): string | undefined {
  const f = focus.toLowerCase();
  if (/\b(sage|graphrag|rag|agent\s+memory|memory\s+engine|paper|arxiv|research|llm|ai)\b/.test(f)) return "ai";
  return undefined;
}

export function shouldSearchTranscendentalMemory(focus: string): boolean {
  return /\b(transcendental|cross-project|global\s+memory|universal|principle|doctrine|meta-memory|wisdom)\b/i.test(focus);
}

export async function safeSurrealSearch(store: MemoryApiStore, query: Parameters<MemoryApiStore["search"]>[0]): Promise<MemoryResult[]> {
  return store.search(query).catch(() => []);
}

export async function surrealProbeResults(
  store: MemoryApiStore,
  probe: string,
  project: string,
  types: string[] | undefined,
  area: string | undefined,
  includeTranscendental: boolean,
  embedding: number[] | undefined,
  limits: SurrealSearchLimits,
): Promise<MemoryResult[]> {
  const halfConstrained = Math.max(3, Math.floor(limits.constrainedLimit / 2));
  const searches = [
    safeSurrealSearch(store, { text: probe, project, types, embedding, limit: limits.constrainedLimit }),
    types && limits.broadFallbackLimit ? safeSurrealSearch(store, { text: probe, project, embedding, limit: limits.broadFallbackLimit }) : [],
    area ? safeSurrealSearch(store, { text: probe, area, types, embedding, limit: halfConstrained }) : [],
    area && limits.broadFallbackLimit ? safeSurrealSearch(store, { text: probe, area, embedding, limit: limits.broadFallbackLimit }) : [],
    includeTranscendental ? safeSurrealSearch(store, { text: probe, scope: "transcendental", types, embedding, limit: halfConstrained }) : [],
  ];
  return (await Promise.all(searches)).flat();
}

export function mergeSurrealProbeResults(merged: Map<string, MemoryResult>, results: MemoryResult[], probe: string, index: number): void {
  const scoreBoost = index === 0 ? 0.08 : 0.03;
  for (const result of results) {
    const existing = merged.get(result.artifact.id);
    const scored = { ...result, score: Math.min(1, result.score + scoreBoost), reason: `${result.reason}; associative probe: ${probe}` };
    if (!existing || scored.score > existing.score) merged.set(result.artifact.id, scored);
  }
}
