import type { ContextDisposition, ContextSignalItem, ContextSignalV1, ProposedResponse, SmallEditPlan } from "./context-types";
import { inferSuggestedCommands, inferTaskType, isDirectAnswerCandidate, whyItemMatters } from "./context-signal-helpers";
import { isLikelyGenericOpeningNoise, isSmallEditCandidate } from "./source-guards";

/** Build Sherpa's structured ContextSignal from selected context items. */

type ContextItemLike = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
  raw?: string;
  inline?: boolean;
};

type ContextBundleLike = {
  focus: string;
  mode: string;
  items: ContextItemLike[];
  candidateCount?: number;
  sourcePlan?: { sources?: string[] };
};

export function buildOpeningRecommendation(signal: Omit<ContextSignalV1, "openingRecommendation">): ContextSignalV1["openingRecommendation"] | undefined {
  const likelyUseful = signal.items
    .filter((item) => item.relevance >= 0.45 && !isLikelyGenericOpeningNoise(item, signal.focus))
    .slice(0, 3)
    .map((item) => `${item.handle} ${item.source}`);
  const likelyNoise = signal.items
    .filter((item) => isLikelyGenericOpeningNoise(item, signal.focus))
    .slice(0, 3)
    .map((item) => `${item.handle} ${item.source}`);
  const missingInfoNeeded = [...signal.risks, ...signal.missingInfo].slice(0, 3);
  if (signal.confidence >= 0.7 && !likelyNoise.length && !missingInfoNeeded.length) return undefined;
  if (!likelyUseful.length && !likelyNoise.length && !missingInfoNeeded.length) return undefined;
  return { likelyUseful, likelyNoise, missingInfoNeeded };
}

export function buildContextSignal(bundle: ContextBundleLike): ContextSignalV1 {
  const taskType = inferTaskType(bundle.focus);
  const best = bundle.items[0]?.relevance ?? 0;
  const confidence = Math.max(0, Math.min(1, best));
  const signalItems: ContextSignalItem[] = bundle.items.map(i => ({
    handle: i.handle,
    type: i.type,
    source: i.source,
    relevance: i.relevance,
    summary: i.summary,
    why: whyItemMatters(i, taskType),
    inline: i.inline ? i.raw : undefined,
  }));
  const suggestedCommands = inferSuggestedCommands(bundle.focus, bundle.items);
  const risks: string[] = [];
  const missingInfo: string[] = [];
  if (!bundle.items.length) missingInfo.push("No high-confidence source-grounded context was found.");
  if (/\b(failing|error|bug|test)\b/i.test(bundle.focus) && !bundle.items.some(i => i.type === "git_status")) risks.push("Exact failing output may still be needed before editing.");
  if (bundle.items.some(i => i.type === "url_reference" && /did not fetch|disabled/i.test(i.summary))) missingInfo.push("Referenced URL was not fetched by Sherpa due to network/privacy settings.");

  let disposition: ContextDisposition = { kind: "provide_context", reason: "Task appears to need the main agent with source-grounded context." };
  let proposedResponse: ProposedResponse | undefined;
  if (!bundle.items.length) {
    disposition = { kind: "abstain", reason: "No useful source-grounded context found." };
  } else if (isSmallEditCandidate(bundle.focus, bundle.items)) {
    const editPlan: SmallEditPlan = {
      confidence,
      risk: confidence >= 0.7 ? "low" : "medium",
      files: bundle.items.filter(i => i.type.includes("file") || i.type.includes("doc")).slice(0, 2).map(i => ({ source: i.source, changeType: "replace", summary: `Make the requested small, localized change using ${i.handle}.` })),
      validation: suggestedCommands,
      requiresApproval: true,
    };
    disposition = { kind: "small_edit", reason: "Request looks like a small localized edit; Sherpa proposes a plan for main-agent review.", editPlan };
    proposedResponse = {
      kind: "edit_plan",
      content: `Proposed small edit: inspect ${editPlan.files.map(f => f.source).join(", ")} and apply the requested localized change. Main agent should review before editing.`,
      citations: editPlan.files.map(f => ({ source: f.source })),
      caveats: editPlan.risk === "medium" ? ["Confidence is moderate; verify target location before editing."] : [],
    };
  } else if (isDirectAnswerCandidate(bundle.focus, taskType, bundle.items)) {
    const top = bundle.items[0];
    disposition = { kind: "answer_directly", reason: "Simple source-grounded lookup or explanation; Sherpa proposes an answer for main-agent review." };
    proposedResponse = {
      kind: "answer",
      content: `${top.summary}`,
      citations: [{ source: top.source, handle: top.handle }],
      caveats: missingInfo,
    };
  }

  const signalBase = {
    version: "1" as const,
    focus: bundle.focus,
    taskType,
    confidence,
    disposition,
    proposedResponse,
    items: signalItems,
    risks,
    missingInfo,
    suggestedCommands,
    renderHints: { style: bundle.mode === "front-door" ? "minimal" as const : "normal" as const, maxItems: 3 },
    diagnostics: { sourcesSearched: bundle.sourcePlan?.sources ?? [], candidateCount: bundle.candidateCount ?? bundle.items.length, selectedCount: bundle.items.length },
  };
  return { ...signalBase, openingRecommendation: buildOpeningRecommendation(signalBase) };
}
