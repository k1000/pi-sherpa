import path from "node:path";

import { readQualitySummary, readRecentEvaluations } from "./evaluation";
import { applyEvaluationFeedbackToCandidates } from "./post-task-evaluation";

/** Session-local and persisted retrieval feedback adjustments. */

type FeedbackRecordLike = { used?: string[]; unused?: string[]; missing?: string[]; at?: number };
type FeedbackStateLike = { feedback?: FeedbackRecordLike[] };
type ContextItemLike = { source: string; relevance: number };

export function applySessionUsageFeedback<T extends ContextItemLike>(state: FeedbackStateLike, candidates: T[]): void {
  if (!state.feedback?.length) return;
  for (const candidate of candidates) {
    const source = candidate.source.toLowerCase();
    for (const record of state.feedback.slice(-20)) {
      for (const missed of record.missing ?? []) {
        const normalized = missed.toLowerCase().replace(/^repo:\/\//, "");
        const base = path.basename(normalized).replace(/\.[^.]+$/, "");
        if (normalized && source.includes(normalized)) candidate.relevance = Math.min(1, candidate.relevance + 0.45);
        else if (base.length >= 4 && source.includes(base)) candidate.relevance = Math.min(1, candidate.relevance + 0.18);
      }
      for (const unused of record.unused ?? []) {
        if (unused && candidate.source === unused) candidate.relevance = Math.max(0, candidate.relevance - 0.3);
      }
    }
  }
}

export function applyRetrievalFeedback<T extends ContextItemLike>(state: FeedbackStateLike, focus: string, candidates: T[], memoryRoot: string) {
  try {
    const recentEvaluations = readRecentEvaluations(memoryRoot, 200);
    const qualitySummary = readQualitySummary(memoryRoot);
    const adjusted = applyEvaluationFeedbackToCandidates(candidates, recentEvaluations, qualitySummary, { focus });
    candidates.splice(0, candidates.length, ...adjusted);
    applySessionUsageFeedback(state, candidates);
    return { recentEvaluations: recentEvaluations.length, qualitySummaryUsed: Boolean(qualitySummary) };
  } catch {
    applySessionUsageFeedback(state, candidates);
    return {};
  }
}
