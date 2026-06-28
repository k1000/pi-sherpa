/**
 * Context signal type family (v1).
 *
 * Extracted from index.ts. Pure data shapes describing how Sherpa signals
 * selected context to the main model: disposition, proposed response, items,
 * risks, suggested commands, and opening recommendation.
 */

export type SuggestedCommand = { command: string; reason: string };

export type SmallEditPlan = {
  confidence: number;
  risk: "low" | "medium";
  files: Array<{ source: string; changeType: "replace" | "append" | "create"; summary: string }>;
  validation: SuggestedCommand[];
  requiresApproval: boolean;
};

export type ProposedResponse = {
  kind: "answer" | "edit_plan" | "context";
  content: string;
  citations: Array<{ source: string; handle?: string }>;
  caveats: string[];
};

export type ContextDisposition =
  | { kind: "answer_directly"; reason: string }
  | { kind: "small_edit"; reason: string; editPlan: SmallEditPlan }
  | { kind: "provide_context"; reason: string }
  | { kind: "abstain"; reason: string };

export type ContextSignalItem = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
  why: string;
  inline?: string;
};

export type ContextSignalV1 = {
  version: "1";
  focus: string;
  taskType: string;
  confidence: number;
  disposition: ContextDisposition;
  proposedResponse?: ProposedResponse;
  items: ContextSignalItem[];
  risks: string[];
  missingInfo: string[];
  suggestedCommands: SuggestedCommand[];
  openingRecommendation?: {
    likelyUseful: string[];
    likelyNoise: string[];
    missingInfoNeeded: string[];
  };
  renderHints?: { style: "minimal" | "normal" | "detailed"; maxItems?: number };
  diagnostics: { sourcesSearched: string[]; candidateCount: number; selectedCount: number };
};
