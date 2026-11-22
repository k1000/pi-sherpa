import { restoreBundleRecords, type ContextBundleRecord } from "./evaluation";

/** Apply and serialize Sherpa persisted session state without importing index.ts types. */

type PersistedSherpaStateLike = {
  nextHandle?: number;
  bundles?: number;
  feedback?: unknown;
  automation?: unknown;
  lifecycleHashes?: unknown;
  evaluationHashes?: unknown;
  lastBundleId?: string;
  dspyAuto?: unknown;
  bundleRecords?: unknown;
  config?: unknown;
};

type SherpaStateLike = {
  nextHandle: number;
  bundles: number;
  feedback: unknown;
  automation: unknown;
  lifecycleHashes: unknown;
  evaluationHashes: unknown;
  lastBundleId?: string;
  dspyAuto: unknown;
  bundleRecords: Map<string, ContextBundleRecord>;
  config: unknown;
};

export function applyPersistedState<TState extends SherpaStateLike>(state: TState, data: PersistedSherpaStateLike): void {
  state.nextHandle = Math.max(state.nextHandle, data.nextHandle ?? 1);
  state.bundles = data.bundles ?? state.bundles;
  state.feedback = data.feedback ?? state.feedback;
  state.automation = { ...(state.automation as object), ...((data.automation ?? {}) as object) };
  state.lifecycleHashes = Array.isArray(data.lifecycleHashes) ? data.lifecycleHashes : state.lifecycleHashes;
  state.evaluationHashes = Array.isArray(data.evaluationHashes) ? data.evaluationHashes : state.evaluationHashes;
  state.lastBundleId = data.lastBundleId ?? state.lastBundleId;
  state.dspyAuto = { ...(state.dspyAuto as object), ...((data.dspyAuto ?? {}) as object) };
  state.bundleRecords = restoreBundleRecords(data.bundleRecords);
}

export function serializeState(state: SherpaStateLike): PersistedSherpaStateLike {
  return {
    nextHandle: state.nextHandle,
    bundles: state.bundles,
    feedback: state.feedback,
    automation: state.automation,
    lifecycleHashes: state.lifecycleHashes,
    evaluationHashes: state.evaluationHashes,
    lastBundleId: state.lastBundleId,
    dspyAuto: state.dspyAuto,
    bundleRecords: [...state.bundleRecords.values()],
    config: state.config,
  };
}
