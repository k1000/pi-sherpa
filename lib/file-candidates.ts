import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { postProcessCandidates } from "./candidate-postprocess";
import type { AddContextItem } from "./context-adder";
import { routeSkipsPath } from "./doc-discovery";
import { fileSnippetAllowed } from "./source-guards";
import { parseRgOutput, rg } from "./rg";
import type { SearchIndicators, SourcePlan } from "./source-planning";

/** Repo file candidate helpers for route-selected files and search indicators. */

function routedDirectorySummary(root: string, rel: string): string {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .slice(0, 40)
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`);
  return [`Routed directory: ${rel}`, "Entries:", ...entries].join("\n");
}

export async function addRoutedFileCandidates(ctx: { cwd: string }, focus: string, mode: string, sourcePlan: SourcePlan, add: AddContextItem) {
  for (const rel of sourcePlan?.routePlan?.read ?? []) {
    if (routeSkipsPath(sourcePlan?.routePlan, rel)) continue;
    const p = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        add("file", `repo://${rel}`, readFileSync(p, "utf8").slice(0, 1200), 0.35);
      } else if (existsSync(p) && statSync(p).isDirectory()) {
        if (mode === "front-door") {
          add("file", `repo://${rel}`, routedDirectorySummary(p, rel), 0.25);
          continue;
        }
        const routedOut = await rg(ctx.cwd, focus, p);
        for (const { fileAndLine, content } of parseRgOutput(routedOut, 12)) {
          if (content && !routeSkipsPath(sourcePlan?.routePlan, fileAndLine)) add("file", `repo://${fileAndLine}`, content, 0.3);
        }
      }
    } catch { /* ignore route file */ }
  }
}

/** One match per distinct file, in deterministic order, up to cap files. */
function distinctFileMatches(matches: Array<{ fileAndLine: string; content: string }>, cap: number) {
  const seen = new Set<string>();
  const out: Array<{ fileAndLine: string; content: string }> = [];
  for (const m of matches) {
    const file = m.fileAndLine.replace(/:\d+$/, "");
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(m);
    if (out.length >= cap) break;
  }
  return out;
}

export async function addIndicatorFileCandidates(ctx: { cwd: string }, mode: string, sourcePlan: SourcePlan, indicators: SearchIndicators, add: AddContextItem) {
  const indicatorText = indicators.indicators.join(" ");
  const out = await rg(ctx.cwd, indicators.indicators);
  // Coverage beats depth: many lines from the same file are redundant, so take
  // one match per distinct file (deterministic thanks to rg --sort path) and let
  // the downstream ranking pick the top 12.
  const matches = parseRgOutput(out, 400).filter(({ fileAndLine, content }) =>
    content && !routeSkipsPath(sourcePlan?.routePlan, fileAndLine) && fileSnippetAllowed(fileAndLine, indicatorText, mode));
  for (const { fileAndLine, content } of distinctFileMatches(matches, 40)) {
    add("file", `repo://${fileAndLine}`, content, 0.15);
  }
}

export async function retryFrontDoorFileCandidates<T extends { source: string; relevance: number }>(
  ctx: { cwd: string },
  focus: string,
  mode: string,
  sourcePlan: SourcePlan,
  candidates: T[],
  add: AddContextItem,
  enabled: (s: string) => boolean,
) {
  if (mode !== "front-door" || !enabled("files") || postProcessCandidates(candidates, focus, mode).length !== 0) return;
  // Semble has already searched in the parallel retrieval phase. Retry only the
  // literal file search so an empty semantic result does not double front-door latency.
  const retryOut = await rg(ctx.cwd, focus);
  const retryMatches = parseRgOutput(retryOut, 200).filter(({ fileAndLine, content }) =>
    content && !routeSkipsPath(sourcePlan?.routePlan, fileAndLine) && fileSnippetAllowed(fileAndLine, focus, mode));
  for (const { fileAndLine, content } of distinctFileMatches(retryMatches, 16)) {
    add("file", `repo://${fileAndLine}`, content, 0.08);
  }
}
