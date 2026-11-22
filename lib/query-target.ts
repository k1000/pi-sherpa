import { isCodePrompt, isSourceLookupPrompt } from "./query-classifier";
import { focusAllowsGitStatus, focusAllowsHistoricalMemory, focusAllowsResearchMemory } from "./source-guards";

export type QueryTarget = {
  action: string;
  targetTerms: string[];
  evidenceType: "code" | "docs" | "memory" | "git" | "research" | "unknown";
  negativeSources: string[];
};

const TARGET_STOPWORDS = new Set([
  "about", "after", "again", "context", "could", "current", "files", "from", "into", "quality", "review", "should", "source", "sources", "that", "there", "these", "thing", "those", "with", "would",
]);

export function extractQueryTarget(focus: string): QueryTarget {
  const f = focus.toLowerCase();
  const action = /\b(fix|debug|implement|refactor|test|review|explain|find|search|summarize|configure|update)\b/.exec(f)?.[1] ?? "unknown";
  const targetTerms = [...new Set((focus.match(/[A-Za-z][A-Za-z0-9_.-]{3,}/g) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => !TARGET_STOPWORDS.has(term)))]
    .slice(0, 10);
  const evidenceType: QueryTarget["evidenceType"] = focusAllowsGitStatus(focus) ? "git"
    : focusAllowsResearchMemory(focus) ? "research"
    : /\b(doc|docs|readme|guide|manual|prompt|skill)\b/i.test(focus) ? "docs"
    : /\b(memory|lesson|scratchpad|journal|previous|history)\b/i.test(focus) ? "memory"
    : isCodePrompt(focus) || isSourceLookupPrompt(focus) ? "code"
    : "unknown";
  const negativeSources = [
    ...(!focusAllowsGitStatus(focus) ? ["git_status"] : []),
    ...(!focusAllowsResearchMemory(focus) ? ["research_memory"] : []),
    ...(!focusAllowsHistoricalMemory(focus) ? ["journal_memory"] : []),
  ];
  return { action, targetTerms, evidenceType, negativeSources };
}

export function inferConditionalTaskType(focus: string, mode: string): string | undefined {
  const f = focus.toLowerCase();
  if (/\b(debug|diagnose|investigate|error|exception|crash|failing|failed|log)\b/.test(f)) return "debug";
  if (/\b(architecture|design|topology|dependency|dependencies|call path|relationship|boundary|flow|onboard)\b/.test(f)) return "architecture";
  if (/\b(refactor|implement|feature|fix|bug|test|typecheck|lint|compile|function|class|api|route|component|module)\b/.test(f)) return "refactor";
  return mode === "explicit" ? undefined : "code_search";
}
