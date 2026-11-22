import type { AddContextItem } from "./context-adder";
import { routeSkipsPath } from "./doc-discovery";
import { searchSemble, type SembleConfig } from "./semble";
import { fileSnippetAllowed } from "./source-guards";
import type { SearchIndicators, SourcePlan } from "./source-planning";

/** Candidate injection from Semble semantic code search. */

type SembleStateLike = { config: { semble: SembleConfig } };

export async function addSembleCandidates(
  state: SembleStateLike,
  ctx: { cwd: string },
  focus: string,
  mode: string,
  sourcePlan: SourcePlan,
  indicators: SearchIndicators,
  add: AddContextItem,
) {
  const query = [focus, ...indicators.indicators].join(" ").trim();
  const results = await searchSemble(ctx.cwd, query, state.config.semble);
  for (const result of results) {
    if (routeSkipsPath(sourcePlan?.routePlan, result.filePath) || !fileSnippetAllowed(result.filePath, indicators.indicators.join(" "), mode)) continue;
    add("file", `repo://${result.filePath}:${result.startLine}`, result.content, 0.4);
  }
}
