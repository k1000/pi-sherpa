import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type ContextItemLike = { handle: string; source: string };
type StateLike = { handles: Map<string, ContextItemLike> };

/** Session/source novelty helpers for suppressing context already shown to the user. */

export function sessionText(ctx: ExtensionContext) {
  try { return JSON.stringify(ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries()); }
  catch { return ""; }
}

export function previouslyShownSourceSet(items: ContextItemLike[], state?: StateLike): Set<string> {
  const previouslyShownSources = new Set<string>();
  const currentHandles = new Set(items.map((item) => item.handle));
  if (state) {
    for (const item of state.handles.values()) {
      if (currentHandles.has(item.handle)) continue;
      if (item.source) {
        previouslyShownSources.add(item.source);
        const noLines = item.source.replace(/:\d+(-\d+)?$/g, "");
        if (noLines !== item.source) previouslyShownSources.add(noLines);
      }
    }
  }
  return previouslyShownSources;
}

export function itemAlreadySeen(ctx: ExtensionContext, item: ContextItemLike, previousSources: Set<string>, text = sessionText(ctx)): boolean {
  if (previousSources.has(item.source)) return true;
  const normalized = item.source.replace(/:\d+(-\d+)?$/g, "");
  if (normalized !== item.source && previousSources.has(normalized)) return true;
  return Boolean(text && text.includes(item.source));
}

export function filterAlreadySeenSources<T extends ContextItemLike>(ctx: ExtensionContext, items: T[], state?: StateLike): T[] {
  const text = sessionText(ctx);
  const previousSources = previouslyShownSourceSet(items, state);
  return items.filter((item) => !itemAlreadySeen(ctx, item, previousSources, text));
}
