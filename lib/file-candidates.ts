import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AddContextItem } from "./context-adder";
import { routeSkipsPath } from "./doc-discovery";
import { fileSnippetAllowed } from "./source-guards";
import { parseRgOutput, rg } from "./rg";
import type { SearchIndicators, SourcePlan } from "./source-planning";

/** Repo file candidate helpers for route-selected files and search indicators. */

export async function addRoutedFileCandidates(ctx: { cwd: string }, focus: string, sourcePlan: SourcePlan, add: AddContextItem) {
  for (const rel of sourcePlan?.routePlan?.read ?? []) {
    if (routeSkipsPath(sourcePlan?.routePlan, rel)) continue;
    const p = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        add("file", `repo://${rel}`, readFileSync(p, "utf8").slice(0, 1200), 0.35);
      } else if (existsSync(p) && statSync(p).isDirectory()) {
        const routedOut = await rg(ctx.cwd, focus, p);
        for (const { fileAndLine, content } of parseRgOutput(routedOut, 12)) {
          if (content && !routeSkipsPath(sourcePlan?.routePlan, fileAndLine)) add("file", `repo://${fileAndLine}`, content, 0.3);
        }
      }
    } catch { /* ignore route file */ }
  }
}

export async function addIndicatorFileCandidates(ctx: { cwd: string }, mode: string, sourcePlan: SourcePlan, indicators: SearchIndicators, add: AddContextItem) {
  const indicatorText = indicators.indicators.join(" ");
  const out = await rg(ctx.cwd, indicators.indicators);
  for (const { fileAndLine, content } of parseRgOutput(out, 30)) {
    if (!content || routeSkipsPath(sourcePlan?.routePlan, fileAndLine) || !fileSnippetAllowed(fileAndLine, indicatorText, mode)) continue;
    add("file", `repo://${fileAndLine}`, content, 0.15);
  }
}
