import { buildContextSignal } from "./context-signal";
import { createBundleId, stashContextBundle, type ContextBundleRecord } from "./evaluation";

/** ContextBundle construction helpers without importing index.ts types. */

type ContextItemLike = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
  raw?: string;
  inline?: boolean;
};

type BundleStateLike = {
  bundles: number;
  lastBundleId?: string;
  bundleRecords?: Map<string, ContextBundleRecord>;
};

export type ContextBundleLike<TItem extends ContextItemLike = ContextItemLike, TSourcePlan = unknown> = {
  bundleId: string;
  taskId: string;
  focus: string;
  mode: string;
  budgetUsedTokens: number;
  items: TItem[];
  candidateCount?: number;
  sourcePlan?: TSourcePlan;
  signal?: ReturnType<typeof buildContextSignal>;
};

export function createContextBundle<TItem extends ContextItemLike, TSourcePlan>(
  state: BundleStateLike,
  focus: string,
  mode: string,
  budgetUsedTokens: number,
  items: TItem[],
  candidateCount: number,
  sourcePlan: TSourcePlan,
): ContextBundleLike<TItem, TSourcePlan> {
  state.bundles++;
  const bundle: ContextBundleLike<TItem, TSourcePlan> = {
    bundleId: createBundleId(),
    taskId: `sherpa-${Date.now()}`,
    focus,
    mode,
    budgetUsedTokens,
    items,
    candidateCount,
    sourcePlan,
  };
  bundle.signal = buildContextSignal(bundle);
  stashContextBundle(state, bundle);
  return bundle;
}

export function createEmptyContextBundle<TItem extends ContextItemLike, TSourcePlan>(
  state: BundleStateLike,
  focus: string,
  mode: string,
  candidates: TItem[],
  sourcePlan: TSourcePlan,
): ContextBundleLike<TItem, TSourcePlan> {
  return createContextBundle(state, focus, mode, 0, [], candidates.length, sourcePlan);
}
