export type PreservationInput = {
  type: string;
  title: string;
  summary: string;
  importance: string;
  tags: string[];
  hasTarget?: boolean;
};

export type PreservationDecision = {
  decision: "persist" | "discard";
  reason: string;
  destination: string;
  confidence: "high" | "medium" | "low";
};

export function routeReflection(entry: PreservationInput): string {
  if (entry.hasTarget) return "project";

  const transcendental = ["concept", "principle", "pattern", "invariant", "framework", "model"];
  if (transcendental.some((tag) => entry.tags.includes(tag)) && (entry.importance === "critical" || entry.importance === "high")) {
    return "obsidian";
  }

  if (entry.type === "process" && entry.importance === "critical") return "obsidian";
  if ((entry.type === "pattern" || entry.type === "knowledge") && (entry.importance === "critical" || entry.importance === "high")) return "obsidian";
  if (entry.type === "process") return "scratchpad";
  if (entry.type === "automation") return "obsidian";

  return "obsidian";
}

export function evaluatePersistence(entry: PreservationInput): PreservationDecision {
  const text = `${entry.title} ${entry.summary}`.toLowerCase();
  const summaryLength = entry.summary.length;
  const oneOffPatterns = [
    "line ", "line:", "fix typo", "fixed typo", "deleted line",
    "removed line", "changed line", "added line", "inserted line",
    "column ", "cell ", "row ", "specific case", "this one time",
    "just now", "yesterday", "this morning", "just fixed", "minor",
  ];
  const genericKnowledge = [
    "python has", "javascript has", "typescript has", "git has",
    "list comprehension", "array method", "async await", "try catch",
    "for loop", "while loop", "import statement", "export default",
  ];
  const structuralSignals = [
    "always", "never", "must", "should", "rule", "invariant", "principle",
    "convention", "standard", "pattern", "structure", "format", "schema",
    "constraint", "requirement", "immutable", "atomic", "idempotent",
  ];

  if (summaryLength < 80) return { decision: "discard", reason: "Too brief to contain useful structural knowledge", destination: "none", confidence: "high" };

  if (oneOffPatterns.some((pattern) => text.includes(pattern))) {
    const hasStructuralContext = structuralSignals.some((signal) => text.includes(signal));
    if (!hasStructuralContext) return { decision: "discard", reason: "Looks like a one-off fix, not a structural rule", destination: "none", confidence: "high" };
  }

  if (genericKnowledge.some((pattern) => text.includes(pattern))) {
    const isSpecific = summaryLength > 300 || entry.tags.some((tag) => ["alphabot", "clearstack", "trading", "python", "typescript"].includes(tag));
    if (!isSpecific) return { decision: "discard", reason: "Generic knowledge the model already knows", destination: "none", confidence: "medium" };
  }

  if ((entry.importance === "medium" || entry.importance === "low") && !structuralSignals.some((signal) => text.includes(signal))) {
    return { decision: "discard", reason: "Medium/low importance without structural value — ephemeral", destination: "scratchpad", confidence: "medium" };
  }

  const tooGeneric = entry.tags.filter((tag) => ["general", "coding", "development", "programming", "software"].includes(tag)).length >= 2;
  if (tooGeneric && summaryLength < 300) return { decision: "discard", reason: "Tags too generic and summary too short — not actionable", destination: "none", confidence: "medium" };

  const destination = routeReflection(entry);
  const confidence: PreservationDecision["confidence"] =
    (entry.importance === "critical" || entry.importance === "high") && structuralSignals.some((signal) => text.includes(signal))
      ? "high"
      : (entry.importance === "high" || entry.importance === "critical")
        ? "medium"
        : "low";

  return { decision: "persist", reason: "Contains structural knowledge worth preserving", destination, confidence };
}
