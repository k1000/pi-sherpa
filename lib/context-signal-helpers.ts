type ContextItemLike = { type: string; source: string; relevance: number };

export type SuggestedCommandLike = { command: string; reason: string };

/** Pure helpers for context-signal task typing and command suggestions. */

export function inferTaskType(focus: string) {
  const f = focus.toLowerCase();
  if (/\b(fix|bug|failing|error|exception|debug)\b/.test(f)) return "debug";
  if (/\b(implement|add|build|create)\b/.test(f)) return "implementation";
  if (/\b(refactor|cleanup|clean up)\b/.test(f)) return "refactor";
  if (/\b(test|spec|coverage)\b/.test(f)) return "test";
  if (/\b(explain|what is|where is|how do|show me|summarize)\b/.test(f)) return "explanation";
  if (/\b(plan|prd|design|proposal)\b/.test(f)) return "planning";
  if (/\b(web|research|read\s+it|paper|arxiv|url)\b/.test(f)) return "research";
  return "unknown";
}

export function whyItemMatters(item: ContextItemLike, taskType: string) {
  if (item.type === "git_status") return "Shows current repo changes before acting.";
  if (item.type === "url_reference") return "User explicitly referenced this URL.";
  if (item.type.includes("doc")) return taskType === "explanation" || taskType === "planning" ? "Relevant documentation for the requested explanation or plan." : "Documentation may constrain the implementation.";
  if (item.type.includes("file")) return taskType === "test" ? "Relevant source/test location for the requested test work." : "Likely code location related to the task.";
  if (item.type.includes("kb")) return "Project memory may contain reusable conventions or prior lessons.";
  return "Selected as relevant source-grounded context.";
}

export function inferSuggestedCommands(focus: string, items: ContextItemLike[]): SuggestedCommandLike[] {
  const f = focus.toLowerCase();
  const commands: SuggestedCommandLike[] = [];
  const hasPackage = items.some(i => /package\.json/.test(i.source));
  if (/\b(test|failing|fix|bug)\b/.test(f)) commands.push({ command: hasPackage ? "npm test" : "run the focused test command for the touched area", reason: "Validate the suspected failing behavior after inspection or edit." });
  if (/\b(typecheck|typescript|tsc)\b/.test(f)) commands.push({ command: hasPackage ? "npm run typecheck" : "run the project typecheck command", reason: "Validate TypeScript changes." });
  return commands.slice(0, 3);
}

export function isDirectAnswerCandidate(focus: string, taskType: string, items: ContextItemLike[]) {
  if (!items.length) return false;
  const f = focus.toLowerCase();
  return taskType === "explanation" && /\b(where is|what is|which file|show me|how do i|how to)\b/.test(f) && items[0].relevance >= 0.55;
}
