import type { UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { candidateSortKey } from "./candidate-postprocess";
import { inferTaskType, whyItemMatters } from "./context-signal-helpers";
import { extractQueryTarget } from "./query-target";
import { itemAlreadySeen, previouslyShownSourceSet, sessionText } from "./session-novelty";
import { conciseSummary } from "./text-utils";

export type RejectionManifestItem = { index: number; source: string };

type CompilerContextItemLike = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
  raw?: string;
  inline?: boolean;
};

type CompilerStateLike = { handles: Map<string, { handle: string; source: string }> };

/** Parser and prompt-builder helpers for Sherpa context compiler model output. */

export function parseCurationRejected(parsed: any, manifest: RejectionManifestItem[]): Array<{ index: number; reason: string; source: string }> {
  if (!Array.isArray(parsed?.rejected)) return [];
  return parsed.rejected.filter((r: any) => typeof r?.index === "number").map((r: any) => ({
    index: Number(r.index),
    reason: String(r.reason ?? ""),
    source: String(manifest[r.index]?.source ?? ""),
  }));
}

export function parseCompiledContextItems(parsed: any, itemCount: number): Array<{ index: number; summary?: string; why?: string }> {
  const raw = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: Array<{ index: number; summary?: string; why?: string }> = [];
  for (const item of raw) {
    const n = typeof item?.index === "number" ? item.index : Number(item?.index);
    if (!Number.isInteger(n) || n < 0 || n >= itemCount || out.some((x) => x.index === n)) continue;
    out.push({
      index: n,
      summary: typeof item.summary === "string" ? item.summary.trim().slice(0, 700) : undefined,
      why: typeof item.why === "string" ? item.why.trim().slice(0, 240) : undefined,
    });
    if (out.length >= 3) break;
  }
  return out;
}

export function preserveExpandHint(summary: string, originalSummary: string, handle: string): string {
  const existingHint = originalSummary.match(/\s*\(expand with \/sherpa:expand ctx-\d+\)$/i)?.[0];
  const hint = existingHint ?? ` (expand with /sherpa:expand ${handle})`;
  if (/\(expand with \/sherpa:expand ctx-\d+\)$/i.test(summary)) return summary;
  return `${summary.replace(/\s+/g, " ").trim()}${hint}`;
}

export function contextCompilerManifest(ctx: ExtensionContext, items: CompilerContextItemLike[], focus: string, mode: string, state: CompilerStateLike) {
  const taskType = inferTaskType(focus);
  const text = sessionText(ctx);
  const previousSources = previouslyShownSourceSet(items, state);
  return items.map((item, index) => ({
    index,
    source: item.source,
    type: item.type,
    relevance: Number(candidateSortKey(item, focus, mode).toFixed(2)),
    novelty: itemAlreadySeen(ctx, item, previousSources, text) ? "already_in_session" : "new",
    summary: conciseSummary(item.summary, 320),
    rawExcerpt: item.inline ? undefined : (item.raw ?? "").replace(/\s+/g, " ").trim().slice(0, 280),
    whyCandidateMightMatter: whyItemMatters(item, taskType),
  }));
}

export function contextCompilerMessage(ctx: ExtensionContext, state: CompilerStateLike, focus: string, mode: string, items: CompilerContextItemLike[]): UserMessage {
  return {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      `User query: ${focus}`,
      `Query target packet: ${JSON.stringify(extractQueryTarget(focus))}`,
      "",
      "You are Sherpa's single Context Compiler pass.",
      "You replace separate evidence-judge, novelty-filter, compressor, and final-renderer judgment.",
      "Given candidate context, output only novel context that directly changes the main agent's next action.",
      "",
      "Rules:",
      "- Keep at most 3 items. Prefer 1. Abstain if nothing is directly useful.",
      "- Keep only candidates with novelty='new'.",
      "- Reject generic background, stale memory, adjacent research, broad docs, and keyword-only matches.",
      "- Prefer candidates whose source/summary matches the query target packet and expected evidence type.",
      "- Summary must be compact, factual, source-grounded, and action-oriented.",
      "- Do not invent facts not present in candidate summary/rawExcerpt.",
      "- Preserve source identity by selecting candidate indexes only; do not rewrite sources/handles.",
      "",
      "Return ONLY JSON:",
      '{"abstain":false,"items":[{"index":0,"summary":"minimal context","why":"why this changes next action"}],"rejected":[{"index":1,"reason":"already in session"}],"reason":"overall judgment"}',
      "",
      JSON.stringify(contextCompilerManifest(ctx, items, focus, mode, state), null, 2),
    ].join("\n") }],
  };
}
