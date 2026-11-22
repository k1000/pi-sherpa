import { focusAllowsGenericSource, genericSourceClass } from "./generic-source";

type ContextItemLike = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
};

type CurateResultLike = {
  rejected: Array<{ source: string; reason: string }>;
  abstain: boolean;
  abstainReason: string;
  planner: string;
  plannerReason?: string;
};

type BundleLike = {
  sourcePlan?: { planner: string; reason: string };
  items: ContextItemLike[];
};

export function traceItem(item: ContextItemLike) {
  return {
    handle: item.handle,
    type: item.type,
    source: item.source,
    relevance: Number(item.relevance.toFixed(4)),
    summary: item.summary.slice(0, 1000),
  };
}

export function traceDecisions(focus: string, candidates: ContextItemLike[], selected: ContextItemLike[], curateResult: CurateResultLike) {
  const selectedSources = new Set(selected.map((item) => item.source));
  const curatedRejected = new Map(curateResult.rejected.map((item) => [item.source, item.reason]));
  return candidates.slice(0, 60).map((candidate) => {
    const reasons: string[] = [];
    const generic = genericSourceClass(candidate.source);
    if (generic) reasons.push(`generic_source:${generic}`);
    if (generic && !focusAllowsGenericSource(candidate.source, focus)) reasons.push(`focus_does_not_allow_${generic}`);
    if (candidate.relevance < 0.25) reasons.push("low_relevance");
    const rejectedReason = curatedRejected.get(candidate.source);
    if (rejectedReason) reasons.push(`curator:${rejectedReason}`);
    const isSelected = selectedSources.has(candidate.source);
    const isSuppressed = !isSelected && Boolean(generic && !focusAllowsGenericSource(candidate.source, focus));
    const decision = isSelected ? "selected" : isSuppressed ? "suppressed" : "rejected";
    if (!reasons.length) reasons.push(isSelected ? "selected_by_curator" : "not_selected_by_curator");
    return { source: candidate.source, finalRelevance: Number(candidate.relevance.toFixed(4)), decision, reasons };
  });
}

export function traceFeedbackStats(evalsCount: number, qualitySummaryUsed: boolean, decisions: ReturnType<typeof traceDecisions>) {
  const penaltiesApplied = decisions.filter((d) => d.reasons.some((r) => r.startsWith("generic_source") || r.startsWith("focus_does_not_allow") || r === "low_relevance")).length;
  const boostsApplied = decisions.filter((d) => d.reasons.some((r) => /boost|missed/.test(r))).length;
  return { recentEvaluations: evalsCount, qualitySummaryUsed, penaltiesApplied, boostsApplied };
}

export function traceStageLabels(bundle: BundleLike, candidates: ContextItemLike[], curateResult: CurateResultLike) {
  const processDecision = bundle.sourcePlan?.planner
    ? `${bundle.sourcePlan.planner}: ${(bundle.sourcePlan.reason || "no source-plan reason").slice(0, 160)}`
    : "no source plan";
  const dataSufficiency = curateResult.abstain
    ? `insufficient: ${(curateResult.abstainReason || curateResult.plannerReason || "compiler abstained").slice(0, 160)}`
    : `sufficient: selected ${bundle.items.length}/${candidates.length} candidates via ${curateResult.planner}`;
  const finalContext = bundle.items.length
    ? `provided: ${bundle.items.length} item(s); ${bundle.items.map((item) => item.source).slice(0, 3).join(", ")}`.slice(0, 240)
    : "silent_abstain: no context injected";
  return { processDecision, dataSufficiency, finalContext };
}
