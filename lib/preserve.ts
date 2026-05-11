// ── Persistence signals (compiled once, reused per call) ─────────────────────

const ONE_OFF_PATTERNS = [
  "line ", "line:", "fix typo", "fixed typo", "deleted line",
  "removed line", "changed line", "added line", "inserted line",
  "column ", "cell ", "row ", "specific case", "this one time",
  "just now", "yesterday", "this morning", "just fixed", "minor",
];

const GENERIC_KNOWLEDGE = [
  "python has", "javascript has", "typescript has", "git has",
  "list comprehension", "array method", "async await", "try catch",
  "for loop", "while loop", "import statement", "export default",
];

const STRUCTURAL_SIGNALS = [
  "always", "never", "must", "should", "rule", "invariant", "principle",
  "convention", "standard", "pattern", "structure", "format", "schema",
  "constraint", "requirement", "immutable", "atomic", "idempotent",
];

const GENERIC_TAGS = new Set(["general", "coding", "development", "programming", "software"]);

const PROJECT_TAGS = new Set(["alphabot", "clearstack", "trading", "python", "typescript"]);

const TRANSCENDENTAL_TAGS = ["concept", "principle", "pattern", "invariant", "framework", "model"];

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Routing ────────────────────────────────────────────────────────────────

function routeReflection(entry: PreservationInput): string {
  if (entry.hasTarget) return "project";
  const tags = new Set(entry.tags.map((t) => t.toLowerCase()));
  const isTranscendental = TRANSCENDENTAL_TAGS.some((t) => tags.has(t));
  const isHigh = entry.importance === "critical" || entry.importance === "high";
  if (isTranscendental && isHigh) return "obsidian";
  if (entry.type === "process" && entry.importance === "critical") return "obsidian";
  if ((entry.type === "pattern" || entry.type === "knowledge") && isHigh) return "obsidian";
  if (entry.type === "process") return "scratchpad";
  if (entry.type === "automation") return "obsidian";
  return "obsidian";
}

// ── Decision gate ───────────────────────────────────────────────────────────

export function evaluatePersistence(entry: PreservationInput): PreservationDecision {
  const text = `${entry.title} ${entry.summary}`.toLowerCase();
  const summaryLength = entry.summary.length;
  const tags = new Set(entry.tags.map((t) => t.toLowerCase()));

  if (summaryLength < 80) {
    return { decision: "discard", reason: "Too brief to contain useful structural knowledge", destination: "none", confidence: "high" };
  }

  if (ONE_OFF_PATTERNS.some((p) => text.includes(p))) {
    if (!STRUCTURAL_SIGNALS.some((s) => text.includes(s))) {
      return { decision: "discard", reason: "Looks like a one-off fix, not a structural rule", destination: "none", confidence: "high" };
    }
  }

  if (GENERIC_KNOWLEDGE.some((p) => text.includes(p))) {
    const isSpecific = summaryLength > 300 || [...tags].some((t) => PROJECT_TAGS.has(t));
    if (!isSpecific) {
      return { decision: "discard", reason: "Generic knowledge the model already knows", destination: "none", confidence: "medium" };
    }
  }

  if ((entry.importance === "medium" || entry.importance === "low") && !STRUCTURAL_SIGNALS.some((s) => text.includes(s))) {
    return { decision: "discard", reason: "Medium/low importance without structural value — ephemeral", destination: "scratchpad", confidence: "medium" };
  }

  const genericTagCount = [...tags].filter((t) => GENERIC_TAGS.has(t)).length;
  if (genericTagCount >= 2 && summaryLength < 300) {
    return { decision: "discard", reason: "Tags too generic and summary too short — not actionable", destination: "none", confidence: "medium" };
  }

  const destination = routeReflection(entry);
  const hasStructural = STRUCTURAL_SIGNALS.some((s) => text.includes(s));
  const confidence: PreservationDecision["confidence"] =
    (entry.importance === "critical" || entry.importance === "high") && hasStructural ? "high"
    : entry.importance === "high" || entry.importance === "critical" ? "medium"
    : "low";

  return { decision: "persist", reason: "Contains structural knowledge worth preserving", destination, confidence };
}
