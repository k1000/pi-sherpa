import { isGloballyNoisySource } from "./noise-filter";
import { score, summarize } from "./text-utils";

/** Construct ContextItem candidates and assign stable ctx-* handles. */

type ContextItemLike = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
  raw?: string;
  inline?: boolean;
};

type ContextAdderStateLike<T extends ContextItemLike> = {
  nextHandle: number;
  handles: Map<string, T>;
};

export type AddContextItem = (type: string, source: string, raw: string, relBoost?: number) => void;

export function createContextAdder<T extends ContextItemLike>(state: ContextAdderStateLike<T>, focus: string, candidates: T[]): AddContextItem {
  return (type: string, source: string, raw: string, relBoost = 0) => {
    if (!raw.trim() || isGloballyNoisySource(source)) return;
    const handle = `ctx-${state.nextHandle++}`;
    const inline = raw.length <= 700 && !type.includes("session");
    const summary = summarize(raw);
    const pointer = inline ? "" : ` (expand with /sherpa:expand ${handle})`;
    const item = { handle, type, source, relevance: Math.min(1, score(raw + " " + source, focus) + relBoost), summary: summary + pointer, raw, inline } as T;
    state.handles.set(handle, item);
    candidates.push(item);
  };
}
