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

export function routeReflection(entry: PreservationInput): string {
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

type EvalContext = { text: string; length: number; tags: Set<string>; importance: string };

function evalContext(entry: PreservationInput): EvalContext {
  const text = `${entry.title} ${entry.summary}`.toLowerCase();
  return { text, length: entry.summary.length, tags: new Set(entry.tags.map((t) => t.toLowerCase())), importance: entry.importance };
}

type GuardResult = PreservationDecision | null;

function guardTooBrief(ctx: EvalContext): GuardResult {
  if (ctx.length < 80) return { decision: "discard", reason: "Too brief to contain useful structural knowledge", destination: "none", confidence: "high" };
  return null;
}

function guardOneOff(ctx: EvalContext, entry: PreservationInput): GuardResult {
  if (ONE_OFF_PATTERNS.some((p) => ctx.text.includes(p)) && !STRUCTURAL_SIGNALS.some((s) => ctx.text.includes(s))) {
    return { decision: "discard", reason: "Looks like a one-off fix, not a structural rule", destination: "none", confidence: "high" };
  }
  return null;
}

function guardGenericKnowledge(ctx: EvalContext): GuardResult {
  if (GENERIC_KNOWLEDGE.some((p) => ctx.text.includes(p))) {
    const isSpecific = ctx.length > 300 || [...ctx.tags].some((t) => PROJECT_TAGS.has(t));
    if (!isSpecific) return { decision: "discard", reason: "Generic knowledge the model already knows", destination: "none", confidence: "medium" };
  }
  return null;
}

function guardLowImportance(ctx: EvalContext): GuardResult {
  if ((ctx.importance === "medium" || ctx.importance === "low") && !STRUCTURAL_SIGNALS.some((s) => ctx.text.includes(s))) {
    return { decision: "discard", reason: "Medium/low importance without structural value — ephemeral", destination: "scratchpad", confidence: "medium" };
  }
  return null;
}

function guardGenericTags(ctx: EvalContext): GuardResult {
  const genericTagCount = [...ctx.tags].filter((t) => GENERIC_TAGS.has(t)).length;
  if (genericTagCount >= 2 && ctx.length < 300) {
    return { decision: "discard", reason: "Tags too generic and summary too short — not actionable", destination: "none", confidence: "medium" };
  }
  return null;
}

function persistDecision(entry: PreservationInput, ctx: EvalContext): PreservationDecision {
  const destination = routeReflection(entry);
  const hasStructural = STRUCTURAL_SIGNALS.some((s) => ctx.text.includes(s));
  const confidence: PreservationDecision["confidence"] =
    (ctx.importance === "critical" || ctx.importance === "high") && hasStructural ? "high"
    : ctx.importance === "high" || ctx.importance === "critical" ? "medium"
    : "low";
  return { decision: "persist", reason: "Contains structural knowledge worth preserving", destination, confidence };
}

const PERSISTENCE_GUARDS: Array<(ctx: EvalContext, entry: PreservationInput) => GuardResult> = [
  guardTooBrief, guardOneOff, guardGenericKnowledge, guardLowImportance, guardGenericTags,
];

export function evaluatePersistence(entry: PreservationInput): PreservationDecision {
  const ctx = evalContext(entry);
  for (const guard of PERSISTENCE_GUARDS) {
    const result = guard(ctx, entry);
    if (result) return result;
  }
  return persistDecision(entry, ctx);
}
