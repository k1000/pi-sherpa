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

function shouldShowDiagnostics(signal: ContextSignalV1): boolean {
  return /\b(?:sherpa-context|pi-sherpa|sherpa context|context curation|context compiler)\b/i.test(signal.focus);
}

function diagnosticLine(signal: ContextSignalV1): string {
  if (!shouldShowDiagnostics(signal)) return "";
  const diagnostics = signal.diagnostics;
  const parts = [
    diagnostics.sourcePlanner ? `planner=${diagnostics.sourcePlanner}` : "",
    diagnostics.curationPlanner ? `curator=${diagnostics.curationPlanner}` : "",
    typeof diagnostics.curationConfidence === "number" ? `curatorConfidence=${diagnostics.curationConfidence.toFixed(2)}` : "",
    `candidates=${diagnostics.candidateCount}`,
    `selected=${diagnostics.selectedCount}`,
  ].filter(Boolean);
  return parts.length ? `\nDiagnostics: ${parts.join("; ")}` : "";
}

export function signalMarkdown(signal: ContextSignalV1, mode: string, budgetUsedTokens: number, sourcePlan?: unknown, bundleId?: string) {
  const bundleLine = bundleId ? `\nBundle: ${bundleId}` : "";
  const diagnostics = diagnosticLine(signal);
  if (signal.disposition.kind === "abstain") return "";
  return `## Context${bundleLine}${diagnostics}\n${signal.items.slice(0, signal.renderHints?.maxItems ?? 5).map(signalItemMarkdownItem).join("\n")}`;
}

export function bundleMarkdown(bundle: BundleLike) {
  const signal = bundle.signal ?? buildContextSignal(bundle);
  return signalMarkdown(signal, bundle.mode, bundle.budgetUsedTokens, bundle.sourcePlan, bundle.bundleId);
}
