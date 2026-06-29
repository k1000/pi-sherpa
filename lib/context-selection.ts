import { approxTokens } from "./text-utils";

/** Pure context selection/abstention helpers. */

type ScoredItemLike = { relevance: number };
type SummarizedItemLike = { summary: string };

type CurateResultLike<T> = {
  items: T[];
  abstain: boolean;
  abstainReason: string;
  rejected: Array<{ index: number; reason: string; source: string }>;
  confidence: number;
  planner: "heuristic";
  plannerReason: string;
};

export function shouldAbstain(items: ScoredItemLike[], mode: string) {
  if (!items.length) return "no source-grounded context found";
  const best = items[0]?.relevance ?? 0;
  const threshold = mode === "front-door" ? 0.4 : 0.12;
  if (best < threshold) return `best relevance ${best.toFixed(2)} below ${threshold}`;
  return "";
}

export function pickFinalContextItems<T extends SummarizedItemLike>(finalItems: T[], tokenBudget: number) {
  const items: T[] = [];
  let used = 0;
  for (const c of finalItems) {
    const t = approxTokens(c.summary) + 30;
    if (used + t <= tokenBudget) { items.push(c); used += t; }
    if (items.length >= 3) break;
  }
  return { items, used };
}

export function heuristicCurateResult<T>(items: T[], confidence = 0.3, plannerReason = "heuristic ordering"): CurateResultLike<T> {
  // Aligned with context-compiler.ts model limit (3 items) to avoid
  // returning more context via heuristic fallback than via model pass.
  return { items: items.slice(0, 3), abstain: false, abstainReason: "", rejected: [], confidence, planner: "heuristic", plannerReason };
}
