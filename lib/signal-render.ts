import { buildContextSignal } from "./context-signal";
import type { ContextSignalV1 } from "./context-types";
import { conciseSummary } from "./text-utils";

type BundleLike = {
  bundleId?: string;
  mode: string;
  budgetUsedTokens: number;
  sourcePlan?: unknown;
  signal?: ContextSignalV1;
  focus: string;
  items: Array<{ handle: string; type: string; source: string; relevance: number; summary: string; raw?: string; inline?: boolean }>;
  candidateCount?: number;
};

/** Pure rendering helpers for Sherpa context signals (markdown formatting). */

export function signalItemMarkdownItem(i: ContextSignalV1["items"][number]): string {
  // Strip protocol prefix from source for readability
  const shortSource = i.source.replace(/^(file|repo):\/\//, "");
  const body = i.inline
    ? `\n\`\`\`\n${i.inline}\n\`\`\``
    : `\n  ${conciseSummary(i.summary)}`;
  return `- ${i.handle} — ${shortSource}${body}`;
}

export function signalMarkdown(signal: ContextSignalV1, mode: string, budgetUsedTokens: number, sourcePlan?: unknown, bundleId?: string) {
  const bundleLine = bundleId ? `\nBundle: ${bundleId}` : "";
  if (signal.disposition.kind === "abstain") return "";
  return `## Context${bundleLine}\n${signal.items.slice(0, signal.renderHints?.maxItems ?? 5).map(signalItemMarkdownItem).join("\n")}`;
}

export function bundleMarkdown(bundle: BundleLike) {
  const signal = bundle.signal ?? buildContextSignal(bundle);
  return signalMarkdown(signal, bundle.mode, bundle.budgetUsedTokens, bundle.sourcePlan, bundle.bundleId);
}
