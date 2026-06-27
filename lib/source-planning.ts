import { extractJsonObject } from "./json-utils";
import { isPiSherpaMetaDebugPrompt, isTraceLogMetricsPrompt } from "./query-classifier";

export type Source = "files" | "git" | "docs" | "session" | "web" | "logs" | "project_memory" | "surreal_memory" | "semble" | "graphify";

export type SourcePlan = {
  sources: Source[];
  reason: string;
  confidence: number;
  planner: "heuristic" | "llm" | "override" | "fallback";
};

const ALL_RETRIEVAL_SOURCES: Source[] = ["files", "semble", "graphify", "docs", "git", "session", "project_memory", "surreal_memory", "web"];

export function normalizeSources(input: string[] | undefined, mode: string): Source[] {
  const allowed = new Set<Source>(mode === "front-door"
    ? ["files", "semble", "graphify", "docs", "git", "project_memory", "surreal_memory", "web"]
    : ALL_RETRIEVAL_SOURCES);
  const out: Source[] = [];
  for (const raw of input ?? []) {
    const s = raw;
    if (allowed.has(s as Source) && !out.includes(s as Source)) out.push(s as Source);
  }
  // Semble is the default code-search companion. Any plan that searches repo
  // files should also search Semble unless the project config disables it.
  if (out.includes("files") && allowed.has("semble") && !out.includes("semble")) out.push("semble");
  if (out.includes("files") && allowed.has("graphify") && !out.includes("graphify") && /\b(architecture|architectural|topology|call path|calls?|dependencies|dependency|relationship|relationships|connects?|connected|subsystem|boundary|boundaries|community|communities|flow|pipeline)\b/i.test(input?.join(" ") ?? "")) out.push("graphify");
  return out;
}

const SHERPA_STOP_WORDS = new Set([
  "like", "want", "dont", "don", "this", "that", "these", "those", "with", "from", "into", "through", "during", "before", "after", "above", "below", "between", "under", "again", "further", "then", "once", "here", "there", "when", "where", "while", "because", "until", "since", "about", "against", "among", "along", "around", "beyond", "despite", "except", "inside", "outside", "toward", "within", "without", "across", "behind", "beside", "beneath", "besides", "concerning", "considering", "following", "including", "regarding", "throughout", "upon", "would", "could", "should", "might", "must", "shall", "will", "need", "dare", "ought", "used", "able", "also", "just", "only", "even", "back", "still", "already", "yet", "ever", "never", "always", "often", "sometimes", "usually", "really", "quite", "very", "too", "much", "many", "more", "most", "some", "any", "all", "both", "each", "every", "few", "little", "less", "least", "other", "another", "such", "same", "own", "sure", "true", "false", "right", "left", "last", "first", "next", "previous", "early", "late", "soon", "now", "today", "tomorrow", "yesterday", "ago", "hence", "thus", "therefore", "however", "moreover", "furthermore", "nevertheless", "nonetheless", "otherwise", "instead", "meanwhile", "rather", "pretty", "fairly", "almost", "nearly", "hardly", "barely", "simply", "easily", "probably", "possibly", "perhaps", "maybe", "certainly", "definitely", "absolutely", "completely", "totally", "entirely", "mostly", "partly", "slightly", "somewhat", "kind", "sort", "type", "way", "thing", "stuff", "point", "part", "piece", "bit", "lot", "group", "set", "list", "line", "area", "side", "end", "top", "bottom", "front", "middle", "center", "edge", "corner", "place", "spot", "case", "example", "instance", "fact", "reason", "cause", "result", "effect", "idea", "thought", "view", "opinion", "belief", "feeling", "sense", "question", "answer", "problem", "issue", "matter", "subject", "topic", "theme", "story", "news", "report", "study", "research", "project", "work", "job", "task", "duty", "role", "goal", "aim", "purpose", "plan", "strategy", "method", "approach", "process", "step", "stage", "phase", "level", "degree", "rate", "amount", "number", "quantity", "sum", "total", "whole", "half", "third", "quarter", "percent", "hundred", "thousand", "million", "billion",
]);

export function extractSearchTerms(query: string, max = 12): string[] {
  const raw = query.match(/[A-Za-z0-9_./-]{4,}/g) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (SHERPA_STOP_WORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(t);
    if (terms.length >= max) break;
  }
  return terms;
}

// Fallback: extract search terms the same way the old pipeline used.
// Inferior to model inference but prevents complete failure when model is unavailable.
export function heuristicIndicators(focus: string): string[] {
  return extractSearchTerms(focus, 12);
}

export function heuristicSourcePlan(focus: string, mode: string): SourcePlan {
  const f = focus.toLowerCase();
  const sources: Source[] = [];
  const add = (...ss: Source[]) => { for (const s of ss) if (!sources.includes(s)) sources.push(s); };

  if (/\b(fix|bug|implement|refactor|test|typecheck|lint|compile|failing|error|exception|stack|function|class|api|route|service|schema|repository|component|module)\b/.test(f)) add("files", "semble");
  if (/\b(doc|docs|readme|guide|explain|overview|architecture|design|how\s+to|reference|manual)\b/.test(f)) add("docs");
  if (/\b(architecture|architectural|topology|call path|calls?|dependencies|dependency|relationship|relationships|connects?|connected|concept|conceptual|flow|flows|lifecycle|pipeline|boundary|boundaries|system|design|domain|integration|interactions?|how\s+.+\s+fits|end-to-end|e2e)\b/.test(f)) add("files", "semble", "graphify", "docs", "project_memory", "surreal_memory");
  if (/\b(git|diff|changed|changes|status|staged|unstaged|commit|branch|recent)\b/.test(f)) add("git");
  if (/\b(sherpa|performance|health|trace|traces|retrieval|evaluation|evaluations|quality|useful|usefull|working|correctly|corectly)\b/.test(f)) add("docs", "project_memory", "files");
  if (isTraceLogMetricsPrompt(f) || isPiSherpaMetaDebugPrompt(f)) add("files", "docs", "project_memory");
  if (/\b(memory|remember|convention|pattern|known\s+issue|lesson|skill|kb|knowledge|policy|catalog|taxonomy|tag|tags|ontology|surrealdb|graph\s+memory)\b/.test(f)) add("project_memory", "surreal_memory");
  if (/\b(internet|web|online|search\s+web|latest|current|today|recent\s+news|external\s+source|documentation\s+online)\b/.test(f)) add("web");
  if (mode !== "front-door" && /\b(previous|earlier|continue|session|conversation|last\s+time|we\s+discussed)\b/.test(f)) add("session");

  if (!sources.length) add(...(mode === "front-door" ? ["files", "semble", "docs"] as Source[] : ["files", "semble", "graphify", "docs", "git", "project_memory", "surreal_memory"] as Source[]));
  return { sources, reason: `heuristic matched ${sources.join(", ")}`, confidence: sources.length === 1 ? 0.7 : 0.6, planner: "heuristic" };
}

export function parseSourcePlan(text: string, mode: string): SourcePlan | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as any;
  const sources = normalizeSources(Array.isArray(obj.sources) ? obj.sources : [], mode);
  if (!sources.length) return null;
  return {
    sources,
    reason: typeof obj.reason === "string" ? obj.reason.slice(0, 240) : "llm source plan",
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
    planner: "llm",
  };
}
