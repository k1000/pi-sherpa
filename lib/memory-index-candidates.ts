import path from "node:path";

import type { AddContextItem } from "./context-adder";
import { indexSherpaMemory, searchSherpaMemory, type MemoryIndexConfig } from "./memory-index";
import type { SearchIndicators } from "./source-planning";

/** Candidate injection from Sherpa's local SQLite/FTS memory index. */

export function addMemoryIndexCandidates(
  ctx: { cwd: string },
  focus: string,
  indicators: SearchIndicators,
  memoryConfig: MemoryIndexConfig,
  add: AddContextItem,
) {
  try {
    indexSherpaMemory(ctx.cwd, memoryConfig);
    const memoryHits = searchSherpaMemory(ctx.cwd, [focus, ...indicators.indicators].join(" "), 8, memoryConfig);
    for (const hit of memoryHits) {
      add("memory_index", `memory-index://${hit.kind}/${path.relative(ctx.cwd, hit.sourcePath)}`, [
        `Kind: ${hit.kind}`,
        `Title: ${hit.title}`,
        hit.summary ? `Summary: ${hit.summary}` : "",
        `Source: ${hit.sourcePath}`,
        "",
        hit.snippet || hit.summary,
      ].filter(Boolean).join("\n"), 0.24);
    }
  } catch { /* memory index recall is opportunistic */ }
}
