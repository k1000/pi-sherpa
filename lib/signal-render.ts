import type { ContextSignalV1 } from "./context-types";
import { conciseSummary } from "./text-utils";

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
