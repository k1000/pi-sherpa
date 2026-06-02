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
    id: "surreal_memory",
    label: "Surreal memory store",
    when: {
      requireSources: ["project_memory"],
      minRelevance: 0.5,
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

/**
 * Evaluate whether a source should be active given the current context.
 *
 * Returns:
 * - "active" — source should be included
 * - "inactive" — conditions not met
 * - "skipped" — source disabled in config
 */
export function evaluateSource(
  source: ConditionalSource,
  context: ActivationContext,
): "active" | "inactive" | "skipped" {
  // Check if source is enabled in config
  if (!context.enabledSources.has(source.id)) return "skipped";

  const condition = source.when;
  if (!condition) return "active"; // No conditions → always active (if enabled)

  // taskType condition
  if (condition.taskType && condition.taskType.length > 0) {
    if (!context.taskType) return "inactive";
    const match = condition.taskType.some((t) =>
      context.taskType!.toLowerCase().includes(t.toLowerCase()),
    );
    if (!match) return "inactive";
  }

  // queryPattern condition
  if (condition.queryPattern && condition.queryPattern.length > 0) {
    if (!context.query) return "inactive";
    const match = condition.queryPattern.some((p) =>
      context.query!.toLowerCase().includes(p.toLowerCase()),
    );
    if (!match) return "inactive";
  }

  // requireSources condition (AND — all must be present)
  if (condition.requireSources && condition.requireSources.length > 0) {
    const allPresent = condition.requireSources.every((s) =>
      context.enabledSources.has(s),
    );
    if (!allPresent) return "inactive";
  }

  // excludeWhenSources condition (fallback pattern)
  if (condition.excludeWhenSources && condition.excludeWhenSources.length > 0) {
    const anyPresent = condition.excludeWhenSources.some((s) =>
      context.enabledSources.has(s),
    );
    if (anyPresent) return "inactive"; // Fallback: skip when premium source available
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
