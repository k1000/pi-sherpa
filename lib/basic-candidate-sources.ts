import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getDocFilesForFocus } from "./doc-discovery";
import { extractUrls } from "./url-utils";

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

export function addUrlReferences(state: UrlReferenceStateLike, focus: string, add: AddCandidateItem) {
  const urls = state.config.dedupe?.urls?.enabled ? extractUrls(focus) : (focus.match(/https?:\/\/\S+/g) ?? []);
  for (const url of urls) {
    add("url_reference", url, state.config.privacy.allowNetwork || state.config.sources.web
      ? `User provided URL: ${url}. Sherpa did not fetch it yet; the main agent should fetch/read it with an approved web tool if needed.`
      : `User provided URL: ${url}. Network/web retrieval is disabled in Sherpa privacy settings, so this is passed through as an explicit reference for the main agent.`, 0.9);
  }
}
