import { writeDspyTrace } from "./dspy";
import { traceDecisions, traceFeedbackStats, traceItem, traceStageLabels } from "./trace-helpers";

/** Record DSPy/Sherpa retrieval traces without coupling to index.ts State types. */

type TraceItemLike = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
};

type TraceBundleLike = {
  bundleId: string;
  focus: string;
  mode: string;
  items: TraceItemLike[];
  sourcePlan?: { sources?: string[]; reason?: string; confidence?: number; planner?: string };
  signal?: { disposition?: { kind?: string } };
};

type TraceIndicatorsLike = { indicators: string[]; reason: string; confidence: number; planner: string };

type TraceCurateResultLike = {
  abstain: boolean;
  abstainReason: string;
  confidence: number;
  planner: string;
  plannerReason?: string;
  rejected: Array<{ index: number; reason: string; source: string }>;
};

export type TraceFeedbackLike = { recentEvaluations?: number; qualitySummaryUsed?: boolean; penaltiesApplied?: number; boostsApplied?: number };

export function recordDspyTrace(cwd: string, bundle: TraceBundleLike, indicators: TraceIndicatorsLike, candidates: TraceItemLike[], curateResult: TraceCurateResultLike, feedback?: TraceFeedbackLike) {
  try {
    const decisions = traceDecisions(bundle.focus, candidates, bundle.items, curateResult);
    writeDspyTrace(cwd, {
      version: 1,
      at: new Date().toISOString(),
      bundleId: bundle.bundleId,
      focus: bundle.focus,
      mode: bundle.mode,
      stageLabels: traceStageLabels(bundle, candidates, curateResult),
      sourcePlan: {
        sources: bundle.sourcePlan?.sources ?? [],
        reason: bundle.sourcePlan?.reason ?? "",
        confidence: bundle.sourcePlan?.confidence ?? 0,
        planner: bundle.sourcePlan?.planner ?? "unknown",
      },
      indicators: {
        indicators: indicators.indicators,
        reason: indicators.reason,
        confidence: indicators.confidence,
        planner: indicators.planner,
      },
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 60).map(traceItem),
      selected: bundle.items.map(traceItem),
      curate: {
        abstain: curateResult.abstain,
        abstainReason: curateResult.abstainReason,
        confidence: curateResult.confidence,
        planner: curateResult.planner,
        plannerReason: curateResult.plannerReason,
        rejected: curateResult.rejected.slice(0, 60),
      },
      decisions,
      feedback: { ...traceFeedbackStats(0, false, decisions), ...(feedback ?? {}) },
      disposition: bundle.signal?.disposition?.kind,
    });
  } catch { /* tracing must never affect retrieval */ }
}
