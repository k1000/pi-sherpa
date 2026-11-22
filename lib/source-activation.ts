import { filterActiveSources } from "./conditional-source";
import { inferConditionalTaskType } from "./query-target";

/** Conditional source activation helpers. */

type SourceStateLike = { config: { sources: Record<string, boolean> } };

export function enabledSourceSet(state: SourceStateLike): Set<string> {
  return new Set(Object.entries(state.config.sources).filter(([, enabled]) => Boolean(enabled)).map(([source]) => source));
}

export function applyConditionalSourceActivation<T extends string>(state: SourceStateLike, focus: string, mode: string, sources: T[]): T[] {
  return filterActiveSources(sources, {
    taskType: inferConditionalTaskType(focus, mode),
    query: focus,
    enabledSources: enabledSourceSet(state),
  }) as T[];
}

export function retrievalEnabled<T extends string>(state: SourceStateLike, sourcePlan: { sources: T[] }) {
  return (s: T) => Boolean(state.config.sources[s]) && sourcePlan.sources.includes(s);
}
