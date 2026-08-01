import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getDocFilesForFocus } from "./doc-discovery";
import { extractUrls } from "./url-utils";
import { suppressCandidate } from "./candidate-suppression";
import { fileIsMaterialized } from "./common";
import { MemoryApiStore, memoryApiGet, type ArchivistMemoryApiConfig, type MemoryArtifact, type MemoryRelation } from "../../archivist/lib/memory-api";

/** Basic low-coupling candidate source readers. */

export type AddCandidateItem = (type: string, source: string, raw: string, relBoost?: number) => void;

type SourcePlanLike = { routePlan?: unknown };
type SearchIndicatorsLike = { indicators: string[] };
type UrlReferenceStateLike = {
  config: {
    dedupe?: { urls?: { enabled?: boolean } };
    privacy: { allowNetwork: boolean };
    sources: { web?: boolean };
  };
};

export type InquirerCandidateConfig = Partial<ArchivistMemoryApiConfig> & {
  enabled?: boolean;
  url?: string;
  token?: string;
  tokenEnv?: string;
  searchLimit?: number;
  timeoutMs?: number;
};

export function addDocCandidates(ctx: ExtensionContext, mode: string, sourcePlan: SourcePlanLike, indicators: SearchIndicatorsLike, add: AddCandidateItem) {
  const docFiles = getDocFilesForFocus(ctx.cwd, indicators.indicators.join(" "), mode, sourcePlan?.routePlan as any);
  for (const f of docFiles) {
    const p = path.join(ctx.cwd, f);
    if (fileIsMaterialized(p)) add("doc_snippet", `repo://${f}`, readFileSync(p, "utf8").slice(0, 4000), 0.1);
  }
}

export function addSessionCandidates(ctx: ExtensionContext, add: AddCandidateItem) {
  const recent = ctx.sessionManager.getEntries().slice(-25).map((e: any) => JSON.stringify(e).slice(0, 500)).join("\n");
  add("session_recent", "session://recent", recent, 0.05);
}

function memoryApiConfig(config: InquirerCandidateConfig): ArchivistMemoryApiConfig {
  return {
    mode: "memory-api",
    namespace: "pi",
    database: "memory",
    tokenEnv: "SHERPA_MEMORY_API_TOKEN",
    ...config,
    enabled: true,
    url: config.url!,
  } as ArchivistMemoryApiConfig;
}

function artifactText(artifact: MemoryArtifact): string {
  const title = typeof artifact.title === "string" ? artifact.title : artifact.id;
  const body = String(artifact.summary ?? artifact.text ?? title ?? "").slice(0, 4000);
  return body.trim() ? `${title}\n${body}` : "";
}

function normalizedScore(score: unknown, fallback = 0.25): number {
  return typeof score === "number" && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : fallback;
}

function relationArtifact(relation: MemoryRelation): MemoryArtifact | undefined {
  const raw = (relation as any).artifact ?? (relation as any).toArtifact ?? (relation as any).targetArtifact;
  return raw && typeof raw === "object" && typeof raw.id === "string" ? raw as MemoryArtifact : undefined;
}

