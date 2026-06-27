import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export type WebSearchResult = { title: string; url: string; snippet: string };

export type WebSearchConfig = {
  provider: string;
  apiKey: string;
  query: string;
  maxResults: number;
  timeoutMs: number;
  cacheTtlMs: number;
};

export function webCachePath(cwd: string, query: string, provider: string) {
  const hash = createHash("sha256").update(`${provider}:${query.toLowerCase().trim()}`).digest("hex").slice(0, 24);
  return path.join(cwd, ".pi", "sherpa-cache", "web", `${hash}.json`);
}

export function conciseWebQuery(focus: string) {
  return focus.replace(/[^\p{L}\p{N}\s._:/-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

export function readWebCache(cachePath: string, cacheTtlMs: number): WebSearchResult[] | undefined {
  try {
    if (!existsSync(cachePath)) return undefined;
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    return Date.now() - cached.at < cacheTtlMs ? cached.results ?? [] : undefined;
  } catch {
    return undefined;
  }
}

export function writeWebCache(cachePath: string, provider: string, query: string, results: WebSearchResult[]): void {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ at: Date.now(), provider, query, results }, null, 2));
}

export async function searchBraveWeb(query: string, apiKey: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(maxResults), text_decorations: "false" })}`;
  const res = await fetch(url, { headers: { "Accept": "application/json", "X-Subscription-Token": apiKey }, signal });
  if (!res.ok) return [];
  const json: any = await res.json();
  return (json.web?.results ?? [])
    .slice(0, maxResults)
    .map((r: any) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.description ?? "" }))
    .filter((r: WebSearchResult) => r.url);
}

export async function runWebProviderSearch(config: WebSearchConfig, signal: AbortSignal): Promise<WebSearchResult[]> {
  if (config.provider === "brave") return searchBraveWeb(config.query, config.apiKey, config.maxResults, signal);
  return [];
}

export async function searchWebWithConfig(cwd: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  const cachePath = webCachePath(cwd, config.query, config.provider);
  const cached = readWebCache(cachePath, config.cacheTtlMs);
  if (cached) return cached;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.timeoutMs);
  try {
    const results = await runWebProviderSearch(config, abort.signal);
    writeWebCache(cachePath, config.provider, config.query, results);
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
