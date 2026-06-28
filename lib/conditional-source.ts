/**
 * Conditional Source Activation — Context sources with activation conditions.
 *
 * Ported from Hermes Agent's conditional skill activation pattern.
 * Hermes uses `fallback_for_toolsets` and `requires_toolsets` to auto-show/hide
 * skills based on available tools. Sherpa adapts this to context sources.
 *
 * Sources can declare `when` conditions that are evaluated at retrieval time:
 * - taskType: Only include when the task matches a specific type
 * - minRelevance: Only include when relevance >= threshold
 * - presentSources: Only include when certain other sources are also active
 */

// ── Types ───────────────────────────────────────────────────────────

export type SourceCondition = {
  /** Only include when taskType matches one of these values */
  taskType?: string[];
  /** Only include when the query matches one of these patterns (case-insensitive) */
  queryPattern?: string[];
  /** Only include when this source has >= minRelevance relevance score */
  minRelevance?: number;
  /** Only include when ALL of these sources are enabled */
  requireSources?: string[];
  /** Only include when NONE of these sources are enabled (fallback pattern) */
  excludeWhenSources?: string[];
};

export type ConditionalSource = {
  /** Source identifier (e.g., "semble", "graphify", "project_memory") */
  id: string;
  /** Human-readable label */
  label: string;
  /** Activation conditions */
  when?: SourceCondition;
};

export type ActivationContext = {
  /** The current task type */
  taskType?: string;
  /** The current focus/query text */
  query?: string;
  /** Which sources are currently enabled in config */
  enabledSources: Set<string>;
};

// ── Source registry ───────────────────────────────────────────────────

const BUILT_IN_SOURCES: ConditionalSource[] = [
  { id: "files", label: "Source files" },
  { id: "git", label: "Git status" },
  { id: "docs", label: "Documentation files" },
  {
    id: "session",
    label: "Session logs",
    when: {
      excludeWhenSources: ["files"],
      minRelevance: 0.3,
    },
  },
  {
    id: "web",
    label: "Web search results",
    when: {
      minRelevance: 0.6,
      queryPattern: ["search", "find", "look up", "what is", "how to", "latest", "current", "news"],
    },
  },
  {
    id: "semble",
    label: "Semble semantic search",
    when: {
      taskType: ["code_search", "refactor", "bug_fix", "feature"],
      minRelevance: 0.4,
    },
  },
  {
    id: "graphify",
    label: "Graphify knowledge graph",
    when: {
      taskType: ["architecture", "design", "refactor", "onboarding"],
      minRelevance: 0.3,
    },
  },
  {
    id: "project_memory",
    label: "Project memory (Obsidian)",
    when: {
      minRelevance: 0.2,
    },
  },
  {
    id: "logs",
    label: "Log files",
    when: {
      taskType: ["debug", "investigate", "diagnose"],
      queryPattern: ["error", "log", "crash", "exception", "fail"],
      minRelevance: 0.5,
    },
  },
];

// ── Evaluation ──────────────────────────────────────────────────────

type ConditionEval = () => "active" | "inactive" | null;

function evalTaskType(condition: SourceCondition, context: ActivationContext): ConditionEval {
  if (!condition.taskType?.length) return () => null;
  return () => {
    if (!context.taskType) return "inactive";
    return condition.taskType.some((t) => context.taskType!.toLowerCase().includes(t.toLowerCase())) ? null : "inactive";
  };
}

function evalQueryPattern(condition: SourceCondition, context: ActivationContext): ConditionEval {
  if (!condition.queryPattern?.length) return () => null;
  return () => {
    if (!context.query) return "inactive";
    return condition.queryPattern.some((p) => context.query!.toLowerCase().includes(p.toLowerCase())) ? null : "inactive";
  };
}

function evalRequireSources(condition: SourceCondition, context: ActivationContext): ConditionEval {
  if (!condition.requireSources?.length) return () => null;
  return () => condition.requireSources.every((s) => context.enabledSources.has(s)) ? null : "inactive";
}

function evalExcludeWhenSources(condition: SourceCondition, context: ActivationContext): ConditionEval {
  if (!condition.excludeWhenSources?.length) return () => null;
  return () => condition.excludeWhenSources.some((s) => context.enabledSources.has(s)) ? "inactive" : null;
}

const CONDITION_EVALUATORS: Array<(c: SourceCondition, ctx: ActivationContext) => ConditionEval> = [
  evalTaskType, evalQueryPattern, evalRequireSources, evalExcludeWhenSources,
];

/**
 * Evaluate whether a source should be active given the current context.
 */
export function evaluateSource(
  source: ConditionalSource,
  context: ActivationContext,
): "active" | "inactive" | "skipped" {
  if (!context.enabledSources.has(source.id)) return "skipped";
  const condition = source.when;
  if (!condition) return "active";
  for (const ev of CONDITION_EVALUATORS) {
    const result = ev(condition, context)();
    if (result) return result;
  }
  return "active";
}

/**
 * Filter a list of sources based on activation conditions.
 * Returns an ordered list of active source IDs.
 */
export function filterActiveSources(
  sourceIds: string[],
  context: ActivationContext,
  customSources?: ConditionalSource[],
): string[] {
  const registry = [...BUILT_IN_SOURCES, ...(customSources ?? [])];
  const sourceMap = new Map(registry.map((s) => [s.id, s]));

  return sourceIds.filter((id) => {
    const source = sourceMap.get(id);
    if (!source) return true; // Unknown sources pass through
    return evaluateSource(source, context) === "active";
  });
}

/**
 * Get the list of built-in conditional sources and their status.
 */
export function listSourceStatus(
  context: ActivationContext,
): Array<{ id: string; label: string; status: "active" | "inactive" | "skipped" }> {
  return BUILT_IN_SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    status: evaluateSource(source, context),
  }));
}