async function getRelations(config: InquirerCandidateConfig, from: string): Promise<MemoryRelation[]> {
  try {
    const result = await memoryApiGet({ memoryApi: memoryApiConfig(config) } as any, `/api/v1/memory/relations?from=${encodeURIComponent(from)}`);
    return Array.isArray(result?.relations) ? result.relations : Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function addGraphCandidates(config: InquirerCandidateConfig, store: MemoryApiStore, seeds: Array<{ id: string; score: number }>, seenArtifacts: Set<string>, add: AddCandidateItem): Promise<void> {
  const queued = seeds.map((seed) => ({ ...seed, hop: 0 }));
  const seenRelations = new Set<string>();
  let added = 0;
  while (queued.length && added < (config.searchLimit || 8)) {
    const current = queued.shift()!;
    if (current.hop >= 2) continue;
    const relations = await getRelations(config, current.id);
    for (const relation of relations) {
      const target = String(relation.to ?? "").trim();
      if (!target || seenRelations.has(`${current.id}->${target}`)) continue;
      seenRelations.add(`${current.id}->${target}`);
      const graphScore = current.score * 0.7;
      const embedded = relationArtifact(relation);
      if (embedded && !seenArtifacts.has(embedded.id)) {
        const raw = artifactText(embedded);
        if (raw) {
          seenArtifacts.add(embedded.id);
          const { suppressed, adjustedRelevance } = suppressCandidate({
            type: embedded.type ?? "inquirer_graph",
            source: `inquirer_graph://${embedded.id}`,
            relevance: graphScore,
            createdAt: (embedded as any).createdAt ?? (embedded as any).updatedAt,
          });
          if (!suppressed) {
            add("inquirer_graph", `inquirer_graph://${embedded.id}`, raw, adjustedRelevance);
            added++;
          }
        }
      } else if (!seenArtifacts.has(target)) {
        try {
          const related = await store.search({ text: target, limit: 1 });
          for (const result of related) {
            const artifact = result.artifact;
            if (!artifact?.id || seenArtifacts.has(artifact.id)) continue;
            const raw = artifactText(artifact);
            if (!raw) continue;
            const { suppressed, adjustedRelevance } = suppressCandidate({
              type: artifact.type ?? "inquirer_graph",
              source: `inquirer_graph://${artifact.id}`,
              relevance: graphScore * normalizedScore(result.score, 1),
              createdAt: (artifact as any).createdAt ?? (artifact as any).updatedAt,
            });
            if (suppressed) continue;
            seenArtifacts.add(artifact.id);
            add("inquirer_graph", `inquirer_graph://${artifact.id}`, raw, adjustedRelevance);
            added++;
          }
        } catch {
          // Graph expansion is opportunistic; direct vector results remain useful.
        }
      }
      queued.push({ id: target, score: graphScore, hop: current.hop + 1 });
      if (added >= (config.searchLimit || 8)) break;
    }
  }
}

export async function addInquirerCandidates(config: InquirerCandidateConfig | undefined, focus: string, add: AddCandidateItem): Promise<void> {
  if (!config?.enabled || !config.url) return;
  try {
    const store = new MemoryApiStore(memoryApiConfig(config));
    const results = await store.search({ text: focus, limit: config.searchLimit || 8 });
    const seeds: Array<{ id: string; score: number }> = [];
    const seenArtifacts = new Set<string>();
    for (const result of results) {
      const artifact = result.artifact;
      if (!artifact?.id) continue;
      const raw = artifactText(artifact);
      if (!raw) continue;
      const score = normalizedScore(result.score);
      // Suppression rules: drop self-evaluation/status artifacts, boost newer ones.
      const { suppressed, adjustedRelevance } = suppressCandidate({
        type: artifact.type ?? "inquirer_memory",
        source: `inquirer_memory://${artifact.id}`,
        relevance: score,
        createdAt: (artifact as any).createdAt ?? (artifact as any).updatedAt,
      });
      if (suppressed) continue;
      seenArtifacts.add(artifact.id);
      seeds.push({ id: artifact.id, score });
      add("inquirer_memory", `inquirer_memory://${artifact.id}`, raw, adjustedRelevance);
    }
    if (seeds.length) await addGraphCandidates(config, store, seeds, seenArtifacts, add);
  } catch {
    return;
  }
}

export function addUrlReferences(state: UrlReferenceStateLike, focus: string, add: AddCandidateItem) {
  const urls = state.config.dedupe?.urls?.enabled ? extractUrls(focus) : (focus.match(/https?:\/\/\S+/g) ?? []);
  for (const url of urls) {
    add("url_reference", url, state.config.privacy.allowNetwork || state.config.sources.web
      ? `User provided URL: ${url}. Sherpa did not fetch it yet; the main agent should fetch/read it with an approved web tool if needed.`
      : `User provided URL: ${url}. Network/web retrieval is disabled in Sherpa privacy settings, so this is passed through as an explicit reference for the main agent.`, 0.9);
  }
}
