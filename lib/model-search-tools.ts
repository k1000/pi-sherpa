import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { pathSourceLabel } from "./exact-source";
import { searchSherpaMemory } from "./memory-index";
import { type SearchTool, type ModelSearchCandidate } from "./model-search";

/**
 * Concrete search-tool factories for the model-search escalation loop.
 *
 * Extracted from index.ts. These are the tool implementations the sidecar model
 * can invoke during escalation (find_file, search_memory). The pure loop
 * controller lives in lib/model-search.ts; makeModelStepRunner (which wires the
 * sidecar completion) stays in index.ts.
 */

// Maximum results any model-search tool may return in a single call.
// The loop controller passes limit=5 for operational tightness;
// this is the safety/outer bound to prevent prompt flooding.
export const MODEL_SEARCH_TOOL_MAX_RESULTS = 20;

const MODEL_SEARCH_FILE_ROOTS: string[] = (() => {
  const roots: string[] = [];
  const home = process.env.HOME;
  if (home) roots.push(path.join(home, ".pi", "agent"));
  return roots;
})();

export function makeFileFinderTool(ctx: ExtensionContext): SearchTool {
  return {
    name: "find_file",
    description: "Find files by name or glob under ~/.pi/agent (config, models, extensions). Use when the user asks about configuration, models, providers, or pi setup and the exact path is unknown. Pass a query like 'models' or 'sherpa.config'.",
    async run({ query, limit }) {
      const q = (query ?? "").trim().toLowerCase();
      if (!q) return [];
      const out: ModelSearchCandidate[] = [];
      const seen = new Set<string>();
      const max = Math.min(limit ?? MODEL_SEARCH_TOOL_MAX_RESULTS, MODEL_SEARCH_TOOL_MAX_RESULTS);
      for (const root of MODEL_SEARCH_FILE_ROOTS) {
        if (!existsSync(root)) continue;
        let entries: string[];
        try { entries = readdirSync(root); } catch { continue; }
        for (const name of entries) {
          if (seen.has(name)) continue;
          if (name.toLowerCase().includes(q)) {
            seen.add(name);
            const abs = path.join(root, name);
            try { if (!statSync(abs).isFile()) continue; } catch { continue; }
            out.push({ source: pathSourceLabel(abs, ctx.cwd), summary: `File under ~/.pi/agent: ${name}`, relevance: 0.7 });
            if (out.length >= max) return out;
          }
        }
      }
      return out;
    },
  };
}

// Tool: search Sherpa durable memory (scratchpad/catalog). Existing primitive reused.
export function makeMemorySearchTool(): SearchTool {
  return {
    name: "search_memory",
    description: "Search past Sherpa observations, distillation candidates, and catalog entries for a keyword. Use for conventions, lessons, prior decisions.",
    async run({ query, limit }) {
      const q = (query ?? "").trim();
      if (!q) return [];
      try {
        const hits = searchSherpaMemory("/Users/kamil/.pi-memory", q, Math.min(limit ?? MODEL_SEARCH_TOOL_MAX_RESULTS, MODEL_SEARCH_TOOL_MAX_RESULTS));
        return hits.map((h) => ({ source: `kb://memory/${h.kind ?? ""}/${h.id ?? ""}`, summary: (h.title ? h.title + ": " : "") + (h.summary ?? "").slice(0, 200), relevance: 0.5 }));
      } catch { return []; }
    },
  };
}
