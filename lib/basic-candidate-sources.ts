import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getDocFilesForFocus } from "./doc-discovery";
import { extractUrls } from "./url-utils";
import { MemoryApiStore, type ArchivistMemoryApiConfig } from "../../archivist/lib/memory-api";

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
};

export function addDocCandidates(ctx: ExtensionContext, mode: string, sourcePlan: SourcePlanLike, indicators: SearchIndicatorsLike, add: AddCandidateItem) {
  const docFiles = getDocFilesForFocus(ctx.cwd, indicators.indicators.join(" "), mode, sourcePlan?.routePlan as any);
  for (const f of docFiles) {
    const p = path.join(ctx.cwd, f);
    if (existsSync(p)) add("doc_snippet", `repo://${f}`, readFileSync(p, "utf8").slice(0, 4000), 0.1);
  }
}

export function addSessionCandidates(ctx: ExtensionContext, add: AddCandidateItem) {
  const recent = ctx.sessionManager.getEntries().slice(-25).map((e: any) => JSON.stringify(e).slice(0, 500)).join("\n");
  add("session_recent", "session://recent", recent, 0.05);
}

export async function addInquirerCandidates(config: InquirerCandidateConfig | undefined, focus: string, add: AddCandidateItem): Promise<void> {
  if (!config?.enabled || !config.url) return;
  try {
    const store = new MemoryApiStore({
      mode: "memory-api",
      namespace: "pi",
      database: "memory",
      tokenEnv: "SHERPA_MEMORY_API_TOKEN",
      ...config,
      enabled: true,
      url: config.url,
    } as ArchivistMemoryApiConfig);
    const results = await store.search({ text: focus, limit: config.searchLimit || 8 });
    for (const result of results) {
      const artifact = result.artifact;
      const title = typeof artifact.title === "string" ? artifact.title : artifact.id;
      const body = String(artifact.summary ?? artifact.text ?? title ?? "").slice(0, 4000);
      if (!body.trim()) continue;
      const score = typeof result.score === "number" && Number.isFinite(result.score) ? Math.max(0, Math.min(1, result.score)) : 0.25;
      add("inquirer_memory", `inquirer_memory://${artifact.id}`, `${title}\n${body}`, score);
    }
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
