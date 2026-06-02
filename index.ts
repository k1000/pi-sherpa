import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  hashAutoMemory,
  stringifyForAutoMemory,
} from "./lib/auto-memory";
import {
  createAutomationState,
  discoverRunnableAutomations,
  findRunnableAutomation,
  formatRunnableAutomation,
  recordAutomationRun,
  updateAutomationCandidates,
} from "./lib/automation";
import type { AutomationState } from "./lib/automation";
import { getProjectKBBasedir } from "./lib/project-kb";
import {
  createBundleId,
  getBundle,
  readQualitySummary,
  readRecentEvaluations,
  stashBundle,
  summarizeEvaluations,
  writeEvaluation,
  writeQualitySummary,
  type ContextBundleRecord,
} from "./lib/evaluation";
import { defaultEvaluationReflection, evaluationImprovementHint, formatEvaluationSummary, parseEvaluationArgs } from "./lib/evaluation-command";
import { exportDspyDataset, readCompiledPrompt, readDspyTraces, summarizeDspyTraces, writeDspyTrace } from "./lib/dspy";
import { explicitPathCandidates, pathSourceLabel, readExplicitSource } from "./lib/exact-source";

import { compactScratchpad, classifyTaskOutcome, suggestVerificationCommands } from "./lib/lifecycle";
import { applyEvaluationFeedbackToCandidates, evaluatePostTaskContext } from "./lib/post-task-evaluation";
import { writeDistilledSkill } from "./lib/distillation";
import { assignTiers } from "./lib/progressive-context";
import { filterActiveSources } from "./lib/conditional-source";
import { indexSherpaMemory, searchSherpaMemory, closeSherpaMemoryIndexes } from "./lib/memory-index";
import { indexSessionLog, searchSessions, loadSession, listSessions, getIndexedEntryCount, closeSessionDb } from "./lib/session-search";
import type { SessionSearchMatch } from "./lib/session-search";
import { writeNudge } from "./lib/nudge";
import type { NudgeTarget } from "./lib/nudge";
import { checkAutoDistill, prepareDistillPayloads, getAutoDistillStatus, markAutoDistillRun } from "./lib/auto-distill";
import { ensureRouteMap, parseRouteMap } from "./lib/route-map";
import { searchSemble } from "./lib/semble";
import { MemoryApiStore, type MemoryResult, type MemoryApiStoreConfig } from "./lib/memory-store";
import type { RoutePlan } from "./lib/route-map";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

const FALLBACK_SHERPA_SYSTEM_PROMPT = `You are Pi's Sherpa sidecar. Find, rank, and compress source-grounded context for the main coding agent. If useful context is small, include it inline; if large, provide concise summary plus exact pointers. Abstain quickly when you cannot contribute meaningful evidence. Preserve privacy and never include secrets. Be concise; no chain-of-thought.`;

function promptPath(cwd: string) { return path.join(cwd, ".pi", "sherpa", "SHERPA_SYSTEM.md"); }
function globalPromptPath() { return path.join(path.dirname(__filename), "SHERPA_SYSTEM.md"); }
function resolvePromptPath(base: string, configured: string) { return path.isAbsolute(configured) ? configured : path.join(base, configured); }
type PromptKind = "retrieval" | "distillation" | "documentation" | "automation";
function promptFileName(kind: PromptKind) {
  if (kind === "retrieval") return "RETRIEVAL";
  if (kind === "distillation") return "DISTILLATION";
  if (kind === "documentation") return "DOCUMENTATION";
  return "AUTOMATION";
}
function loadPromptKind(cwd: string, kind: PromptKind, config?: Partial<SherpaConfig>) {
  if (config?.dspy?.enabled) {
    const compiled = readCompiledPrompt(cwd, config.dspy.compiledPromptPath ?? ".pi/sherpa/compiled", kind);
    if (compiled) return { prompt: compiled.prompt, source: `dspy:${compiled.source}` };
  }
  const promptCfg = config?.prompts?.[kind];
  const projectConfigured = promptCfg?.projectPath ?? `.pi/sherpa/prompts/${promptFileName(kind)}.md`;
  const globalConfigured = promptCfg?.globalPath ?? `prompts/${promptFileName(kind)}.md`;
  const candidates = [
    resolvePromptPath(cwd, projectConfigured),
    resolvePromptPath(path.dirname(__filename), globalConfigured),
    promptPath(cwd),
    globalPromptPath(),
  ];
  for (const p of candidates) if (existsSync(p)) return { prompt: readFileSync(p, "utf8"), source: p };
  return { prompt: FALLBACK_SHERPA_SYSTEM_PROMPT, source: "fallback" };
}
function loadSherpaSystemPrompt(cwd: string, config?: Partial<SherpaConfig>) {
  return loadPromptKind(cwd, "retrieval", config);
}


type Mode = "auto" | "explicit" | "proactive" | "off";
type Source = "files" | "git" | "docs" | "session" | "web" | "logs" | "project_memory" | "surreal_memory" | "semble" | "graphify";

type SherpaConfig = {
  enabled: boolean;
  mode: Mode;
  frontDoor: { enabled: boolean; tokenBudget: number };
  explicit: { enabled: boolean; tokenBudget: number };
  proactive: { enabled: boolean; tokenBudget: number; cooldownTurns: number };
  sources: Record<Source, boolean>;
  privacy: { allowNetwork: boolean; allowRemoteModel: boolean };
  model: { provider: string; id: string; useMainPiModel: boolean; heuristicOnly: boolean; fallbackToHeuristics: boolean };
  summarization: { maxToolResultChars: number; replacementBudget: number };
  memory: { obsidianVault: string; obsidianMemoryPath: string; scratchpadPath: string };
  web: { enabled: boolean; provider: "brave" | "tavily" | "serpapi"; apiKeyEnv: string; maxResults: number; timeoutMs: number; cacheTtlMs: number };
  semble: { enabled: boolean; command: string; topK: number; timeoutMs: number };
  graphify: { enabled: boolean; command: string; graphPath: string; timeoutMs: number; budgetTokens: number; maxLines: number; };
  memoryStore: { surreal: MemoryApiStoreConfig };
  surrealMemory: { chainWeightBoost: number; constrainedLimit: number; broadFallbackLimit: number; evidenceDepth: number };
  routeMap: { enabled: boolean; path: string; applyTo: "all" | "front-door" | "explicit" };
  dedupe: { urls: { enabled: boolean; normalize: boolean; scope: "bundle" } };
  dspy: {
    enabled: boolean;
    compiledPromptPath: string;
    autoCompile: { enabled: boolean; minTraces: number; bundleInterval: number; onEvaluate: boolean; onSessionShutdown: boolean; maxOncePerDay: boolean };
  };
  prompts: Record<PromptKind, { projectPath?: string; globalPath?: string }>;
};

type ContextItem = { handle: string; type: string; source: string; relevance: number; summary: string; raw?: string; inline?: boolean };
type SourcePlan = { sources: Source[]; reason: string; confidence: number; planner: "heuristic" | "llm" | "override" | "fallback"; routePlan?: RoutePlan };
// Sherpa three-stage retrieval pipeline types
type SearchIndicators = { indicators: string[]; reason: string; confidence: number; planner: "heuristic" | "llm" };
type CurateResult = {
  items: ContextItem[];
  abstain: boolean;
  abstainReason: string;
  rejected: Array<{ index: number; reason: string; source: string }>;
  confidence: number;
  planner: "heuristic" | "llm";
};
type ContextBundle = { bundleId: string; taskId: string; focus: string; mode: string; budgetUsedTokens: number; items: ContextItem[]; candidateCount?: number; sourcePlan?: SourcePlan; signal?: ContextSignalV1 };

type ContextDisposition =
  | { kind: "answer_directly"; reason: string }
  | { kind: "small_edit"; reason: string; editPlan: SmallEditPlan }
  | { kind: "provide_context"; reason: string }
  | { kind: "abstain"; reason: string };

type ContextSignalItem = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
  why: string;
  inline?: string;
};

type SuggestedCommand = { command: string; reason: string };
type SmallEditPlan = {
  confidence: number;
  risk: "low" | "medium";
  files: Array<{ source: string; changeType: "replace" | "append" | "create"; summary: string }>;
  validation: SuggestedCommand[];
  requiresApproval: boolean;
};
type ProposedResponse = {
  kind: "answer" | "edit_plan" | "context";
  content: string;
  citations: Array<{ source: string; handle?: string }>;
  caveats: string[];
};
type ContextSignalV1 = {
  version: "1";
  focus: string;
  taskType: string;
  confidence: number;
  disposition: ContextDisposition;
  proposedResponse?: ProposedResponse;
  items: ContextSignalItem[];
  risks: string[];
  missingInfo: string[];
  suggestedCommands: SuggestedCommand[];
  openingRecommendation?: {
    likelyUseful: string[];
    likelyNoise: string[];
    missingInfoNeeded: string[];
  };
  renderHints?: { style: "minimal" | "normal" | "detailed"; maxItems?: number };
  diagnostics: { sourcesSearched: string[]; candidateCount: number; selectedCount: number };
};

type State = {
  config: SherpaConfig;
  handles: Map<string, ContextItem>;
  nextHandle: number;
  bundles: number;
  lastSkip: string;
  turnCount: number;
  lastProactiveTurn: number;
  feedback: Array<{ used: string[]; unused: string[]; missing: string[]; at: number }>;
  bundleRecords: Map<string, ContextBundleRecord>;
  lastBundleId?: string;
  dspyAuto: { lastCompileAt?: string; lastCompileDate?: string; lastBundleCount: number };
  automation: AutomationState;
  lifecycleHashes: string[];
  systemPrompt: string;
  systemPromptSource: string;
  retrievalPrompt: string;
  retrievalPromptSource: string;
  distillPrompt: string;
  distillPromptSource: string;
  documentationPrompt: string;
  documentationPromptSource: string;
  automationPrompt: string;
  automationPromptSource: string;
};

const runAutomationSchema = Type.Object({
  name: Type.String({ description: "Automation name or command from package.json/scripts" }),
  dryRun: Type.Optional(Type.Boolean({ description: "Only show the resolved automation command" })),
});
type RunAutomationParams = Static<typeof runAutomationSchema>;

const requestSchema = Type.Object({
  focus: Type.String({ description: "What context is needed for" }),
  taskType: Type.Optional(Type.String()),
  tokenBudget: Type.Optional(Type.Number()),
  sources: Type.Optional(Type.Array(Type.String())),
  expandHandles: Type.Optional(Type.Array(Type.String())),
  searchOtherProjects: Type.Optional(Type.Boolean({ description: "Also search other Obsidian project catalogs for this concept" })),
  includeTaxonomy: Type.Optional(Type.Boolean({ description: "Also include matching rows from the global taxonomy.csv" })),
});
type RequestParams = Static<typeof requestSchema>;

const SCRATCHPAD_SECTIONS = ["todo", "observation", "issue", "next", "distill_candidate"] as const;
type ScratchpadSection = typeof SCRATCHPAD_SECTIONS[number];
const scratchpadSectionSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("observation"),
  Type.Literal("issue"),
  Type.Literal("next"),
  Type.Literal("distill_candidate"),
], { description: "Scratchpad section: todo | observation | issue | next | distill_candidate" });

const scratchpadReadSchema = Type.Object({
  section: Type.Optional(scratchpadSectionSchema),
  limitChars: Type.Optional(Type.Number({ description: "Maximum characters to return from the end of each section", minimum: 1, maximum: 50000 })),
});
type ScratchpadReadParams = Static<typeof scratchpadReadSchema>;

const scratchpadAppendSchema = Type.Object({
  section: scratchpadSectionSchema,
  text: Type.String({ description: "Scratchpad entry text to append" }),
  title: Type.Optional(Type.String({ description: "Optional short heading for the entry" })),
});
type ScratchpadAppendParams = Static<typeof scratchpadAppendSchema>;

function projectMemoryRel(cwd: string) {
  const name = path.basename(cwd).replace(/[^A-Za-z0-9_-]+/g, "-") || "project";
  return `projects/${name}`;
}

const DEFAULT_CONFIG: SherpaConfig = {
  enabled: true,
  mode: "auto",
  frontDoor: { enabled: true, tokenBudget: 1200 },
  explicit: { enabled: true, tokenBudget: 3000 },
  proactive: { enabled: false, tokenBudget: 800, cooldownTurns: 3 },
  sources: { files: true, git: true, docs: true, session: true, web: false, logs: false, project_memory: true, surreal_memory: false, semble: true, graphify: true },
  privacy: { allowNetwork: false, allowRemoteModel: false },
  model: { provider: "olmx", id: "Qwen3.6-35B-A3B-4bit", useMainPiModel: false, heuristicOnly: false, fallbackToHeuristics: true },
  summarization: { maxToolResultChars: 12000, replacementBudget: 1500 },
  memory: { obsidianVault: "/Users/kamil/Documents/articles", obsidianMemoryPath: "projects/project", scratchpadPath: ".pi-memory/scratchpad" },
  web: { enabled: false, provider: "brave", apiKeyEnv: "BRAVE_SEARCH_API_KEY", maxResults: 5, timeoutMs: 5000, cacheTtlMs: 6 * 60 * 60 * 1000 },
  semble: { enabled: true, command: "semble", topK: 8, timeoutMs: 3000 },
  graphify: { enabled: true, command: "graphify", graphPath: "graphify-out/graph.json", timeoutMs: 1200, budgetTokens: 1200, maxLines: 24 },
  memoryStore: { surreal: { enabled: false, mode: "memory-api", url: "http://127.0.0.1:8010", namespace: "pi", database: "memory", userEnv: "SURREAL_USER", passEnv: "SURREAL_PASS" } },
  surrealMemory: { chainWeightBoost: 0.12, constrainedLimit: 8, broadFallbackLimit: 4, evidenceDepth: 2 },
  routeMap: { enabled: true, path: "catalog.csv", applyTo: "all" },
  dedupe: { urls: { enabled: true, normalize: true, scope: "bundle" } },
  dspy: { enabled: false, compiledPromptPath: ".pi/sherpa/compiled", autoCompile: { enabled: true, minTraces: 10, bundleInterval: 25, onEvaluate: true, onSessionShutdown: true, maxOncePerDay: true } },
  prompts: {
    retrieval: { projectPath: ".pi/sherpa/prompts/RETRIEVAL.md", globalPath: "prompts/RETRIEVAL.md" },
    distillation: { projectPath: ".pi/sherpa/prompts/DISTILLATION.md", globalPath: "prompts/DISTILLATION.md" },
    documentation: { projectPath: ".pi/sherpa/prompts/DOCUMENTATION.md", globalPath: "prompts/DOCUMENTATION.md" },
    automation: { projectPath: ".pi/sherpa/prompts/AUTOMATION.md", globalPath: "prompts/AUTOMATION.md" },
  },
};

function configPath(cwd: string) { return path.join(cwd, ".pi", "sherpa.config.json"); }
function defaultConfigForCwd(cwd: string): SherpaConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.obsidianMemoryPath = projectMemoryRel(cwd);
  return cfg;
}
function loadConfig(cwd: string): SherpaConfig {
  const p = configPath(cwd);
  const base = defaultConfigForCwd(cwd);
  if (!existsSync(p)) return base;
  try { return mergeConfig(base, JSON.parse(readFileSync(p, "utf8"))); }
  catch { return base; }
}
function saveConfig(cwd: string, cfg: SherpaConfig) {
  const p = configPath(cwd); mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}
function obsidianVaultPath(state: State) {
  return state.config.memory?.obsidianVault || DEFAULT_CONFIG.memory.obsidianVault;
}
function obsidianMemoryPath(state: State) {
  const configured = state.config.memory?.obsidianMemoryPath || DEFAULT_CONFIG.memory.obsidianMemoryPath;
  return path.isAbsolute(configured) ? configured : path.join(obsidianVaultPath(state), configured);
}
function scratchpadRootPath(state: State, cwd: string) {
  const configured = state.config.memory?.scratchpadPath || DEFAULT_CONFIG.memory.scratchpadPath;
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}
function safeRootPath(root: string, rel: string) {
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes root: ${rel}`);
  return target;
}
function safeScratchpadPath(state: State, cwd: string, rel: string) {
  return safeRootPath(scratchpadRootPath(state, cwd), rel);
}
function todayIsoDate() { return new Date().toISOString().slice(0, 10); }
function appendScratchpad(state: State, cwd: string, rel: string, content: string) {
  const target = safeScratchpadPath(state, cwd, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, content.endsWith("\n") ? content : content + "\n");
  return target;
}
function writeScratchpad(state: State, cwd: string, rel: string, content: string) {
  const target = safeScratchpadPath(state, cwd, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content.endsWith("\n") ? content : content + "\n");
  return target;
}
function readScratchpad(state: State, cwd: string, rel: string) {
  const target = safeScratchpadPath(state, cwd, rel);
  return existsSync(target) ? readFileSync(target, "utf8") : "";
}
function scratchpadSectionTitle(section: string) {
  const normalized = section.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return normalized || "Note";
}
function scratchpadSectionRel(section: ScratchpadSection) {
  return `sections/${section}.md`;
}
function readScratchpadSection(state: State, cwd: string, section: ScratchpadSection, limitChars = 12000) {
  const target = safeScratchpadPath(state, cwd, scratchpadSectionRel(section));
  if (!existsSync(target)) return { target, text: "" };
  const raw = readFileSync(target, "utf8");
  const max = Math.max(1, Math.min(limitChars, 50000));
  return { target, text: raw.length > max ? raw.slice(-max) : raw };
}
function appendScratchpadSection(state: State, cwd: string, section: ScratchpadSection, text: string, title?: string) {
  const now = new Date().toISOString();
  const heading = title?.trim() ? `### ${title.trim()} — ${now}` : `### ${now}`;
  const entry = ["", heading, "", text.trim(), ""].join("\n");
  return appendScratchpad(state, cwd, scratchpadSectionRel(section), entry);
}
function scratchpadRootRelative(state: State, cwd: string, target: string) {
  return path.relative(scratchpadRootPath(state, cwd), target);
}
function mergeConfig(base: any, over: any): any {
  if (!over || typeof over !== "object") return structuredClone(base);
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? mergeConfig(base?.[k] ?? {}, v) : v;
  return out;
}

function approxTokens(s: string) { return Math.ceil(s.length / 4); }
function isTrivial(text: string) { return text.trim().length < 24 && !/[/.]|error|fail|test|bug|fix|refactor|implement/i.test(text); }
function shouldAbstain(items: ContextItem[], mode: string) {
  if (!items.length) return "no source-grounded context found";
  const best = items[0]?.relevance ?? 0;
  const threshold = mode === "front-door" ? 0.4 : 0.12;
  if (best < threshold) return `best relevance ${best.toFixed(2)} below ${threshold}`;
  return "";
}
function score(text: string, focus: string) {
  const words = new Set(focus.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  let hits = 0; for (const w of words) if (text.toLowerCase().includes(w)) hits++;
  return words.size ? hits / words.size : 0.1;
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ",") { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}

type CatalogRow = Record<string, string>;
function readCsvRows(target: string): CatalogRow[] {
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, "utf8").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]!).map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: CatalogRow = {};
    header.forEach((key, index) => { row[key] = cells[index] ?? ""; });
    return row;
  });
}
function readProjectCatalog(obsidianRoot: string): CatalogRow[] {
  return readCsvRows(path.join(obsidianRoot, "catalog.csv")).filter((row) => row.id && row.path);
}
function catalogMatches(root: string, focus: string, limit = 8) {
  return readProjectCatalog(root)
    .map((row) => ({ row, relevance: score([
      row.id, row.scope, row.project, row.area, row.category, row.type, row.title, row.summary,
      row.aliases, row.tags, row.related, row.based_on, row.supports, row.implements,
      row.derives_from, row.applies_research, row.applied_by_project, row.generalizes_from,
      row.specializes, row.routes, row.keywords,
    ].filter(Boolean).join("\n"), focus) }))
    .filter((item) => item.relevance > 0.08)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}
function readGlobalTaxonomy(): CatalogRow[] {
  return readCsvRows("/Users/kamil/Documents/articles/taxonomy.csv").filter((row) => row.kind && row.id);
}
function summarize(raw: string, budgetChars = 700) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const important = lines.filter(l => /error|fail|exception|warning|todo|fixme|export |function |class |describe\(|it\(/i.test(l));
  const picked = (important.length ? important : lines).slice(0, 10).join("\n");
  return picked.length > budgetChars ? picked.slice(0, budgetChars - 1) + "…" : picked;
}

function normalizeUrl(raw: string) {
  const cleaned = raw.trim().replace(/[)\].,;!?]+$/g, "");
  try {
    const u = new URL(cleaned);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^utm_/i.test(key) || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/g, "");
    return u.toString();
  } catch { return cleaned; }
}

function extractUrls(text: string) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(/https?:\/\/\S+/g)) {
    const url = normalizeUrl(match[0]);
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

const FRONT_DOOR_MAX_DOCS = 2;
const SHERPA_UI_KEY = "ai-sherpa";
const SHERPA_LEGACY_UI_KEY = "ai-sherpa-progress";
const SHERPA_CONTEXT_TYPE = "sherpa-context";
const CURATION_TIMEOUT_MS = 8_000;
const SOURCE_PLANNER_TIMEOUT_MS = 1_500;
const DSPY_COMPILE_MIN_EVALUATIONS = 10;
const DSPY_COMPILE_MIN_AVG_METRIC = 0.65;
const DSPY_COMPILE_MIN_HIGH_EXAMPLES = 3;

function isCodePrompt(focus: string) {
  return /\b(fix|bug|implement|refactor|test|typecheck|lint|compile|failing|error|exception|stack|function|class|api|route|service|schema|repository|component|hook|module|typescript|javascript|python|sql)\b/i.test(focus);
}

function inferConditionalTaskType(focus: string, mode: string): string | undefined {
  const f = focus.toLowerCase();
  if (/\b(debug|diagnose|investigate|error|exception|crash|failing|failed|log)\b/.test(f)) return "debug";
  if (/\b(architecture|design|topology|dependency|dependencies|call path|relationship|boundary|flow|onboard)\b/.test(f)) return "architecture";
  if (/\b(refactor|implement|feature|fix|bug|test|typecheck|lint|compile|function|class|api|route|component|module)\b/.test(f)) return "refactor";
  return mode === "explicit" ? undefined : "code_search";
}

function enabledSourceSet(state: State): Set<string> {
  return new Set(Object.entries(state.config.sources).filter(([, enabled]) => Boolean(enabled)).map(([source]) => source));
}

function applyConditionalSourceActivation(state: State, focus: string, mode: string, sources: Source[]): Source[] {
  return filterActiveSources(sources, {
    taskType: inferConditionalTaskType(focus, mode),
    query: focus,
    enabledSources: enabledSourceSet(state),
  }) as Source[];
}

function isPreloadedContextFile(rel: string) {
  const normalized = rel.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(agents|claude)\.md$/.test(normalized);
}

function isNoisyFrontDoorDoc(rel: string) {
  const normalized = rel.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(changelog|roadmap|ideas|notes|meeting-notes|scratch|draft|archive)(\/|\.|-|_)/.test(normalized)
    || /(^|\/)(archive|archives|drafts|scratch|notes)\//.test(normalized);
}

function docMatchesFocus(rel: string, focus: string, mode: string) {
  if (isPreloadedContextFile(rel)) return false;

  // Explicit /sherpa requests may browse broadly. Front-door injection should be
  // selective because it competes with the main prompt/context budget.
  if (mode !== "front-door") return true;
  if (isNoisyFrontDoorDoc(rel)) return false;
  if (rel === "README.md" || rel === "docs/README.md") return true;

  const f = focus.toLowerCase();
  const r = rel.toLowerCase();
  const has = (re: RegExp) => re.test(f);

  const deploymentDoc = /quick-start|workflow|deploy|deployment|docker|cloudflare|opencode|server|production|prod|dev/.test(r);
  if (deploymentDoc) return has(/\b(deploy|deployment|docker|cloudflare|server|prod|production|dev\s*server|ci|cd|build|release|hot\s*reload)\b/);

  const agentDoc = /agent|cron|schedule|handoff|analysis|signal|alphabot/.test(r);
  if (agentDoc) return has(/\b(agent|agents|cron|schedule|scheduler|handoff|analysis|analyst|signal|signals|alphabot|prompt)\b/);

  const tradingDoc = /broker|trading|trade|risk|strategy|backtest|execution|portfolio|market/.test(r);
  if (tradingDoc) return has(/\b(broker|trading|trade|risk|strategy|backtest|execution|portfolio|market|order|position)\b/);

  return score(rel, focus) >= 0.34;
}

function getDocFilesForFocus(cwd: string, focus: string, mode: string, routePlan?: RoutePlan) {
  const routedDocs = routePlan?.docs ?? [];
  const docFiles = [...routedDocs, "README.md", "docs/README.md"];
  const docsDir = path.join(cwd, "docs");
  if (existsSync(docsDir)) {
    try {
      for (const f of readdirSync(docsDir).filter(n => n.endsWith(".md")).slice(0, 50)) {
        const rel = path.join("docs", f);
        if (!docFiles.includes(rel) && docMatchesFocus(rel, focus, mode)) docFiles.push(rel);
      }
    } catch { /* ignore */ }
  }
  const matched = docFiles.filter(rel => docMatchesFocus(rel, focus, mode) && !routeSkipsPath(routePlan, rel));
  if (mode !== "front-door") return matched;
  const generic = matched.filter(rel => rel === "README.md" || rel === "docs/README.md");
  const specific = matched.filter(rel => rel !== "README.md" && rel !== "docs/README.md");
  return (specific.length ? [...specific.slice(0, 1), ...generic] : generic).slice(0, FRONT_DOOR_MAX_DOCS);
}

function routeMapApplies(state: State, mode: string) {
  const applyTo = state.config.routeMap?.applyTo ?? "all";
  return Boolean(state.config.routeMap?.enabled) && (applyTo === "all" || applyTo === mode);
}

function matchRoutePlan(state: State, cwd: string, focus: string, mode: string): RoutePlan | undefined {
  if (!routeMapApplies(state, mode)) return undefined;
  try {
    const routePath = path.isAbsolute(state.config.routeMap.path) ? state.config.routeMap.path : path.join(cwd, state.config.routeMap.path);
    if (!existsSync(routePath)) return undefined;
    const routes = parseRouteMap(readFileSync(routePath, "utf8"));
    const f = focus.toLowerCase();
    const scored = routes.map(r => ({ ...r, score: r.triggers.reduce((n, t) => n + (t && f.includes(t.toLowerCase()) ? 1 : 0), 0) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0];
  } catch { return undefined; }
}

function routeSkipsPath(routePlan: RoutePlan | undefined, p: string) {
  if (!routePlan) return false;
  const normalized = p.replace(/\\/g, "/").toLowerCase();
  return routePlan.skip.some(s => s && normalized.includes(s.replace(/\\/g, "/").toLowerCase()));
}

function isSourceLookupPrompt(focus: string) {
  return /\b(where|which file|what file|implemented|implementation|tested|test covers|exact files?|function names?|code generates|served|stored|configured|connects|downloads|display)\b/i.test(focus);
}

function isStickyGenericSnippet(item: Pick<ContextItem, "source" | "summary" | "raw" | "type">) {
  const text = `${item.source}\n${item.summary}\n${item.raw ?? ""}`.toLowerCase();
  return text.includes("if websocket fails, stick falls back")
    || text.includes("falls back to get /agent/jobs/{id} polling")
    || text.includes("sherpa returned low-confidence context instead of abstaining")
    || text.includes("surface route contamination warnings when route names/paths do not exist");
}

function permitsRootReadme(focus: string) {
  return /\b(root\s+readme|readme\.md|eth-lag-alpha|repo overview|project overview)\b/i.test(focus);
}

function isRootReadmeSource(source: string) {
  const normalized = source.replace(/\\/g, "/").toLowerCase();
  return normalized === "repo://readme.md" || normalized.startsWith("repo://readme.md:");
}

function isGenericNoiseSource(source: string) {
  const normalized = source.replace(/\\/g, "/").toLowerCase();
  return normalized === "repo://readme.md"
    || normalized.endsWith("/readme.md")
    || normalized.includes("/readme.md:")
    || normalized.startsWith("file://~/.pi/agent/skills/")
    || normalized.includes("/wiki/systems/archivist-sherpa-gap-analysis.md");
}

function sourceCorrespondenceThreshold(focus: string, mode: string) {
  if (mode !== "front-door") return -Infinity;
  if (isCodePrompt(focus) || isSourceLookupPrompt(focus)) return 0.16;
  return 0.08;
}

function sourceDedupeKey(source: string) {
  if (source.startsWith("repo://README.md")) return "repo://README.md";
  return source.replace(/:\d+(?::\d+)?$/, "");
}

function candidateSortKey(item: ContextItem, focus: string, mode: string) {
  const wantsSource = isCodePrompt(focus) || isSourceLookupPrompt(focus);
  let value = item.relevance;
  if (wantsSource) {
    value += item.type === "file_snippet" || item.type === "file_exact" || item.type === "semantic_code_snippet" ? 0.35
      : item.type === "doc_snippet" ? -0.25
      : 0;
  }
  if (isRootReadmeSource(item.source) && !permitsRootReadme(focus)) value -= 1.0;
  if (item.source === "repo://README.md") value -= wantsSource ? 0.35 : 0.15;
  if (isGenericNoiseSource(item.source)) value -= wantsSource ? 0.3 : 0.12;
  if (isStickyGenericSnippet(item)) value -= 0.5;
  if (/repo:\/\/(docs\/sherpa-|\.pi\/sherpa-)/.test(item.source) && !/\bsherpa\b/i.test(focus)) value -= 0.45;
  return value;
}

function sessionText(ctx: ExtensionContext) {
  try { return JSON.stringify(ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries()); }
  catch { return ""; }
}

function filterAlreadySeenSources(ctx: ExtensionContext, items: ContextItem[]) {
  const text = sessionText(ctx);
  if (!text) return items;
  return items.filter(i => !text.includes(i.source));
}

function postProcessCandidates(candidates: ContextItem[], focus: string, mode: string) {
  const wantsSource = isCodePrompt(focus) || isSourceLookupPrompt(focus);
  const sorted = [...candidates].sort((a, b) => candidateSortKey(b, focus, mode) - candidateSortKey(a, focus, mode));
  const out: ContextItem[] = [];
  const seen = new Set<string>();
  let readmeCount = 0;
  for (const item of sorted) {
    const key = sourceDedupeKey(item.source);
    if (seen.has(key)) continue;
    if (isRootReadmeSource(item.source)) {
      if (!permitsRootReadme(focus)) continue;
      if (readmeCount >= 1) continue;
      if (wantsSource && isStickyGenericSnippet(item)) continue;
      readmeCount++;
    }
    if (candidateSortKey(item, focus, mode) < sourceCorrespondenceThreshold(focus, mode)) continue;
    if (wantsSource && /repo:\/\/(docs\/sherpa-|\.pi\/sherpa-)/.test(item.source) && !/\bsherpa\b/i.test(focus)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function heuristicOrderCandidates(candidates: ContextItem[], focus: string, mode: string) {
  return postProcessCandidates(candidates, focus, mode);
}

function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { return null; }
}

function timeoutAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

const ALL_RETRIEVAL_SOURCES: Source[] = ["files", "semble", "graphify", "docs", "git", "session", "project_memory", "surreal_memory", "web"];

function normalizeSources(input: string[] | undefined, mode: string): Source[] {
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

function extractSearchTerms(query: string, max = 12): string[] {
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
function heuristicIndicators(focus: string): string[] {
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
  if (/\b(memory|remember|convention|pattern|known\s+issue|lesson|skill|kb|knowledge|policy|catalog|taxonomy|tag|tags|ontology|surrealdb|graph\s+memory)\b/.test(f)) add("project_memory", "surreal_memory");
  if (/\b(internet|web|online|search\s+web|latest|current|today|recent\s+news|external\s+source|documentation\s+online)\b/.test(f)) add("web");
  if (mode !== "front-door" && /\b(previous|earlier|continue|session|conversation|last\s+time|we\s+discussed)\b/.test(f)) add("session");

  if (!sources.length) add(...(mode === "front-door" ? ["files", "semble", "docs"] as Source[] : ["files", "semble", "graphify", "docs", "git", "project_memory", "surreal_memory"] as Source[]));
  return { sources, reason: `heuristic matched ${sources.join(", ")}`, confidence: sources.length === 1 ? 0.7 : 0.6, planner: "heuristic" };
}

function parseSourcePlan(text: string, mode: string): SourcePlan | null {
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

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { return null; }
}

async function inferSearchIndicators(state: State, ctx: ExtensionContext, focus: string): Promise<SearchIndicators> {
  // Stage 1: model infers which unique technical identifiers would appear in relevant context.
  // Runs ONCE per request and feeds into all subsequent searches.
  if (state.config.model.heuristicOnly) {
    return { indicators: heuristicIndicators(focus), reason: "heuristic extraction", confidence: 0.3, planner: "heuristic" };
  }
  const model = state.config.model.useMainPiModel ? ctx.model : ctx.modelRegistry.find(state.config.model.provider, state.config.model.id);
  if (!model) {
    return { indicators: heuristicIndicators(focus), reason: "model unavailable, falling back", confidence: 0.3, planner: "heuristic" };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { indicators: heuristicIndicators(focus), reason: "no API key, falling back", confidence: 0.3, planner: "heuristic" };
  }
  const message: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      `User intent: ${focus}`,
      "",
      "You are Sherpa, a code search expert. Given the user's intent above,",
      "list 8-12 SPECIFIC technical identifiers (function names, variable names, file patterns,",
      "module paths, domain terms) that would appear in RELEVANT source code or documentation.",
      "",
      "Rules:",
      "- Prefer SPECIFIC identifiers over generic ones. 'parseTree', 'tokenize', 'grammarRule'",
      "  are good. 'user', 'data', 'error', 'value' are only useful if paired with a domain-specific term.",
      "- These indicators should discriminate RELEVANT code from IRRELEVANT code that happens",
      "  to share the same raw keywords.",
      "- If the intent is about trading strategies, 'grid_spacing', 'position_sizing', 'risk_limit'",
      "  matter more than 'strategy' or 'trade'.",
      'Return ONLY JSON: {"indicators":["..."],"reason":"why these indicators","confidence":0.0}',
    ].join("\\n") }],
  };
  try {
    const response = await Promise.race([
      complete(model, { systemPrompt: state.retrievalPrompt, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal }),
      timeoutAfter<any>(SOURCE_PLANNER_TIMEOUT_MS, "indicator inference timed out"),
    ]);
    if (response.stopReason === "aborted") {
      return { indicators: heuristicIndicators(focus), reason: "model aborted, falling back", confidence: 0.2, planner: "heuristic" };
    }
    const text = response.content.filter((c: any): c is { type: "text"; text: string } => c.type === "text").map((c: any) => c.text).join("\\n");
    const parsed = extractJsonObject(text) as any;
    if (parsed && Array.isArray(parsed.indicators) && parsed.indicators.length > 0) {
      const indicators = parsed.indicators
        .filter((s: unknown): s is string => typeof s === "string" && s.length >= 2)
        .slice(0, 12);
      return {
        indicators,
        reason: String(parsed.reason ?? "").slice(0, 240) || "model inference",
        confidence: Math.max(0.1, Math.min(1, Number(parsed.confidence ?? 0.5))),
        planner: "llm",
      };
    }
    return { indicators: heuristicIndicators(focus), reason: "model returned invalid JSON, falling back", confidence: 0.2, planner: "heuristic" };
  } catch {
    return { indicators: heuristicIndicators(focus), reason: "model error, falling back", confidence: 0.2, planner: "heuristic" };
  }
}

async function planSources(state: State, ctx: ExtensionContext, focus: string, mode: string, sourceOverride?: string[]): Promise<{ sourcePlan: SourcePlan; indicators: SearchIndicators }> {
  // Returns BOTH source plan (Stage 0/2) and inferred search indicators (Stage 1).
  const routePlan = matchRoutePlan(state, ctx.cwd, focus, mode);
  const overridden = normalizeSources(sourceOverride, mode);
  if (overridden.length) {
    const sourcePlan: SourcePlan = { sources: overridden, reason: "explicit source override", confidence: 1, planner: "override", routePlan };
    const indicators = await inferSearchIndicators(state, ctx, focus);
    return { sourcePlan, indicators };
  }

  const fallbackPlan = { ...heuristicSourcePlan(focus, mode), routePlan };
  if (routePlan) {
    const routedSources = normalizeSources([...fallbackPlan.sources, ...(routePlan.read.length ? ["files"] : []), ...(routePlan.docs.length ? ["docs"] : [])], mode);
    fallbackPlan.sources = routedSources;
    fallbackPlan.reason = `route ${routePlan.name}: ${fallbackPlan.reason}`;
    fallbackPlan.confidence = Math.max(fallbackPlan.confidence, 0.8);
  }
  const heuristicInds = { indicators: heuristicIndicators(focus), reason: "heuristic", confidence: 0.3, planner: "heuristic" as const };

  fallbackPlan.sources = applyConditionalSourceActivation(state, focus, mode, fallbackPlan.sources);

  if (state.config.model.heuristicOnly || mode !== "front-door") {
    return { sourcePlan: fallbackPlan, indicators: heuristicInds };
  }

  const model = state.config.model.useMainPiModel ? ctx.model : ctx.modelRegistry.find(state.config.model.provider, state.config.model.id);
  if (!model) return { sourcePlan: fallbackPlan, indicators: heuristicInds };
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return { sourcePlan: fallbackPlan, indicators: heuristicInds };

  // Single model call: infer both indicators (Stage 1) AND source selection.
  const message: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      `User intent: ${focus}`,
      "",
      "You are Sherpa in Stage 1: inferring what to search for.",
      "",
      "TASK A — Search indicators: List 8-12 SPECIFIC technical identifiers",
      "(function names, file patterns, module paths, domain terms) that would appear in",
      'RELEVANT code — not just any code containing the raw keywords.',
      'Return as JSON: {"indicators":{"indicators":["..."],"reason":"...","confidence":0.0}}',
      "",
      "TASK B — Source selection: Which sources should Sherpa search?",
      "Available: files, semble, graphify, docs, git, project_memory, surreal_memory, web.",
      "Act as a router:",
      "- If the prompt is clearly reduced to source code, implementation, symbols, tests, errors, or exact files, choose files + semble.",
      "- If the prompt asks about architecture, topology, call paths, dependencies, relationships, subsystem boundaries, or how X connects to Y, choose graphify + files + semble.",
      "- If the prompt spans conceptual setup, flows, lifecycles, boundaries, or how code fits into a system, choose graphify + files + semble + project_memory, and docs when durable docs likely help.",
      "Prefer the fewest sources likely to contain the answer.",
      "Choose web only for current/latest/online facts not in the repo.",
      'Also return as JSON: {"sources":{"sources":["..."],"reason":"...","confidence":0.0}}',
      "",
      `Return ONLY a single JSON object with both "indicators" and "sources" keys.`,
    ].join("\\n") }],
  };

  try {
    const response = await Promise.race([
      complete(model, { systemPrompt: state.retrievalPrompt, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal }),
      timeoutAfter<any>(SOURCE_PLANNER_TIMEOUT_MS, "source + indicator planning timed out"),
    ]);
    if (response.stopReason === "aborted") {
      return { sourcePlan: fallbackPlan, indicators: heuristicInds };
    }
    const text = response.content.filter((c: any): c is { type: "text"; text: string } => c.type === "text").map((c: any) => c.text).join("\\n");
    const parsed = extractJsonObject(text) as any;

    let indicators: SearchIndicators = heuristicInds;
    if (parsed?.indicators && Array.isArray(parsed.indicators.indicators) && parsed.indicators.indicators.length > 0) {
      const inds = parsed.indicators.indicators
        .filter((s: unknown): s is string => typeof s === "string" && s.length >= 2)
        .slice(0, 12);
      indicators = {
        indicators: inds,
        reason: String(parsed.indicators.reason ?? "").slice(0, 240) || "model inference",
        confidence: Math.max(0.1, Math.min(1, Number(parsed.indicators.confidence ?? 0.5))),
        planner: "llm",
      };
    }

    if (parsed?.sources) {
      const rawSources = JSON.stringify(parsed.sources);
      const sourcePlan = parseSourcePlan(rawSources, mode);
      if (sourcePlan?.sources.length) {
        const mergedSources = normalizeSources([...sourcePlan.sources, ...(routePlan?.read.length ? ["files"] : []), ...(routePlan?.docs.length ? ["docs"] : [])], mode);
        return { sourcePlan: { ...sourcePlan, sources: applyConditionalSourceActivation(state, focus, mode, mergedSources), routePlan }, indicators };
      }
    }
    return { sourcePlan: { ...fallbackPlan, planner: "fallback", reason: `planner fallback: ${fallbackPlan.reason}` }, indicators };
  } catch {
    return { sourcePlan: fallbackPlan, indicators: heuristicInds };
  }
}


async function curateCandidates(
  state: State,
  ctx: ExtensionContext,
  candidates: ContextItem[],
  focus: string,
  mode: string,
  indicators: SearchIndicators,
): Promise<CurateResult> {
  // Stage 3: model judges whether each candidate actually corresponds to the user's intent.
  // HARD GATE: if no candidates are relevant, the result is abstain — nothing goes to the main agent.
  const heuristicOrdered = heuristicOrderCandidates(candidates, focus, mode);

  if (mode === "front-door" && heuristicOrdered.length === 0) {
    return {
      items: [],
      abstain: true,
      abstainReason: "no curated candidates correspond to the query after suppression",
      rejected: [],
      confidence: 0.3,
      planner: "heuristic",
    };
  }

  if (mode !== "front-door" || state.config.model.heuristicOnly || heuristicOrdered.length <= 1) {
    return {
      items: heuristicOrdered.slice(0, 8),
      abstain: false,
      abstainReason: "",
      rejected: [],
      confidence: 0.3,
      planner: "heuristic",
    };
  }

  const model = state.config.model.useMainPiModel ? ctx.model : ctx.modelRegistry.find(state.config.model.provider, state.config.model.id);
  if (!model) {
    return {
      items: heuristicOrdered.slice(0, 8),
      abstain: false,
      abstainReason: "",
      rejected: [],
      confidence: 0.3,
      planner: "heuristic",
    };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      items: heuristicOrdered.slice(0, 8),
      abstain: false,
      abstainReason: "",
      rejected: [],
      confidence: 0.3,
      planner: "heuristic",
    };
  }

    // Project domain — the model uses this to judge whether the QUERY belongs here.
  const PROJECT_DOMAIN = "pi coding agent, Sherpa context retrieval, file operations, bash commands, "
    + "pi extensions, pi skills, Sherpa memory, Obsidian knowledge bases, coding tasks, "
    + "alphabot trading strategies, backtesting, and workspace operations.";

  // Conservative OOD patterns — only the most obvious non-project queries.
  // These are a safety net; the LLM is the primary domain gate.
  // Hard out-of-domain patterns — obvious non-project queries that need no retrieval.
  // These fire BEFORE calling the LLM, so they save latency and prevent false positives.
  const OOD_PATTERNS = [
    // General world knowledge — never requires project context
    /\bcapital of\b|\bpresident of\b|\bgovernment\b/i,
    /\bphotosynthesis\b|\bquantum physics\b|\bevolution\b/i,
    /\bpoem\b|\bpoetry\b|\bwrite (me )?a (story|poem|song)\b/i,
    /\bmeaning of life\b/i,
    /\brestaurant\b|\brecipe\b|\bbrew\b/i,
    // Personal life advice — never requires project context
    /\bmy (dog|cat|pet|horse|fish)\b/i,
    /\b(wedding|honeymoon|anniversary)\b/i,
    /\bdinner\b|\blunch\b|\bbreakfast\b|\bwhat do I make for\b/i,
    /\blearning (to play )?(guitar|piano|drums)\b|\b(play|learn) guitar at\b/i,
    /\bbirthday card for (my |her |his )?mom\b|\bbirthday message\b/i,
    /\bmy (wife|husband|girlfriend|boyfriend|family|friends?)\b/i,
    /\b(is it worth|should I) learning\b/i,
  ];
  const isLikelyOod = OOD_PATTERNS.some(p => p.test(focus));

  // Filter out generic/noisy candidates that always appear but never help answer specific queries.
  // Session recent entries are JSON session events — they contain many keywords but are too
  // generic to help answer any specific query. Remove them so Stage 3 isn't tricked by keyword collision.
  const NOISY_TYPES = new Set(["session_recent", "session_event", "audit_log", "system_log"]);
  const NOISY_PATTERNS = [
    /session_compact|audit event|session event/i,
    /No durable structural learning|no actionable/i,
    /proactive|session_compact/i,
  ];
  const isNoisy = (c: { type: string; summary: string; raw?: string }) =>
    NOISY_TYPES.has(c.type) ||
    NOISY_PATTERNS.some(p => p.test(c.summary) || (c.raw && p.test(c.raw)));

  const curationPool = heuristicOrdered.filter(c => !isNoisy(c)).slice(0, 30);
  const manifest = curationPool
    .map((c, i) => ({
      index: i,
      type: c.type,
      source: c.source,
      relevance: Number(candidateSortKey(c, focus, mode).toFixed(2)),
      summary: c.summary.slice(0, 500),
      rawExcerpt: (c.raw ?? "").slice(0, 200),
    }));

  const message: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      `User query: ${focus}`,
      `Inferred indicators: ${indicators.indicators.join(", ")}`,
      `Why these indicators: ${indicators.reason}`,
      "",
      "You are Sherpa, Stage 3: domain-gating suppression.",
      "",
      "STEP 1 — Domain check: is this query within the project domain?",
      `Project domain: ${PROJECT_DOMAIN}`,
      "A query is IN-DOMAIN if answering it requires knowledge from the project workspace",
      "(code, files, memory, docs, config, strategy logic, experiment results).",
      "A query is OUT-OF-DOMAIN if the agent can answer it fully from its own knowledge",
      "(general knowledge, personal advice, hobbies, health, food, travel, art).",
      "",
      "CRITICAL — avoid keyword collision: do NOT select a candidate just because it shares",
      "a word with the query. A journal entry mentioning 'France' is NOT relevant to",
      "'what is the capital of France'. A code snippet mentioning 'dog' is NOT relevant to",
      "'my dog is sick'. Relevance means: THIS specific snippet helps answer THIS question.",
      "",
      "STEP 2 — Candidate selection (only if query is in-domain):",
      "For each candidate, ask: 'If someone asked me this question, would THIS snippet help me",
      "give a BETTER, MORE ACCURATE answer than I could give from my own knowledge?'",
      "If yes, select it. If the snippet only shares keywords with the question but covers",
      "a different topic — or if the agent already knows the answer without it — REJECT it.",
      "",
      'Return ONLY JSON with this exact shape:',
      '{',
      '  "queryInDomain": true,          // is the query within the project domain?',
      '  "selected": [0, 3, 5],          // indexes of relevant candidates (ignored if queryInDomain=false)',
      '  "rejected": [{"index":1,"reason":"about X, not Y"}],  // not relevant to this query',
      '  "confidence": 0.0,               // confidence in this judgment',
      '  "reason": "why the query is or is not in-domain, and why selected candidates help',
      '}',
      "",
      JSON.stringify(manifest, null, 2),
    ].join("\\n") }],
  };


  try {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), CURATION_TIMEOUT_MS);
    const response = await complete(
      model,
      { systemPrompt: state.retrievalPrompt, messages: [message] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: abort.signal },
    ).finally(() => clearTimeout(timeout));
    if (response.stopReason === "aborted") {
      return { items: heuristicOrdered.slice(0, 8), abstain: false, abstainReason: "", rejected: [], confidence: 0.2, planner: "heuristic" };
    }
    const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\\n");
    const parsed = extractJsonObject(text) as any;
    if (!parsed) {
      return { items: heuristicOrdered.slice(0, 8), abstain: false, abstainReason: "", rejected: [], confidence: 0.2, planner: "heuristic" };
    }

    const selected: number[] = Array.isArray(parsed.selected) ? parsed.selected : [];
    const queryInDomain = parsed.queryInDomain !== false; // default true, only false if explicitly set
    const rejected: Array<{ index: number; reason: string; source: string }> = Array.isArray(parsed.rejected)
      ? parsed.rejected.filter((r: any) => typeof r?.index === "number").map((r: any) => ({
          index: Number(r.index),
          reason: String(r.reason ?? ""),
          source: String(manifest[r.index]?.source ?? ""),
        }))
      : [];
    const confidence = Math.max(0.1, Math.min(1, Number(parsed.confidence ?? 0.4)));

    // HARD GATE: if query is out-of-domain, suppress everything — let the model answer from its own knowledge.
    // If in-domain but no candidates match, also suppress.
    // The model is the judge — we trust its semantic domain judgment.
    // Additionally, a fast pattern-based pre-filter catches obvious OOD queries before calling the model.
    if (isLikelyOod || !queryInDomain) {
      return {
        items: [],
        abstain: true,
        abstainReason: isLikelyOod
          ? `obvious out-of-domain query — pattern matched '${focus.slice(0, 40)}'`
          : `query is outside project domain — ${String(parsed.reason ?? "model gated it out").slice(0, 200)}`,
        rejected,
        confidence,
        planner: "llm",
      };
    }
    if (selected.length === 0) {
      return {
        items: [],
        abstain: true,
        abstainReason: String(parsed.reason ?? "no relevant candidates found for in-domain query").slice(0, 240),
        rejected,
        confidence,
        planner: "llm",
      };
    }

    const picked: ContextItem[] = [];
    const seen = new Set<number>();
    for (const idx of selected) {
      const n = typeof idx === "number" ? idx : Number(idx);
      if (!Number.isInteger(n) || n < 0 || n >= curationPool.length || seen.has(n)) continue;
      seen.add(n);
      picked.push(curationPool[n]);
      if (picked.length >= 8) break;
    }

    if (!picked.length) {
      return { items: [], abstain: true, abstainReason: "model returned selected indexes but none were valid", rejected, confidence, planner: "llm" };
    }

    return { items: picked, abstain: false, abstainReason: "", rejected, confidence, planner: "llm" };
  } catch {
    return { items: heuristicOrdered.slice(0, 8), abstain: false, abstainReason: "", rejected: [], confidence: 0.2, planner: "heuristic" };
  }
}

async function llmSummarize(ctx: ExtensionContext, state: State, raw: string, budgetChars = 1200): Promise<string> {
  if (state.config.model.heuristicOnly) return summarize(raw, budgetChars);
  const model = state.config.model.useMainPiModel ? ctx.model : ctx.modelRegistry.find(state.config.model.provider, state.config.model.id);
  if (!model) {
    if (state.config.model.fallbackToHeuristics) return summarize(raw, budgetChars);
    throw new Error(`Sherpa model not found: ${state.config.model.provider}/${state.config.model.id}`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    if (state.config.model.fallbackToHeuristics) return summarize(raw, budgetChars);
    throw new Error((auth as any).error ?? `Auth failed for ${model.provider}`);
  }
  if (!auth.apiKey) {
    if (state.config.model.fallbackToHeuristics) return summarize(raw, budgetChars);
    throw new Error(`No API key for ${model.provider}`);
  }
  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: raw.slice(0, 24000) }],
    timestamp: Date.now(),
  };
  const response = await complete(
    model,
    {
      systemPrompt: `${state.distillPrompt}\n\nTask: Summarize this coding-agent context/tool output for the main coding agent. Maximum ${budgetChars} characters. Preserve actionable facts, failures, commands, paths, and next steps. Do not include secrets or raw noisy output.`,
      messages: [message],
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
  );
  if (response.stopReason === "aborted") return summarize(raw, budgetChars);
  const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();
  return text ? (text.length > budgetChars ? text.slice(0, budgetChars - 1) + "…" : text) : summarize(raw, budgetChars);
}
function inferTaskType(focus: string) {
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

function whyItemMatters(item: ContextItem, taskType: string) {
  if (item.type === "git_status") return "Shows current repo changes before acting.";
  if (item.type === "url_reference") return "User explicitly referenced this URL.";
  if (item.type.includes("doc")) return taskType === "explanation" || taskType === "planning" ? "Relevant documentation for the requested explanation or plan." : "Documentation may constrain the implementation.";
  if (item.type.includes("file")) return taskType === "test" ? "Relevant source/test location for the requested test work." : "Likely code location related to the task.";
  if (item.type.includes("kb")) return "Project memory may contain reusable conventions or prior lessons.";
  return "Selected as relevant source-grounded context.";
}

function inferSuggestedCommands(focus: string, items: ContextItem[]): SuggestedCommand[] {
  const f = focus.toLowerCase();
  const commands: SuggestedCommand[] = [];
  const hasPackage = items.some(i => /package\.json/.test(i.source));
  if (/\b(test|failing|fix|bug)\b/.test(f)) commands.push({ command: hasPackage ? "npm test" : "run the focused test command for the touched area", reason: "Validate the suspected failing behavior after inspection or edit." });
  if (/\b(typecheck|typescript|tsc)\b/.test(f)) commands.push({ command: hasPackage ? "npm run typecheck" : "run the project typecheck command", reason: "Validate TypeScript changes." });
  return commands.slice(0, 3);
}

function isDirectAnswerCandidate(focus: string, taskType: string, items: ContextItem[]) {
  if (!items.length) return false;
  const f = focus.toLowerCase();
  return taskType === "explanation" && /\b(where is|what is|which file|show me|how do i|how to)\b/.test(f) && items[0].relevance >= 0.55;
}

function isSmallEditCandidate(focus: string, items: ContextItem[]) {
  const f = focus.toLowerCase();
  if (!/\b(fix|update|add|change|replace|correct)\b/.test(f)) return false;
  if (!/\b(typo|readme|doc|docs|markdown|comment|config|setting|prompt|prd|route map|route-map)\b/.test(f)) return false;
  const fileItems = items.filter(i => i.type.includes("file") || i.type.includes("doc"));
  return fileItems.length > 0 && fileItems.length <= 3 && items[0].relevance >= 0.35;
}

function isLikelyGenericOpeningNoise(item: ContextSignalItem, focus = ""): boolean {
  const source = item.source.toLowerCase();
  const f = focus.toLowerCase();
  const explicitlyNeeded = (source.includes("docs/mission_prompt.md") || source.includes("docs/missions.md")) && /\b(mission|missions|orchestrator|worker|validator|validation contract)\b/.test(f)
    || (source.includes("documentation-drift") || source.includes("archivist_actionable_solutions.md")) && /\b(archivist|preserve|distill|documentation drift|obsidian|memory routing)\b/.test(f)
    || source.includes("/.pi/agent/skills/") && /\b(skill|skills|agent skill|load skill)\b/.test(f)
    || source.endsWith("/readme.md") && /\b(readme|overview|onboard|onboarding|project summary)\b/.test(f);
  if (explicitlyNeeded) return false;
  return item.relevance < 0.25
    || source.endsWith("/readme.md")
    || source.includes("docs/mission_prompt.md")
    || source.includes("docs/missions.md")
    || source.includes("documentation-drift")
    || source.includes("archivist_actionable_solutions.md")
    || source.includes("/.pi/agent/skills/");
}

function buildOpeningRecommendation(signal: Omit<ContextSignalV1, "openingRecommendation">): ContextSignalV1["openingRecommendation"] | undefined {
  const likelyUseful = signal.items
    .filter((item) => item.relevance >= 0.45 && !isLikelyGenericOpeningNoise(item, signal.focus))
    .slice(0, 3)
    .map((item) => `${item.handle} ${item.source}`);
  const likelyNoise = signal.items
    .filter((item) => isLikelyGenericOpeningNoise(item, signal.focus))
    .slice(0, 3)
    .map((item) => `${item.handle} ${item.source}`);
  const missingInfoNeeded = [...signal.risks, ...signal.missingInfo].slice(0, 3);
  if (signal.confidence >= 0.7 && !likelyNoise.length && !missingInfoNeeded.length) return undefined;
  if (!likelyUseful.length && !likelyNoise.length && !missingInfoNeeded.length) return undefined;
  return { likelyUseful, likelyNoise, missingInfoNeeded };
}

function buildContextSignal(bundle: ContextBundle): ContextSignalV1 {
  const taskType = inferTaskType(bundle.focus);
  const best = bundle.items[0]?.relevance ?? 0;
  const confidence = Math.max(0, Math.min(1, best));
  const signalItems: ContextSignalItem[] = bundle.items.map(i => ({
    handle: i.handle,
    type: i.type,
    source: i.source,
    relevance: i.relevance,
    summary: i.summary.replace(/ \(expand with \/sherpa:expand ctx-\d+\)$/i, ""),
    why: whyItemMatters(i, taskType),
    inline: i.inline ? i.raw : undefined,
  }));
  const suggestedCommands = inferSuggestedCommands(bundle.focus, bundle.items);
  const risks: string[] = [];
  const missingInfo: string[] = [];
  if (!bundle.items.length) missingInfo.push("No high-confidence source-grounded context was found.");
  if (/\b(failing|error|bug|test)\b/i.test(bundle.focus) && !bundle.items.some(i => i.type === "git_status")) risks.push("Exact failing output may still be needed before editing.");
  if (bundle.items.some(i => i.type === "url_reference" && /did not fetch|disabled/i.test(i.summary))) missingInfo.push("Referenced URL was not fetched by Sherpa due to network/privacy settings.");

  let disposition: ContextDisposition = { kind: "provide_context", reason: "Task appears to need the main agent with source-grounded context." };
  let proposedResponse: ProposedResponse | undefined;
  if (!bundle.items.length) {
    disposition = { kind: "abstain", reason: "No useful source-grounded context found." };
  } else if (isSmallEditCandidate(bundle.focus, bundle.items)) {
    const editPlan: SmallEditPlan = {
      confidence,
      risk: confidence >= 0.7 ? "low" : "medium",
      files: bundle.items.filter(i => i.type.includes("file") || i.type.includes("doc")).slice(0, 2).map(i => ({ source: i.source, changeType: "replace", summary: `Make the requested small, localized change using ${i.handle}.` })),
      validation: suggestedCommands,
      requiresApproval: true,
    };
    disposition = { kind: "small_edit", reason: "Request looks like a small localized edit; Sherpa proposes a plan for main-agent review.", editPlan };
    proposedResponse = {
      kind: "edit_plan",
      content: `Proposed small edit: inspect ${editPlan.files.map(f => f.source).join(", ")} and apply the requested localized change. Main agent should review before editing.`,
      citations: editPlan.files.map(f => ({ source: f.source })),
      caveats: editPlan.risk === "medium" ? ["Confidence is moderate; verify target location before editing."] : [],
    };
  } else if (isDirectAnswerCandidate(bundle.focus, taskType, bundle.items)) {
    const top = bundle.items[0];
    disposition = { kind: "answer_directly", reason: "Simple source-grounded lookup or explanation; Sherpa proposes an answer for main-agent review." };
    proposedResponse = {
      kind: "answer",
      content: `${top.summary}`,
      citations: [{ source: top.source, handle: top.handle }],
      caveats: missingInfo,
    };
  }

  const signalBase = {
    version: "1" as const,
    focus: bundle.focus,
    taskType,
    confidence,
    disposition,
    proposedResponse,
    items: signalItems,
    risks,
    missingInfo,
    suggestedCommands,
    renderHints: { style: bundle.mode === "front-door" ? "minimal" as const : "normal" as const, maxItems: 8 },
    diagnostics: { sourcesSearched: bundle.sourcePlan?.sources ?? [], candidateCount: bundle.candidateCount ?? bundle.items.length, selectedCount: bundle.items.length },
  };
  return { ...signalBase, openingRecommendation: buildOpeningRecommendation(signalBase) };
}

function signalMarkdown(signal: ContextSignalV1, mode: string, budgetUsedTokens: number, sourcePlan?: SourcePlan) {
  if (signal.disposition.kind === "abstain") return `## Sherpa Context\nNo high-confidence context found for: ${signal.focus}`;
  const routeLine = sourcePlan?.routePlan
    ? `\nRoute: ${sourcePlan.routePlan.name} (${sourcePlan.routePlan.score} trigger matches)\nSources: ${sourcePlan.sources.join(", ")}\n`
    : "";
  const dispositionLine = `\nDisposition: **${signal.disposition.kind}** — ${signal.disposition.reason}\n`;
  const proposal = signal.proposedResponse
    ? `\n### Sherpa proposal for main-agent review\n${signal.proposedResponse.content}\n${signal.proposedResponse.citations.length ? `\nCitations: ${signal.proposedResponse.citations.map(c => c.handle ? `${c.handle} ${c.source}` : c.source).join("; ")}` : ""}\n${signal.proposedResponse.caveats.length ? `\nCaveats: ${signal.proposedResponse.caveats.join("; ")}` : ""}\n`
    : "";
  const riskBlock = signal.risks.length || signal.missingInfo.length
    ? `\n### Risks / missing info\n${[...signal.risks.map(r => `- Risk: ${r}`), ...signal.missingInfo.map(m => `- Missing: ${m}`)].join("\n")}\n`
    : "";
  const commandBlock = signal.suggestedCommands.length
    ? `\n### Suggested validation\n${signal.suggestedCommands.map(c => `- \`${c.command}\` — ${c.reason}`).join("\n")}\n`
    : "";
  const rec = signal.openingRecommendation;
  const openingRecommendationBlock = rec && (rec.likelyUseful.length || rec.likelyNoise.length || rec.missingInfoNeeded.length)
    ? `\n### Opening recommendation\n${[
        rec.likelyUseful.length ? `- Likely useful: ${rec.likelyUseful.join("; ")}` : "",
        rec.likelyNoise.length ? `- Treat as likely noise unless task explicitly needs it: ${rec.likelyNoise.join("; ")}` : "",
        rec.missingInfoNeeded.length ? `- Missing info likely needed: ${rec.missingInfoNeeded.join("; ")}` : "",
      ].filter(Boolean).join("\n")}\n`
    : "";
  const items = signal.items.map(i => {
    const body = i.inline
      ? `\n\`\`\`\n${i.inline}\n\`\`\``
      : `\n  ${i.summary}\n  Why: ${i.why}\n  Pointer: ${i.source}. Expand: /sherpa:expand ${i.handle}`;
    return `- **${i.handle}** [${i.type}, ${(i.relevance * 100).toFixed(0)}%] ${i.source}${body}`;
  }).join("\n");
  return `## Sherpa Context (${mode}, ~${budgetUsedTokens} tokens)${routeLine}${dispositionLine}${proposal}${riskBlock}${commandBlock}${openingRecommendationBlock}\n### Context items\n${items}`;
}

function bundleMarkdown(bundle: ContextBundle) {
  const signal = bundle.signal ?? buildContextSignal(bundle);
  const body = signalMarkdown(signal, bundle.mode, bundle.budgetUsedTokens, bundle.sourcePlan);
  const tiered = assignTiers(bundle.items, Math.max(bundle.budgetUsedTokens, 1));
  const tierSummary = tiered.length
    ? `\n\n### Progressive disclosure\n${[
        `- L0 references: ${tiered.filter((i) => i.tier === 0).length}`,
        `- L1 snippets: ${tiered.filter((i) => i.tier === 1).length}`,
        `- L2 inline/full: ${tiered.filter((i) => i.tier === 2).length}`,
        "- Expand handles with `/sherpa:expand <handle>` or `expandHandles`.",
      ].join("\n")}`
    : "";
  return `${body}${tierSummary}\n\nBundle: ${bundle.bundleId}`;
}

function traceItem(item: ContextItem) {
  return {
    handle: item.handle,
    type: item.type,
    source: item.source,
    relevance: Number(item.relevance.toFixed(4)),
    summary: item.summary.slice(0, 1000),
  };
}

function traceGenericSourceClass(source: string): string | undefined {
  const normalized = source.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("docs/mission_prompt.md") || normalized.includes("docs/missions.md")) return "mission";
  if (normalized.includes("documentation-drift") || normalized.includes("archivist_actionable_solutions.md") || normalized.includes("archivist-sherpa-gap-analysis")) return "archivist";
  if (normalized.includes("/.pi/agent/skills/")) return "skill";
  if (normalized === "repo://readme.md" || normalized.endsWith("/readme.md") || normalized.includes("/readme.md:")) return "readme";
  return undefined;
}

function focusAllowsTraceGenericSource(source: string, focus: string): boolean {
  const f = focus.toLowerCase();
  switch (traceGenericSourceClass(source)) {
    case "mission": return /\b(mission|missions|orchestrator|worker|validator|validation contract)\b/.test(f);
    case "archivist": return /\b(archivist|preserve|distill|documentation drift|obsidian|memory routing)\b/.test(f);
    case "skill": return /\b(skill|skills|agent skill|load skill)\b/.test(f);
    case "readme": return /\b(readme|overview|onboard|onboarding|project summary)\b/.test(f);
    default: return false;
  }
}

function traceDecisions(focus: string, candidates: ContextItem[], selected: ContextItem[], curateResult: CurateResult) {
  const selectedSources = new Set(selected.map((item) => item.source));
  const curatedRejected = new Map(curateResult.rejected.map((item) => [item.source, item.reason]));
  return candidates.slice(0, 60).map((candidate) => {
    const reasons: string[] = [];
    const generic = traceGenericSourceClass(candidate.source);
    if (generic) reasons.push(`generic_source:${generic}`);
    if (generic && !focusAllowsTraceGenericSource(candidate.source, focus)) reasons.push(`focus_does_not_allow_${generic}`);
    if (candidate.relevance < 0.25) reasons.push("low_relevance");
    const rejectedReason = curatedRejected.get(candidate.source);
    if (rejectedReason) reasons.push(`curator:${rejectedReason}`);
    const isSelected = selectedSources.has(candidate.source);
    const isSuppressed = !isSelected && Boolean(generic && !focusAllowsTraceGenericSource(candidate.source, focus));
    const decision = isSelected ? "selected" : isSuppressed ? "suppressed" : "rejected";
    if (!reasons.length) reasons.push(isSelected ? "selected_by_curator" : "not_selected_by_curator");
    return { source: candidate.source, finalRelevance: Number(candidate.relevance.toFixed(4)), decision, reasons };
  });
}

function traceFeedbackStats(evalsCount: number, qualitySummaryUsed: boolean, decisions: ReturnType<typeof traceDecisions>) {
  const penaltiesApplied = decisions.filter((d) => d.reasons.some((r) => r.startsWith("generic_source") || r.startsWith("focus_does_not_allow") || r === "low_relevance")).length;
  const boostsApplied = decisions.filter((d) => d.reasons.some((r) => /boost|missed/.test(r))).length;
  return { recentEvaluations: evalsCount, qualitySummaryUsed, penaltiesApplied, boostsApplied };
}

function recordDspyTrace(cwd: string, bundle: ContextBundle, indicators: SearchIndicators, candidates: ContextItem[], curateResult: CurateResult, feedback?: { recentEvaluations?: number; qualitySummaryUsed?: boolean; penaltiesApplied?: number; boostsApplied?: number }) {
  try {
    const decisions = traceDecisions(bundle.focus, candidates, bundle.items, curateResult);
    writeDspyTrace(cwd, {
      version: 1,
      at: new Date().toISOString(),
      bundleId: bundle.bundleId,
      focus: bundle.focus,
      mode: bundle.mode,
      sourcePlan: {
        sources: bundle.sourcePlan?.sources ?? [],
        reason: bundle.sourcePlan?.reason ?? "",
        confidence: bundle.sourcePlan?.confidence ?? 0,
        planner: bundle.sourcePlan?.planner ?? "unknown",
      },
      indicators: {
        indicators: indicators.indicators,
        reason: indicators.reason,
        confidence: indicators.confidence,
        planner: indicators.planner,
      },
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 60).map(traceItem),
      selected: bundle.items.map(traceItem),
      curate: {
        abstain: curateResult.abstain,
        abstainReason: curateResult.abstainReason,
        confidence: curateResult.confidence,
        planner: curateResult.planner,
        rejected: curateResult.rejected.slice(0, 60),
      },
      decisions,
      feedback: { ...traceFeedbackStats(0, false, decisions), ...(feedback ?? {}) },
      disposition: bundle.signal?.disposition.kind,
    });
  } catch { /* tracing must never affect retrieval */ }
}

function stashContextBundle(state: State, bundle: ContextBundle): void {
  state.lastBundleId = bundle.bundleId;
  stashBundle(state, {
    bundleId: bundle.bundleId,
    timestamp: Date.now(),
    focus: bundle.focus,
    mode: bundle.mode,
    items: bundle.items.map((item) => ({
      handle: item.handle,
      type: item.type,
      source: item.source,
      summary: item.summary,
      inline: item.inline,
    })),
  });
}

function fileSnippetAllowed(sourcePath: string, focus: string, mode: string) {
  if (mode !== "front-door") return true;
  const p = sourcePath.replace(/\\/g, "/").toLowerCase();
  const f = focus.toLowerCase();
  const wantsPi = /\b(pi|sherpa|agent|skill|theme|extension)\b/.test(f);
  const wantsEnv = /\b(env|environment|token|secret|config|configuration)\b/.test(f);
  if (!wantsPi && /(^|\/)\.pi\//.test(p)) return false;
  if (!wantsEnv && /(^|\/)\.env/.test(p)) return false;
  if (/implementation_summary\.md|backtest_results\.md|\.rsync-exclude|docker-compose|dockerfile/.test(p)) return false;
  return true;
}

async function rg(cwd: string, query: string | string[], searchPath = cwd) {
  const queryText = Array.isArray(query) ? query.join(" ") : query;
  const terms = queryText.match(/[A-Za-z0-9_./-]{4,}/g)?.slice(0, 6) ?? [];
  if (!terms.length) return "";
  const bundledRg = path.join(cwd, "bin", "rg");
  const rgBin = existsSync(bundledRg) ? bundledRg : "rg";
  try {
    const { stdout } = await execFileAsync(rgBin, ["-n", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--glob", "!.next", "--glob", "!dist", terms.join("|"), searchPath], { timeout: 3000, maxBuffer: 500_000 });
    return stdout;
  } catch (e: any) { return e.stdout ?? ""; }
}
async function gitChanged(cwd: string) {
  try { const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--short"], { timeout: 1500 }); return stdout; }
  catch { return ""; }
}

function webAllowed(state: State) {
  return Boolean(state.config.privacy.allowNetwork && state.config.sources.web && state.config.web?.enabled);
}

function webCachePath(cwd: string, query: string, provider: string) {
  const hash = createHash("sha256").update(`${provider}:${query.toLowerCase().trim()}`).digest("hex").slice(0, 24);
  return path.join(cwd, ".pi", "sherpa-cache", "web", `${hash}.json`);
}

function conciseWebQuery(focus: string) {
  return focus.replace(/[^\p{L}\p{N}\s._:/-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function surrealMemoryStore(state: State) {
  const cfg = state.config.memoryStore?.surreal;
  return cfg?.enabled ? new MemoryApiStore(cfg) : undefined;
}

async function requestQueryEmbedding(text: string): Promise<number[] | undefined> {
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (!apiKey || !text.trim()) return undefined;
  const baseUrl = process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: [text] }),
  }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const payload = await response.json().catch(() => undefined) as { data?: Array<{ embedding?: number[] }> } | undefined;
  return payload?.data?.[0]?.embedding?.map(Number);
}

function surrealArtifactIdFromSource(source: string): string | undefined {
  if (!source.startsWith("surreal://")) return undefined;
  return decodeURIComponent(source.slice("surreal://".length));
}

function associativeMemoryProbes(focus: string, indicators: SearchIndicators): string[] {
  const probes = [
    focus,
    indicators.indicators.join(" "),
    ...indicators.indicators.slice(0, 6),
    extractSearchTerms(focus, 8).join(" "),
  ].map((probe) => probe.replace(/\s+/g, " ").trim()).filter((probe) => probe.length >= 3);
  return [...new Set(probes)].slice(0, 8);
}

function inferSurrealMemoryTypes(focus: string): string[] | undefined {
  const f = focus.toLowerCase();
  const types = new Set<string>();
  if (/\b(claim|fact|assertion|invariant|truth)\b/.test(f)) types.add("claim");
  if (/\b(procedure|workflow|runbook|how\s+to|steps|process)\b/.test(f)) types.add("procedure");
  if (/\b(decision|rationale|adr|tradeoff)\b/.test(f)) types.add("decision");
  if (/\b(evidence|commit|source|proof|why)\b/.test(f)) types.add("evidence");
  if (/\b(file|path|module|component|implementation|code)\b/.test(f)) types.add("source-file");
  if (/\b(entity|symbol|concept|term|alias)\b/.test(f)) types.add("entity");
  return types.size ? [...types] : undefined;
}

function inferSurrealResearchArea(focus: string): string | undefined {
  const f = focus.toLowerCase();
  if (/\b(sage|graphrag|rag|agent\s+memory|memory\s+engine|paper|arxiv|research|llm|ai)\b/.test(f)) return "ai";
  return undefined;
}

function shouldSearchTranscendentalMemory(focus: string): boolean {
  return /\b(transcendental|cross-project|global\s+memory|universal|principle|doctrine|meta-memory|wisdom)\b/i.test(focus);
}

async function searchSurrealAssociativeMemory(state: State, focus: string, indicators: SearchIndicators, project: string): Promise<MemoryResult[]> {
  const store = surrealMemoryStore(state);
  if (!store) return [];
  const merged = new Map<string, MemoryResult>();
  const probes = associativeMemoryProbes(focus, indicators);
  const types = inferSurrealMemoryTypes(focus);
  const area = inferSurrealResearchArea(focus);
  const includeTranscendental = shouldSearchTranscendentalMemory(focus);
  const constrainedLimit = Math.max(1, Math.min(30, state.config.surrealMemory?.constrainedLimit ?? DEFAULT_CONFIG.surrealMemory.constrainedLimit));
  const broadFallbackLimit = Math.max(0, Math.min(20, state.config.surrealMemory?.broadFallbackLimit ?? DEFAULT_CONFIG.surrealMemory.broadFallbackLimit));
  const queryEmbedding = await requestQueryEmbedding(focus);
  for (const [index, probe] of probes.entries()) {
    const embedding = index === 0 ? queryEmbedding : undefined;
    const projectConstrained = await store.search({ text: probe, project, types, embedding, limit: constrainedLimit }).catch(() => []);
    const projectBroad = types && broadFallbackLimit ? await store.search({ text: probe, project, embedding, limit: broadFallbackLimit }).catch(() => []) : [];
    const research = area ? await store.search({ text: probe, area, types, embedding, limit: Math.max(3, Math.floor(constrainedLimit / 2)) }).catch(() => []) : [];
    const broadResearch = area && broadFallbackLimit ? await store.search({ text: probe, area, embedding, limit: broadFallbackLimit }).catch(() => []) : [];
    const transcendental = includeTranscendental ? await store.search({ text: probe, scope: "transcendental", types, embedding, limit: Math.max(3, Math.floor(constrainedLimit / 2)) }).catch(() => []) : [];
    const results = [...projectConstrained, ...projectBroad, ...research, ...broadResearch, ...transcendental];
    for (const result of results) {
      const existing = merged.get(result.artifact.id);
      const scoreBoost = index === 0 ? 0.08 : 0.03;
      const scored = { ...result, score: Math.min(1, result.score + scoreBoost), reason: `${result.reason}; associative probe: ${probe}` };
      if (!existing || scored.score > existing.score) merged.set(result.artifact.id, scored);
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

async function recordSurrealRetrievalFeedback(state: State, bundle: ContextBundleRecord, evalRecord: { noise: string[]; missed: string[]; scores: { relevance: number }; reflection?: string }) {
  const store = surrealMemoryStore(state);
  if (!store) return;
  const selectedIds = (bundle.items ?? []).map((item) => surrealArtifactIdFromSource(item.source)).filter((id): id is string => Boolean(id));
  if (!selectedIds.length && !evalRecord.missed.length) return;
  const unusedIds = (bundle.items ?? [])
    .filter((item) => evalRecord.noise.includes(item.source))
    .map((item) => surrealArtifactIdFromSource(item.source))
    .filter((id): id is string => Boolean(id));
  const usedIds = selectedIds.filter((id) => !unusedIds.includes(id));
  await store.recordFeedback({
    query: bundle.focus,
    selectedIds,
    usedIds,
    unusedIds,
    missing: evalRecord.missed,
    outcome: evalRecord.scores.relevance >= 0.7 ? "helpful" : evalRecord.scores.relevance >= 0.35 ? "partial" : "unhelpful",
    notes: evalRecord.reflection,
    createdAt: new Date().toISOString(),
  }).catch(() => undefined);
}

function graphifyGraphPath(cwd: string, cfg: SherpaConfig["graphify"]) {
  const configured = cfg.graphPath || DEFAULT_CONFIG.graphify.graphPath;
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

function graphifyAllowedForQuery(focus: string) {
  return /\b(architecture|architectural|topology|graph|call path|calls?|dependencies|dependency|relationship|relationships|connects?|connected|subsystem|boundary|boundaries|community|communities|flow|pipeline|how\s+.+\s+fits|how\s+.+\s+connects)\b/i.test(focus);
}

async function searchGraphify(cwd: string, focus: string, cfg: SherpaConfig["graphify"]): Promise<string> {
  if (!cfg?.enabled || !focus.trim()) return "";
  const graph = graphifyGraphPath(cwd, cfg);
  if (!existsSync(graph)) return "";
  const timeout = Math.max(300, Math.min(10_000, Math.floor(cfg.timeoutMs || 1200)));
  const budget = String(Math.max(300, Math.min(5000, Math.floor(cfg.budgetTokens || 1200))));
  try {
    const { stdout } = await execFileAsync(
      cfg.command || "graphify",
      ["query", focus, "--graph", graph, "--budget", budget],
      { cwd, timeout, maxBuffer: 300_000 },
    );
    const lines = stdout.split("\n").map(line => line.trim()).filter(Boolean).slice(0, Math.max(3, Math.min(80, cfg.maxLines || 24)));
    if (!lines.length) return "";
    return [
      "Graphify topology/routing hints. Use these as candidate nodes/files/functions; retrieve concrete code snippets with Semble or exact file reads before editing.",
      `Graph: ${path.relative(cwd, graph) || graph}`,
      "",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}

async function searchWeb(state: State, ctx: ExtensionContext, focus: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  if (!webAllowed(state)) return [];
  const provider = state.config.web.provider || "brave";
  const apiKey = process.env[state.config.web.apiKeyEnv || "BRAVE_SEARCH_API_KEY"];
  if (!apiKey) return [];

  const query = conciseWebQuery(focus);
  if (!query) return [];
  const maxResults = Math.max(1, Math.min(10, state.config.web.maxResults ?? 5));
  const timeoutMs = Math.max(1000, Math.min(10000, state.config.web.timeoutMs ?? 5000));
  const cachePath = webCachePath(ctx.cwd, query, provider);
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (Date.now() - cached.at < (state.config.web.cacheTtlMs ?? DEFAULT_CONFIG.web.cacheTtlMs)) return cached.results ?? [];
    }
  } catch { /* ignore cache */ }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let results: Array<{ title: string; url: string; snippet: string }> = [];
    if (provider === "brave") {
      const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(maxResults), text_decorations: "false" })}`;
      const res = await fetch(url, { headers: { "Accept": "application/json", "X-Subscription-Token": apiKey }, signal: abort.signal });
      if (!res.ok) return [];
      const json: any = await res.json();
      results = (json.web?.results ?? []).slice(0, maxResults).map((r: any) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.description ?? "" })).filter((r: any) => r.url);
    }
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ at: Date.now(), provider, query, results }, null, 2));
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function buildBundle(state: State, ctx: ExtensionContext, focus: string, mode: string, tokenBudget: number, sourcePlan: SourcePlan, indicators: SearchIndicators, options: { searchOtherProjects?: boolean; includeTaxonomy?: boolean } = {}): Promise<ContextBundle> {
  const enabled = (s: Source) => Boolean(state.config.sources[s]) && (!sourcePlan || sourcePlan.sources.includes(s));
  const candidates: ContextItem[] = [];
  const add = (type: string, source: string, raw: string, relBoost = 0) => {
    if (!raw.trim()) return;
    const handle = `ctx-${state.nextHandle++}`;
    // Precision rule: small content → inline; large → pointer to handle
    const inline = raw.length <= 900 && !type.includes("session");
    const summary = summarize(raw);
    const pointer = inline ? "" : ` (expand with /sherpa:expand ${handle})`;
    const item: ContextItem = { handle, type, source, relevance: Math.min(1, score(raw + " " + source, focus) + relBoost), summary: summary + pointer, raw, inline };
    state.handles.set(handle, item); candidates.push(item);
  };

  const urls = state.config.dedupe?.urls?.enabled ? extractUrls(focus) : (focus.match(/https?:\/\/\S+/g) ?? []);
  for (const url of urls) {
    add(
      "url_reference",
      url,
      state.config.privacy.allowNetwork || state.config.sources.web
        ? `User provided URL: ${url}. Sherpa did not fetch it yet; the main agent should fetch/read it with an approved web tool if needed.`
        : `User provided URL: ${url}. Network/web retrieval is disabled in Sherpa privacy settings, so this is passed through as an explicit reference for the main agent.`,
      0.9,
    );
  }

  const retrievalTasks: Promise<void>[] = [];

  if (enabled("files")) retrievalTasks.push((async () => {
    for (const p of explicitPathCandidates(focus, ctx.cwd)) {
      const exact = readExplicitSource(p);
      if (exact) add("file_exact", pathSourceLabel(p, ctx.cwd), exact.raw, exact.boost);
    }

    const routeRead = sourcePlan?.routePlan?.read ?? [];
    for (const rel of routeRead) {
      if (routeSkipsPath(sourcePlan?.routePlan, rel)) continue;
      const p = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);
      try {
        if (existsSync(p) && statSync(p).isFile()) {
          add("file_snippet", `repo://${rel}`, readFileSync(p, "utf8").slice(0, 1200), 0.35);
        } else if (existsSync(p) && statSync(p).isDirectory()) {
          const routedOut = await rg(ctx.cwd, focus, p);
          for (const block of routedOut.split("\n").slice(0, 12)) {
            if (!block.trim()) continue;
            const firstColon = block.indexOf(":");
            const secondColon = firstColon >= 0 ? block.indexOf(":", firstColon + 1) : -1;
            if (firstColon === -1 || secondColon === -1) continue;
            const fileAndLine = block.slice(0, secondColon);
            const content = block.slice(secondColon + 1).trim();
            if (content && !routeSkipsPath(sourcePlan?.routePlan, fileAndLine)) add("file_snippet", `repo://${fileAndLine}`, content, 0.3);
          }
        }
      } catch { /* ignore route file */ }
    }
    // Stage 2: search using model-inferred indicators, not raw focus text
    const out = await rg(ctx.cwd, indicators.indicators);
    for (const block of out.split("\n").slice(0, 30)) {
      if (!block.trim()) continue;
      // rg format: file:line:content. Split on the first two separators only so
      // content containing URLs/JSON colons remains intact.
      const firstColon = block.indexOf(":");
      const secondColon = firstColon >= 0 ? block.indexOf(":", firstColon + 1) : -1;
      if (firstColon === -1 || secondColon === -1) continue;
      const fileAndLine = block.slice(0, secondColon);
      const content = block.slice(secondColon + 1).trim();
      if (!content || routeSkipsPath(sourcePlan?.routePlan, fileAndLine) || !fileSnippetAllowed(fileAndLine, indicators.indicators.join(" "), mode)) continue;
      add("file_snippet", `repo://${fileAndLine}`, content, 0.15);
    }
  })());

  if (enabled("semble") && state.config.semble?.enabled) retrievalTasks.push((async () => {
    const query = [focus, ...indicators.indicators].join(" ").trim();
    const results = await searchSemble(ctx.cwd, query, state.config.semble);
    for (const result of results) {
      if (routeSkipsPath(sourcePlan?.routePlan, result.filePath) || !fileSnippetAllowed(result.filePath, indicators.indicators.join(" "), mode)) continue;
      add(
        "semantic_code_snippet",
        `repo://${result.filePath}:${result.startLine}`,
        result.content,
        0.4,
      );
    }
  })());

  if (enabled("graphify") && state.config.graphify?.enabled && graphifyAllowedForQuery(focus)) retrievalTasks.push((async () => {
    const raw = await searchGraphify(ctx.cwd, focus, state.config.graphify);
    if (raw) add("graphify_code_graph", `graphify://${path.relative(ctx.cwd, graphifyGraphPath(ctx.cwd, state.config.graphify)) || state.config.graphify.graphPath}`, raw, 0.32);
  })());

  if (enabled("docs")) retrievalTasks.push(Promise.resolve().then(() => {
    // AGENTS.md/CLAUDE.md are already discovered and injected by Pi's main
    // context-file loader. Sherpa should not duplicate them in front-door or
    // explicit retrieval bundles; it focuses on project docs and source-grounded
    // snippets that are not already preloaded.
    // Stage 2: doc paths filtered by inferred indicators, not raw focus
    const docFiles = getDocFilesForFocus(ctx.cwd, indicators.indicators.join(" "), mode, sourcePlan?.routePlan);
    for (const f of docFiles) {
      const p = path.join(ctx.cwd, f);
      if (existsSync(p)) add("doc_snippet", `repo://${f}`, readFileSync(p, "utf8").slice(0, 4000), 0.1);
    }
  }));

  if (enabled("git")) retrievalTasks.push((async () => {
    add("git_status", "git://status", await gitChanged(ctx.cwd), 0.05);
  })());

  if (enabled("web")) retrievalTasks.push((async () => {
    const results = await searchWeb(state, ctx, focus);
    for (const r of results) add("web_snippet", r.url, `${r.title}\n${r.snippet}`, 0.25);
  })());

  if (enabled("surreal_memory")) retrievalTasks.push((async () => {
    const store = surrealMemoryStore(state);
    if (!store) return;
    const results = await searchSurrealAssociativeMemory(state, focus, indicators, path.basename(ctx.cwd));
    for (const result of results) {
      const evidenceDepth = Math.max(1, Math.min(3, state.config.surrealMemory?.evidenceDepth ?? DEFAULT_CONFIG.surrealMemory.evidenceDepth));
      const evidenceChain = result.evidenceChain?.length ? result.evidenceChain : await store.retrieveEvidenceChain(result.artifact.id, { depth: evidenceDepth, limit: 10 }).catch(() => []);
      const chainWeight = Math.max(0, ...evidenceChain.map((step) => Number(step.summary?.match(/weight=([0-9.]+)/)?.[1] ?? 0)));
      const chain = evidenceChain.length
        ? `\n\nEvidence chain:\n${evidenceChain.map((step) => `- ${step.from} -[${step.relation}]-> ${step.to}${step.summary ? ` (${step.summary})` : ""}`).join("\n")}`
        : "";
      const raw = [
        `Scope: ${result.artifact.scope}`,
        result.artifact.project ? `Project: ${result.artifact.project}` : "",
        result.artifact.area ? `Area: ${result.artifact.area}` : "",
        `Type: ${result.artifact.type}`,
        `Title: ${result.artifact.title}`,
        result.artifact.summary ? `Summary: ${result.artifact.summary}` : "",
        result.artifact.sourcePath ? `Source: ${result.artifact.sourcePath}` : "",
        "",
        result.artifact.text ?? "",
        chain,
      ].filter(Boolean).join("\n");
      const chainWeightBoost = Math.max(0, Math.min(1, state.config.surrealMemory?.chainWeightBoost ?? DEFAULT_CONFIG.surrealMemory.chainWeightBoost));
      add("surreal_memory", `surreal://${result.artifact.id}`, raw, Math.max(0.28, result.score + (chainWeight * chainWeightBoost)));
    }
  })());

  if (enabled("project_memory")) retrievalTasks.push((async () => {
    // Obsidian memory uses catalog.csv as the first-class retrieval surface.
    // Results are organized by scope: current project first, then research.
    // Other projects are searched only when explicitly requested.
    const root = obsidianMemoryPath(state);
    const currentProjectMatches = catalogMatches(root, indicators.indicators.join(" "), 8);

    for (const { row, relevance } of currentProjectMatches) {
      const target = path.join(root, row.path);
      if (!existsSync(target)) continue;
      const raw = readFileSync(target, "utf8").slice(0, 3000);
      add("project_memory", `kb://current-project/${row.path}`, [`Scope: current project`, `Catalog: ${path.join(root, "catalog.csv")}`, "", raw].join("\n"), Math.max(0.25, relevance));
    }

    const vault = obsidianVaultPath(state);
    const researchBase = path.join(vault, "research");
    if (existsSync(researchBase)) {
      for (const area of readdirSync(researchBase).slice(0, 80)) {
        const areaRoot = path.join(researchBase, area);
        try {
          if (!statSync(areaRoot).isDirectory()) continue;
          for (const { row, relevance } of catalogMatches(areaRoot, indicators.indicators.join(" "), 5)) {
            const target = path.join(areaRoot, row.path);
            if (!existsSync(target)) continue;
            const raw = readFileSync(target, "utf8").slice(0, 2600);
            add("research_memory", `kb://research/${area}/${row.path}`, [`Scope: research`, `Area: ${area}`, `Catalog: ${path.join(areaRoot, "catalog.csv")}`, "", raw].join("\n"), Math.max(0.22, relevance));
          }
        } catch { /* ignore research area */ }
      }
    }

    if (options.searchOtherProjects) {
      const projectsBase = path.join(vault, "projects");
      const currentRoot = path.resolve(root);
      if (existsSync(projectsBase)) {
        for (const project of readdirSync(projectsBase).slice(0, 120)) {
          const projectRoot = path.join(projectsBase, project);
          try {
            if (!statSync(projectRoot).isDirectory() || path.resolve(projectRoot) === currentRoot) continue;
            for (const { row, relevance } of catalogMatches(projectRoot, indicators.indicators.join(" "), 4)) {
              const target = path.join(projectRoot, row.path);
              if (!existsSync(target)) continue;
              const raw = readFileSync(target, "utf8").slice(0, 2200);
              add("other_project_memory", `kb://project/${project}/${row.path}`, [`Scope: other project`, `Project: ${project}`, `Catalog: ${path.join(projectRoot, "catalog.csv")}`, "", raw].join("\n"), Math.max(0.18, relevance));
            }
          } catch { /* ignore project */ }
        }
      }
    }

    const wantsTaxonomy = options.includeTaxonomy || /\b(taxonomy|tag|tags|label|labels|category|relationship|nomenclature)\b/i.test(focus);
    if (wantsTaxonomy) {
      const taxonomy = readGlobalTaxonomy();
      const taxonomyMatches = taxonomy
        .map((row) => ({ row, relevance: score([
          row.kind, row.id, row.label, row.description, row.aliases, row.parent,
          row.examples, row.notes,
        ].filter(Boolean).join("\n"), focus) }))
        .filter((item) => item.relevance > 0.08)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 10);
      if (taxonomyMatches.length) {
        add("taxonomy", "taxonomy:///Users/kamil/Documents/articles/taxonomy.csv", [
          "# Global Knowledge Taxonomy Matches",
          "Source: /Users/kamil/Documents/articles/taxonomy.csv",
          "",
          ...taxonomyMatches.map(({ row }) => [
            `## ${row.kind}:${row.id} — ${row.label ?? ""}`,
            row.description ? `Description: ${row.description}` : "",
            row.aliases ? `Aliases: ${row.aliases}` : "",
            row.examples ? `Examples: ${row.examples}` : "",
            row.notes ? `Notes: ${row.notes}` : "",
          ].filter(Boolean).join("\n")),
        ].join("\n\n"), 0.16);
      }
    }

    // If current project catalog is absent or did not match, fall back to current
    // project's semantic ontology folders only. Do not scan legacy bucket folders.
    if (currentProjectMatches.length) return;
    const roots = [
      path.join(root, "wiki", "systems"),
      path.join(root, "wiki", "procedures"),
      path.join(root, "wiki", "decisions"),
      path.join(root, "wiki", "concepts"),
      path.join(root, "wiki", "evidence"),
      path.join(root, "journal"),
      path.join(root, "inbox"),
    ];
    for (const dir of roots) {
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir).filter((n: string) => n.endsWith(".md")).slice(0, 8)) {
          const raw = readFileSync(path.join(dir, f), "utf8").slice(0, 2000);
          if (score(raw, focus) > 0.1) add("project_memory", `kb://${path.relative(root, path.join(dir, f))}`, raw, 0.2);
        }
      } catch { /* ignore */ }
    }
  })());

  if (enabled("session")) retrievalTasks.push(Promise.resolve().then(() => {
    const recent = ctx.sessionManager.getEntries().slice(-25).map((e: any) => JSON.stringify(e).slice(0, 500)).join("\n");
    add("session_recent", "session://recent", recent, 0.05);
  }));

  if (enabled("project_memory")) retrievalTasks.push(Promise.resolve().then(() => {
    try {
      const memoryConfig = {
        scratchpadRoot: scratchpadRootPath(state, ctx.cwd),
        catalogRoots: [ctx.cwd, obsidianMemoryPath(state)],
        evaluationRoot: obsidianMemoryPath(state),
      };
      indexSherpaMemory(ctx.cwd, memoryConfig);
      const memoryHits = searchSherpaMemory(ctx.cwd, [focus, ...indicators.indicators].join(" "), 8, memoryConfig);
      for (const hit of memoryHits) {
        add(
          "memory_index",
          `memory-index://${hit.kind}/${path.relative(ctx.cwd, hit.sourcePath)}`,
          [
            `Kind: ${hit.kind}`,
            `Title: ${hit.title}`,
            hit.summary ? `Summary: ${hit.summary}` : "",
            `Source: ${hit.sourcePath}`,
            "",
            hit.snippet || hit.summary,
          ].filter(Boolean).join("\n"),
          0.24,
        );
      }
    } catch { /* memory index recall is opportunistic */ }
  }));

  await Promise.allSettled(retrievalTasks);

  // Active retry: if first-pass retrieval only produced generic/uncurated context,
  // try Semble first (the default code-search path), then one bounded raw-query
  // grep fallback. This gives Stage 3 better candidates without flooding the session.
  if (mode === "front-door" && enabled("files") && postProcessCandidates(candidates, focus, mode).length === 0) {
    if (enabled("semble") && state.config.semble?.enabled) {
      const retrySemble = await searchSemble(ctx.cwd, focus, state.config.semble);
      for (const result of retrySemble.slice(0, 8)) {
        if (routeSkipsPath(sourcePlan?.routePlan, result.filePath) || !fileSnippetAllowed(result.filePath, focus, mode)) continue;
        add("semantic_code_snippet", `repo://${result.filePath}:${result.startLine}`, result.content, 0.35);
      }
    }
    const retryOut = postProcessCandidates(candidates, focus, mode).length ? "" : await rg(ctx.cwd, focus);
    for (const block of retryOut.split("\n").slice(0, 16)) {
      if (!block.trim()) continue;
      const firstColon = block.indexOf(":");
      const secondColon = firstColon >= 0 ? block.indexOf(":", firstColon + 1) : -1;
      if (firstColon === -1 || secondColon === -1) continue;
      const fileAndLine = block.slice(0, secondColon);
      const content = block.slice(secondColon + 1).trim();
      if (!content || routeSkipsPath(sourcePlan?.routePlan, fileAndLine) || !fileSnippetAllowed(fileAndLine, focus, mode)) continue;
      add("file_snippet", `repo://${fileAndLine}`, content, 0.08);
    }
  }

  // Closed-loop feedback: recent post-task evaluations penalize sources that were
  // repeatedly noise and boost exact filenames that were previously missed.
  let traceFeedback: { recentEvaluations?: number; qualitySummaryUsed?: boolean } = {};
  try {
    const memoryRoot = obsidianMemoryPath(state);
    const recentEvaluations = readRecentEvaluations(memoryRoot, 200);
    const qualitySummary = readQualitySummary(memoryRoot);
    traceFeedback = { recentEvaluations: recentEvaluations.length, qualitySummaryUsed: Boolean(qualitySummary) };
    const adjusted = applyEvaluationFeedbackToCandidates(candidates, recentEvaluations, qualitySummary, { focus });
    candidates.splice(0, candidates.length, ...adjusted);
  } catch { /* feedback must never affect retrieval availability */ }

// Stage 3: model judges candidates with hard suppression gate.
  const curateResult = await curateCandidates(state, ctx, candidates, focus, mode, indicators);

  // HARD GATE: if Stage 3 suppressed everything, return empty bundle (triggers abstain)
  if (curateResult.abstain) {
    state.bundles++;
    const abstainBundle: ContextBundle = {
      bundleId: createBundleId(),
      taskId: `sherpa-${Date.now()}`,
      focus,
      mode,
      budgetUsedTokens: 0,
      items: [],
      candidateCount: candidates.length,
      sourcePlan,
    };
    abstainBundle.signal = buildContextSignal(abstainBundle);
    recordDspyTrace(ctx.cwd, abstainBundle, indicators, candidates, curateResult, traceFeedback);
    stashContextBundle(state, abstainBundle);
    return abstainBundle;
  }

  const items: ContextItem[] = []; let used = 0;
  const finalItems = postProcessCandidates(curateResult.items, focus, mode);
  if (mode === "front-door" && finalItems.length === 0) {
    state.bundles++;
    const abstainBundle: ContextBundle = {
      bundleId: createBundleId(),
      taskId: `sherpa-${Date.now()}`,
      focus,
      mode,
      budgetUsedTokens: 0,
      items: [],
      candidateCount: candidates.length,
      sourcePlan,
    };
    abstainBundle.signal = buildContextSignal(abstainBundle);
    recordDspyTrace(ctx.cwd, abstainBundle, indicators, candidates, { ...curateResult, abstain: true, abstainReason: "post-curation suppression removed all selected candidates" }, traceFeedback);
    stashContextBundle(state, abstainBundle);
    return abstainBundle;
  }
  for (const c of finalItems) {
    const t = approxTokens(c.summary) + 30;
    if (used + t <= tokenBudget) { items.push(c); used += t; }
    if (items.length >= 8) break;
  }
  state.bundles++;
  const bundle: ContextBundle = { bundleId: createBundleId(), taskId: `sherpa-${Date.now()}`, focus, mode, budgetUsedTokens: used, items, candidateCount: candidates.length, sourcePlan };
  bundle.signal = buildContextSignal(bundle);
  recordDspyTrace(ctx.cwd, bundle, indicators, candidates, curateResult, traceFeedback);
  stashContextBundle(state, bundle);
  return bundle;
}

type PersistedSherpaState = Partial<Pick<State, "nextHandle" | "bundles" | "feedback" | "automation" | "lifecycleHashes" | "lastBundleId" | "dspyAuto">> & {
  bundleRecords?: ContextBundleRecord[];
  config?: SherpaConfig;
};

function createState(ctx: ExtensionContext, config: SherpaConfig): State {
  const retrievalPrompt = loadPromptKind(ctx.cwd, "retrieval", config);
  const distillPrompt = loadPromptKind(ctx.cwd, "distillation", config);
  const documentationPrompt = loadPromptKind(ctx.cwd, "documentation", config);
  const automationPrompt = loadPromptKind(ctx.cwd, "automation", config);
  return {
    config,
    handles: new Map(),
    nextHandle: 1,
    bundles: 0,
    lastSkip: "none",
    turnCount: 0,
    lastProactiveTurn: -999,
    feedback: [],
    bundleRecords: new Map(),
    dspyAuto: { lastBundleCount: 0 },
    automation: createAutomationState(),
    lifecycleHashes: [],
    systemPrompt: retrievalPrompt.prompt,
    systemPromptSource: retrievalPrompt.source,
    retrievalPrompt: retrievalPrompt.prompt,
    retrievalPromptSource: retrievalPrompt.source,
    distillPrompt: distillPrompt.prompt,
    distillPromptSource: distillPrompt.source,
    documentationPrompt: documentationPrompt.prompt,
    documentationPromptSource: documentationPrompt.source,
    automationPrompt: automationPrompt.prompt,
    automationPromptSource: automationPrompt.source,
  };
}

function restoreBundleRecords(records: unknown): Map<string, ContextBundleRecord> {
  const map = new Map<string, ContextBundleRecord>();
  if (!Array.isArray(records)) return map;
  for (const record of records.slice(-20)) {
    if (record?.bundleId && Array.isArray(record.items)) map.set(record.bundleId, record as ContextBundleRecord);
  }
  return map;
}

function applyPersistedState(state: State, data: PersistedSherpaState): void {
  state.nextHandle = Math.max(state.nextHandle, data.nextHandle ?? 1);
  state.bundles = data.bundles ?? state.bundles;
  state.feedback = data.feedback ?? state.feedback;
  state.automation = { ...state.automation, ...(data.automation ?? {}) };
  state.lifecycleHashes = Array.isArray(data.lifecycleHashes) ? data.lifecycleHashes : state.lifecycleHashes;
  state.lastBundleId = data.lastBundleId ?? state.lastBundleId;
  state.dspyAuto = { ...state.dspyAuto, ...(data.dspyAuto ?? {}) };
  state.bundleRecords = restoreBundleRecords(data.bundleRecords);
}

function serializeState(state: State): PersistedSherpaState {
  return {
    nextHandle: state.nextHandle,
    bundles: state.bundles,
    feedback: state.feedback,
    automation: state.automation,
    lifecycleHashes: state.lifecycleHashes,
    lastBundleId: state.lastBundleId,
    dspyAuto: state.dspyAuto,
    bundleRecords: [...state.bundleRecords.values()],
    config: state.config,
  };
}

function restoreState(ctx: ExtensionContext, config: SherpaConfig): State {
  const state = createState(ctx, config);
  for (const e of ctx.sessionManager.getEntries() as any[]) {
    if (e.type === "custom" && e.customType === "ai-sherpa-state" && e.data) applyPersistedState(state, e.data);
  }
  return state;
}

function isDocumentationPath(file: string) {
  const p = file.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(readme|changelog|contributing|architecture|design|adr|prd)(\.|$)/.test(p)
    || /(^|\/)(docs?|documentation|adr|adrs)\//.test(p)
    || /\.(md|mdx|rst|adoc|txt)$/.test(p);
}

function isSourcePath(file: string) {
  const p = file.replace(/\\/g, "/").toLowerCase();
  if (isDocumentationPath(p)) return false;
  if (/(^|\/)(node_modules|dist|build|coverage|\.git|\.pi-memory|extensions\/pi-sherpa\/memory)\//.test(p)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|php|rb|sql|json|ya?ml|toml)$/.test(p);
}

function parseGitStatusFiles(status: string) {
  const files: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const file = raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw;
    if (file) files.push(file);
  }
  return files;
}

function parseToolArguments(args: unknown): any {
  if (!args) return {};
  if (typeof args === "string") {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return typeof args === "object" ? args : {};
}

function normalizeRepoToolPath(rawPath: unknown, cwd: string): string | undefined {
  if (typeof rawPath !== "string" || !rawPath) return undefined;
  const cleaned = rawPath.replace(/^@/, "");
  const absolute = path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned);
  const relative = path.relative(cwd, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}

function collectRecentTaskFileEvidence(messages: any[] | undefined, cwd: string) {
  const readFiles = new Set<string>();
  const writtenFiles = new Set<string>();
  for (const msg of messages ?? []) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall") continue;
      const args = parseToolArguments(block.arguments);
      const rel = normalizeRepoToolPath(args?.path, cwd);
      if (!rel) continue;
      if (["write", "edit"].includes(block.name)) writtenFiles.add(rel);
      if (block.name === "read") readFiles.add(rel);
    }
  }
  return { readFiles: [...readFiles], writtenFiles: [...writtenFiles] };
}

function extractMentionedRepoFiles(text: string, cwd: string) {
  const files = new Set<string>();
  const candidates = text.match(/(?:^|[\s`'"(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?=$|[\s`'"),.:;])/g) ?? [];
  for (const raw of candidates) {
    const rel = raw.trim().replace(/^[`'"(]+|[`'"),.:;]+$/g, "");
    if (!rel || rel.includes("://") || rel.startsWith("..")) continue;
    const p = path.join(cwd, rel);
    if (existsSync(p)) files.add(rel.replace(/\\/g, "/"));
  }
  return [...files];
}

function recentTurnWrittenFiles(messages: any[] | undefined, cwd: string) {
  return collectRecentTaskFileEvidence(messages, cwd).writtenFiles;
}

function docSearchTerms(files: string[]) {
  const terms = new Set<string>();
  for (const file of files) {
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    const parent = path.basename(path.dirname(file));
    for (const t of [base, parent]) {
      const cleaned = t.replace(/[^A-Za-z0-9_-]/g, "");
      if (cleaned.length >= 4) terms.add(cleaned);
    }
  }
  return [...terms].slice(0, 8);
}

function findDocumentationCandidates(cwd: string, changedSourceFiles: string[]) {
  const terms = docSearchTerms(changedSourceFiles);
  const candidates: string[] = [];
  const roots = ["README.md", "docs"];
  const visit = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).slice(0, 80)) visit(path.join(p, name));
      return;
    }
    const rel = path.relative(cwd, p);
    if (!isDocumentationPath(rel)) return;
    try {
      const raw = readFileSync(p, "utf8").toLowerCase();
      if (!terms.length || terms.some(t => raw.includes(t.toLowerCase()))) candidates.push(rel);
    } catch { /* ignore unreadable docs */ }
  };
  for (const root of roots) visit(path.join(cwd, root));
  return [...new Set(candidates)].slice(0, 8);
}

export default function (pi: ExtensionAPI) {
  let state: State | undefined;
  const persist = () => state && pi.appendEntry("ai-sherpa-state", serializeState(state));
  const statusLabel = (text: string) => {
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length > 44 ? `${singleLine.slice(0, 41)}...` : singleLine;
  };
  const setSherpaStatus = (ctx: ExtensionContext, action?: string, subject?: string) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(SHERPA_LEGACY_UI_KEY, undefined);
    if (action) {
      ctx.ui.setStatus(SHERPA_UI_KEY, `🤵 ${action}${subject ? `: ${statusLabel(subject)}` : ""}`);
      return;
    }
    ctx.ui.setStatus(SHERPA_UI_KEY, state?.config.enabled ? `Sherpa: ${state.config.mode}` : "Sherpa: off");
  };

  const compileDspyCandidate = async (ctx: ExtensionContext, reason: string, notify: boolean, options: { force?: boolean } = {}) => {
    if (!state?.config.dspy.autoCompile.enabled && !options.force) return { ran: false, reason: "auto compile disabled" };
    const limit = 2000;
    const evals = readRecentEvaluations(obsidianMemoryPath(state), limit);
    const exported = exportDspyDataset(ctx.cwd, evals, { limit });
    if (exported.traces < state.config.dspy.autoCompile.minTraces) return { ran: false, reason: `need ${state.config.dspy.autoCompile.minTraces} traces; have ${exported.traces}` };
    if (!options.force) {
      if (exported.matchedEvaluations < DSPY_COMPILE_MIN_EVALUATIONS) return { ran: false, reason: `need ${DSPY_COMPILE_MIN_EVALUATIONS} matched evaluations; have ${exported.matchedEvaluations}` };
      if (exported.averageMetric < DSPY_COMPILE_MIN_AVG_METRIC) return { ran: false, reason: `average metric ${exported.averageMetric.toFixed(2)} below ${DSPY_COMPILE_MIN_AVG_METRIC}` };
      if (exported.highScoringExamples < DSPY_COMPILE_MIN_HIGH_EXAMPLES) return { ran: false, reason: `need ${DSPY_COMPILE_MIN_HIGH_EXAMPLES} high-scoring examples; have ${exported.highScoringExamples}` };
    }
    const scriptPath = path.join(path.dirname(__filename), "scripts", "optimize-sherpa-dspy.py");
    const projectPrompt = path.join(ctx.cwd, ".pi", "sherpa", "prompts", "RETRIEVAL.md");
    const basePrompt = existsSync(projectPrompt) ? projectPrompt : path.join(path.dirname(__filename), "prompts", "RETRIEVAL.md");
    const candidateDir = path.join(".pi", "sherpa", "compiled-candidates");
    const { stdout } = await execFileAsync("python3", [scriptPath, "--base-prompt", basePrompt, "--out-dir", candidateDir], { cwd: ctx.cwd, timeout: 120_000, maxBuffer: 1_000_000 });
    state.dspyAuto = { lastCompileAt: new Date().toISOString(), lastCompileDate: todayIsoDate(), lastBundleCount: state.bundles };
    persist();
    if (notify) ctx.ui.notify([`Sherpa DSPy-style prompt-feedback candidate compiled (${reason})`, `traces=${exported.traces}; matched=${exported.matchedEvaluations}; avgMetric=${exported.averageMetric.toFixed(2)}; high=${exported.highScoringExamples}`, `train=${exported.train}; dev=${exported.dev}`, stdout.trim()].filter(Boolean).join("\n"), "info");
    return { ran: true, reason, exported };
  };

  const maybeAutoCompileDspy = async (ctx: ExtensionContext, event: "bundle" | "evaluate" | "session_shutdown") => {
    if (!state?.config.dspy.autoCompile.enabled) return;
    const cfg = state.config.dspy.autoCompile;
    if (event === "evaluate" && !cfg.onEvaluate) return;
    if (event === "session_shutdown" && !cfg.onSessionShutdown) return;
    if (event === "bundle" && state.bundles - state.dspyAuto.lastBundleCount < cfg.bundleInterval) return;
    if (cfg.maxOncePerDay && event !== "evaluate" && state.dspyAuto.lastCompileDate === todayIsoDate()) return;
    try { await compileDspyCandidate(ctx, event, event !== "bundle"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (event !== "bundle") ctx.ui.notify(`Sherpa DSPy auto-compile failed: ${message}`, "warning");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx, loadConfig(ctx.cwd));
    getProjectKBBasedir(ctx.cwd);
    ensureRouteMap(state.config.routeMap, ctx.cwd);
    ctx.ui.setStatus(SHERPA_LEGACY_UI_KEY, undefined);
    ctx.ui.setWidget(SHERPA_LEGACY_UI_KEY, undefined);
    setSherpaStatus(ctx);
    // Index new session log entries for FTS5 search
    try {
      const indexed = indexSessionLog(undefined, ctx.cwd);
      if (indexed > 0) {
        const total = getIndexedEntryCount(undefined, ctx.cwd);
        try { ctx.ui.notify(`Sherpa indexed ${indexed} new session entries (${total} total)`, "info"); } catch {}
      }
    } catch { /* session search is best-effort at startup */ }
  });

  pi.on("agent_end", (event, ctx) => {
    if (!state?.config.enabled) return;
    if ((event as { willRetry?: boolean }).willRetry === true) return;

    const cwd = ctx.cwd;
    const recentMessages = event.messages ?? ctx.sessionManager.getEntries().slice(-12);

    setTimeout(() => {
      void (async () => {
        if (!state?.config.enabled) return;
        try {
          // Automation candidates
          const raw = stringifyForAutoMemory(recentMessages);
          const automationCandidates = updateAutomationCandidates(state.automation, raw, 3, cwd);
          for (const candidate of automationCandidates) {
            appendScratchpadSection(state, cwd, "distill_candidate", `${candidate.markdown}\n\nPolicy source: ${state.automationPromptSource}`, "Automation candidate");
          }
          if (automationCandidates.length) {
            try { ctx.ui.notify(`Sherpa detected ${automationCandidates.length} automation candidate(s)`, "info"); } catch {}
          }

          // Lifecycle observation
          const recentText = stringifyForAutoMemory(recentMessages);
          const outcome = classifyTaskOutcome(recentText);
          const status = await gitChanged(cwd);
          const changedFiles = parseGitStatusFiles(status);
          const lifecycleHash = hashAutoMemory(`lifecycle\n${outcome.outcome}\n${changedFiles.sort().join("\n")}`);
          if (!state.lifecycleHashes.includes(lifecycleHash) && (changedFiles.length || outcome.outcome !== "unknown")) {
            const verification = suggestVerificationCommands(changedFiles);
            appendScratchpadSection(state, cwd, "observation", [
              `Outcome: ${outcome.outcome}`,
              `Reason: ${outcome.reason}`,
              "",
              changedFiles.length ? "Changed files:" : "Changed files: none detected",
              ...changedFiles.slice(0, 30).map((file) => `- ${file}`),
              "",
              verification.commands.length ? "Suggested verification:" : "Suggested verification: none",
              ...verification.commands.map((item) => `- \`${item.command}\` — ${item.reason}`),
              verification.docsReview ? "- Documentation review recommended." : "- Documentation review not required by heuristic.",
            ].join("\n"), "Task lifecycle summary");
            state.lifecycleHashes = [...state.lifecycleHashes.slice(-49), lifecycleHash];
          }

          // Retrieval self-evaluation: compare the most recent Sherpa bundle with the
          // files the agent actually read/edited plus git-changed files. This creates
          // durable feedback for DSPy export and immediate relevance/noise weighting.
          try {
            const bundle = state.lastBundleId ? getBundle(state, state.lastBundleId) : undefined;
            if (bundle && Date.now() - bundle.timestamp < 2 * 60 * 60 * 1000) {
              const evidence = collectRecentTaskFileEvidence(recentMessages, cwd);
              const referencedFiles = extractMentionedRepoFiles(recentText, cwd);
              const hasTaskSignal = evidence.readFiles.length || evidence.writtenFiles.length || referencedFiles.length || outcome.outcome !== "unknown";
              if (hasTaskSignal) {
                const evalRecord = evaluatePostTaskContext({
                  bundle,
                  outcome: outcome.outcome,
                  files: { ...evidence, referencedFiles, changedFiles },
                  finalText: recentText.slice(-2000),
                });
                const memoryRoot = obsidianMemoryPath(state);
                const target = writeEvaluation(memoryRoot, evalRecord);
                writeQualitySummary(memoryRoot, readRecentEvaluations(memoryRoot, 200));
                appendScratchpadSection(state, cwd, "observation", [
                  `Bundle: ${evalRecord.bundleId}`,
                  `Scores: relevance=${evalRecord.scores.relevance} precision=${evalRecord.scores.precision} recall=${evalRecord.scores.recall}`,
                  evalRecord.noise.length ? `Noise: ${evalRecord.noise.slice(0, 8).join(", ")}` : "Noise: none detected",
                  evalRecord.missed.length ? `Missed: ${evalRecord.missed.slice(0, 8).join(", ")}` : "Missed: none detected",
                  `Hint: ${evalRecord.improvementHint}`,
                  `Stored: ${path.relative(memoryRoot, target)}`,
                ].join("\n"), "Sherpa retrieval evaluation");
                void recordSurrealRetrievalFeedback(state, bundle, evalRecord);
                void maybeAutoCompileDspy(ctx, "evaluate");
              }
            }
          } catch { /* retrieval evaluation must never affect task completion */ }

          // Auto-distillation check
          try {
            const scratchpadRoot = scratchpadRootPath(state, cwd);
            const adConfig = {
              scratchpadRoot,
              minChangedFiles: 3,
              enabled: state.config.enabled,
            };
            const adCheck = checkAutoDistill({
              outcome: outcome.outcome,
              changedFiles: changedFiles.length,
              hasDistillCandidates: true,
            }, adConfig);
            if (adCheck.shouldTrigger) {
              const payloads = prepareDistillPayloads(adCheck.newCandidates);
              const writes = payloads.map((payload) => writeDistilledSkill(payload, cwd, obsidianMemoryPath(state)));
              appendScratchpadSection(state, cwd, "observation", [
                `Auto-distill completed: ${adCheck.reason}`,
                `Domains: ${[...new Set(payloads.map((p) => p.domain))].join(", ")}`,
                `Candidates: ${payloads.length}`,
                ...writes.map((w, i) => `${i + 1}. [${w.destination}] ${path.relative(ctx.cwd, w.skillPath)}`),
              ].join("\n"), "Auto-distill completed");
              markAutoDistillRun(scratchpadRoot);
              try { ctx.ui.notify(`Sherpa auto-distilled ${writes.length} candidate(s)`, "info"); } catch {}
            }
          } catch { /* auto-distill is best-effort */ }

          // Compact scratchpad
          const compacted = compactScratchpad(scratchpadRootPath(state, cwd));
          if (compacted.compacted.length) {
            try { ctx.ui.notify(`Sherpa compacted scratchpad sections: ${compacted.compacted.join(", ")}`, "info"); } catch {}
          }
        } catch (error) {
          try { ctx.ui.notify(`Sherpa post-task work failed: ${String(error)}`, "warning"); } catch {}
        }
      })();
    }, 0);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (state?.config.enabled) await maybeAutoCompileDspy(ctx, "session_shutdown");
    closeSessionDb();
    closeSherpaMemoryIndexes();
    ctx.ui.setWidget(SHERPA_UI_KEY, undefined);
    ctx.ui.setStatus(SHERPA_UI_KEY, undefined);
    ctx.ui.setWidget(SHERPA_LEGACY_UI_KEY, undefined);
    ctx.ui.setStatus(SHERPA_LEGACY_UI_KEY, undefined);
  });

  pi.registerTool({
    name: "sherpa_run_automation",
    label: "Sherpa Run Automation",
    description: "Run a safe registered project automation from package.json or scripts/. Unsafe or approval-required automations are refused.",
    parameters: runAutomationSchema,
    async execute(_toolCallId, params: RunAutomationParams, _signal, _onUpdate, ctx) {
      const automation = findRunnableAutomation(ctx.cwd, params.name);
      if (!automation) {
        const available = discoverRunnableAutomations(ctx.cwd)
          .filter((item) => item.safety === "safe")
          .slice(0, 20)
          .map((item) => `- ${formatRunnableAutomation(item, state?.automation.runStats[item.name])}`)
          .join("\n");
        return { content: [{ type: "text" as const, text: `Automation not found: ${params.name}\n\nSafe automations:\n${available || "(none)"}` }], details: { found: false } };
      }

      if (automation.safety !== "safe") {
        return { content: [{ type: "text" as const, text: `Refused automation '${automation.name}' because safety=${automation.safety}. Ask the main agent/user to approve and run manually.` }], details: { found: true, automation } };
      }

      if (params.dryRun) {
        return { content: [{ type: "text" as const, text: `Dry run: ${automation.command}` }], details: { found: true, automation, dryRun: true } };
      }

      const start = Date.now();
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-lc", automation.command], { cwd: automation.cwd, timeout: automation.timeoutMs ?? 120_000, maxBuffer: 1_000_000 });
        recordAutomationRun(state!.automation, automation, "passed", Date.now() - start);
        persist();
        return { content: [{ type: "text" as const, text: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "Automation completed with no output" }], details: { found: true, automation, stats: state?.automation.runStats[automation.name] } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordAutomationRun(state!.automation, automation, "failed", Date.now() - start, message);
        persist();
        return { content: [{ type: "text" as const, text: `Automation failed: ${message}` }], details: { found: true, automation, stats: state?.automation.runStats[automation.name] } };
      }
    },
  });

  // ── Session Search Tool ──
  const sessionSearchSchema = Type.Object({
    query: Type.String({ description: "Search query for past sessions (FTS5 full-text search)" }),
    limit: Type.Optional(Type.Number({ description: "Maximum results (default: 10, max: 100)" })),
    sessionId: Type.Optional(Type.String({ description: "Optional: load full session by ID" })),
    listSessions: Type.Optional(Type.Boolean({ description: "If true, list all indexed sessions instead of searching" })),
  });
  type SessionSearchParams = Static<typeof sessionSearchSchema>;

  pi.registerTool({
    name: "sherpa_session_search",
    label: "Sherpa Session Search",
    description: "Search past conversations in the session log via FTS5 full-text search. Indexes HyperPod session.jsonl into SQLite for cross-session recall.",
    promptSnippet: "Search past conversations via FTS5 full-text search across all indexed sessions.",
    promptGuidelines: [
      "Use sherpa_session_search when you need to recall a past conversation, solution, or pattern.",
      "Pass query as a natural language phrase (e.g., 'error pipeline' or 'deploy to production').",
      "Use sessionId to load all entries for a specific session.",
      "Use listSessions: true to browse available sessions before searching.",
    ],
    parameters: sessionSearchSchema,
    async execute(_toolCallId, params: SessionSearchParams, _signal, _onUpdate, ctx) {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      try {
        // Index new entries first for fresh data
        const indexed = indexSessionLog(undefined, ctx.cwd);

        if (params.listSessions) {
          const sessions = listSessions(undefined, ctx.cwd);
          const total = getIndexedEntryCount(undefined, ctx.cwd);
          const lines = sessions.map((s) =>
            `- **${s.sessionId}**: ${s.entryCount} entries, ${s.firstTs.slice(0, 10)} to ${s.lastTs.slice(0, 10)}`
          );
          return {
            content: [{ type: "text" as const, text: `## Indexed Sessions\nTotal entries: ${total}\n\n${lines.join("\n") || "(no sessions indexed yet)"}` }],
            details: { sessions, totalEntries: total, indexed },
          };
        }

        if (params.sessionId) {
          const entries = loadSession(params.sessionId, undefined, ctx.cwd);
          const text = entries.map((e) => `[${e.ts.slice(0, 19)}] ${e.kind}: ${e.text.slice(0, 300)}`).join("\n\n");
          return {
            content: [{ type: "text" as const, text: `## Session: ${params.sessionId}\n${entries.length} entries\n\n${text.slice(0, 8000) || "(empty session)"}` }],
            details: { sessionId: params.sessionId, entries: entries.length, indexed },
          };
        }

        const results = searchSessions(params.query, params.limit ?? 10, undefined, ctx.cwd);
        if (results.length === 0) {
          const suggestions = ["Try a simpler query (single word or short phrase).", "Use listSessions to browse available sessions first.", "Ensure the session log has entries (PATH/hyperpod-tmp/session.jsonl)."];
          return {
            content: [{ type: "text" as const, text: `## No results for "${params.query}"\n\n${suggestions.join("\n")}` }],
            details: { query: params.query, count: 0, indexed },
          };
        }
        const lines = results.map((r: SessionSearchMatch, i: number) =>
          `### ${i + 1}. ${r.sessionId} (rank ${r.rank.toFixed(6)})\n**Timestamp:** ${r.ts.slice(0, 19)} | **Kind:** ${r.kind}\n${r.snippet}\n`
        );
        return {
          content: [{ type: "text" as const, text: `## Session Search: "${params.query}"\n${results.length} matches\n\n${lines.join("\n")}` }],
          details: { query: params.query, count: results.length, results, indexed },
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Session search error: ${e?.message ?? String(e)}` }], details: { error: e?.message ?? String(e) } };
      }
    },
  });

  // ── SQLite Memory Index Tool ──
  const memorySearchSchema = Type.Object({
    query: Type.Optional(Type.String({ description: "Search query for indexed Sherpa memory artifacts" })),
    limit: Type.Optional(Type.Number({ description: "Maximum search results (default: 10, max: 100)" })),
    reindex: Type.Optional(Type.Boolean({ description: "Rebuild/update the SQLite memory index before searching" })),
    statusOnly: Type.Optional(Type.Boolean({ description: "Only return index stats; no search" })),
  });
  type MemorySearchParams = Static<typeof memorySearchSchema>;

  pi.registerTool({
    name: "sherpa_memory_search",
    label: "Sherpa Memory Search",
    description: "Index and search Sherpa memory artifacts via SQLite/FTS5 while keeping Markdown/CSV files canonical.",
    promptSnippet: "Search indexed Sherpa memory artifacts (scratchpad, catalog rows, evaluations) via SQLite/FTS5.",
    promptGuidelines: [
      "Use sherpa_memory_search when you need recall across Sherpa scratchpad, catalog rows, or retrieval evaluations.",
      "Set reindex=true before searching if memory artifacts may have changed recently.",
      "Use statusOnly=true to inspect index size without searching.",
    ],
    parameters: memorySearchSchema,
    async execute(_toolCallId, params: MemorySearchParams, _signal, _onUpdate, ctx) {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      try {
        const config = {
          scratchpadRoot: scratchpadRootPath(state, ctx.cwd),
          catalogRoots: [ctx.cwd, obsidianMemoryPath(state)],
          evaluationRoot: obsidianMemoryPath(state),
        };
        const stats = (params.reindex || params.statusOnly || params.query) ? indexSherpaMemory(ctx.cwd, config) : indexSherpaMemory(ctx.cwd, config);
        if (params.statusOnly || !params.query?.trim()) {
          return { content: [{ type: "text" as const, text: `## Sherpa Memory Index\nDocuments: ${stats.documents}\nScratchpad entries: ${stats.scratchpadEntries}\nCatalog entries: ${stats.catalogEntries}\nEvaluations: ${stats.evaluations}\nDedup hashes: ${stats.dedupHashes}\nDB: ${stats.dbPath}` }], details: stats };
        }
        const results = searchSherpaMemory(ctx.cwd, params.query, params.limit ?? 10, config);
        const lines = results.map((r, i) => `### ${i + 1}. ${r.title}\n**Kind:** ${r.kind}\n**Source:** ${r.sourcePath}\n${r.snippet || r.summary}`).join("\n\n");
        return { content: [{ type: "text" as const, text: `## Sherpa Memory Search: "${params.query}"\n${results.length} result(s)\n\n${lines || "(no matches)"}` }], details: { stats, results } };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Sherpa memory search error: ${e?.message ?? String(e)}` }], details: { error: e?.message ?? String(e) } };
      }
    },
  });

  // ── Nudge Tool ──
  const nudgeSchema = Type.Object({
    target: Type.Union([Type.Literal("observation"), Type.Literal("distill_candidate")], {
      description: "Which scratchpad section to write to: observation or distill_candidate",
    }),
    content: Type.String({ description: "The observation, lesson, or fact to persist" }),
    dedupKey: Type.Optional(Type.String({ description: "Optional dedup key to combine with content for dedup matching" })),
    skipDedup: Type.Optional(Type.Boolean({ description: "Skip deduplication check (default: false)" })),
  });
  type NudgeParams = Static<typeof nudgeSchema>;

  pi.registerTool({
    name: "sherpa_nudge",
    label: "Sherpa Nudge",
    description: "Proactively save an observation, preference, environment fact, correction, or convention to the scratchpad. Automatically deduplicates and manages capacity. Ported from Hermes Agent's agent-curated memory with nudges.",
    promptSnippet: "Save an observation or lesson learned to the Sherpa scratchpad with automatic dedup.",
    promptGuidelines: [
      "Use sherpa_nudge when you discover a non-trivial fact about the project, environment, or user preferences.",
      "Good candidates: environment facts, project conventions, corrections, completed workflows, tool quirks.",
      "Avoid: trivial facts, easily re-discoverable info, raw data dumps, session-specific ephemera.",
      "Prefer 'observation' for general facts. Use 'distill_candidate' for procedural knowledge worth archiving.",
    ],
    parameters: nudgeSchema,
    async execute(_toolCallId, params: NudgeParams, _signal, _onUpdate, ctx) {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      try {
        const root = scratchpadRootPath(state, ctx.cwd);
        const result = writeNudge(
          params.target as NudgeTarget,
          params.content,
          { scratchpadRoot: root },
          { dedupKey: params.dedupKey, skipDedup: params.skipDedup },
        );
        const parts: string[] = [];
        if (result.written) parts.push("✅ Written");
        if (result.deduped) parts.push("⏭ Skipped (exact duplicate)");
        if (result.nearDuplicate) parts.push("⚠ Near-duplicate detected (written but may overlap)");
        if (result.capacityWarning) parts.push(`📊 ${result.capacityWarning}`);
        if (result.autoCompacted) parts.push("📦 Section auto-compacted (older entries archived)");
        parts.push(`📁 ${result.path}`);
        parts.push(`📝 ${result.entryCount} entries, ${result.usagePercent}% capacity`);
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Nudge error: ${e?.message ?? String(e)}` }], details: { error: e?.message ?? String(e) } };
      }
    },
  });

  pi.registerCommand("sherpa:automations", { description: "List safe project automations Sherpa can run", handler: async (_args, ctx) => {
    const automations = discoverRunnableAutomations(ctx.cwd);
    const lines = automations.map(a => `- ${formatRunnableAutomation(a, state?.automation.runStats[a.name])}`).slice(0, 80);
    ctx.ui.notify(lines.length ? lines.join("\n") : "No project automations discovered", "info");
  }});

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state?.config?.enabled || !state.config.frontDoor.enabled || state.config.mode === "off" || state.config.mode === "explicit") return;
    if (isTrivial(event.prompt)) { state.lastSkip = "trivial prompt"; return; }

    setSherpaStatus(ctx, "curating", event.prompt);
    ctx.ui.setWidget(SHERPA_UI_KEY, [
      "🤵 Sherpa is curating context…",
      "🔎 Searching files, docs, and git status.",
      "⏳ If curation is slow, Pi will continue automatically.",
    ]);

    try {
      const { sourcePlan, indicators } = await planSources(state, ctx, event.prompt, "front-door");
      ctx.ui.setWidget(SHERPA_UI_KEY, [
        "🤵 Sherpa is curating context…",
        `🧭 Sources: ${sourcePlan.sources.join(", ")} (${sourcePlan.planner})`,
        `＇　️ Indicators: ${indicators.indicators.slice(0, 5).join(", ")}${indicators.indicators.length > 5 ? "..." : ""}`,
        `💡 ${indicators.reason.slice(0, 80)}`
      ]);

      // Front-door context must stay high-signal. Avoid session_recent by default because it often
      // echoes tool-result noise back into the next prompt. Explicit Sherpa requests can still use it.
      const bundle = await Promise.race([
        buildBundle(state, ctx, event.prompt, "front-door", state.config.frontDoor.tokenBudget, sourcePlan, indicators),
        timeoutAfter<ContextBundle>(CURATION_TIMEOUT_MS, "front-door curation timed out"),
      ]);
      bundle.items = filterAlreadySeenSources(ctx, bundle.items);
      bundle.signal = buildContextSignal(bundle);
      void maybeAutoCompileDspy(ctx, "bundle");
      const abstainReason = shouldAbstain(bundle.items, "front-door");
      if (abstainReason) { state.lastSkip = abstainReason; return; }
      ctx.ui.setStatus(SHERPA_UI_KEY, `🤵 injecting ${bundle.items.length} item(s)`);
      return { message: { customType: SHERPA_CONTEXT_TYPE, content: bundleMarkdown(bundle), display: true, details: bundle } };
    } catch (err: any) {
      state.lastSkip = `front-door error: ${err?.message ?? err}`;
      ctx.ui.notify(`Sherpa context skipped: ${err?.message ?? err}; continuing without extra context`, "warning");
      return;
    } finally {
      ctx.ui.setWidget(SHERPA_UI_KEY, undefined);
      setSherpaStatus(ctx);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state?.config.enabled) return;
    const text = event.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
    // Do not compress file editing/reading tools in normal cases: hiding source code makes review
    // harder. Focus compression on noisy command/test/log output.
    if (!["bash", "run_experiment"].includes(event.toolName) && text.length < 100_000) return;
    if (text.length < state.config.summarization.maxToolResultChars) return;
    const summary = await llmSummarize(ctx, state, text, state.config.summarization.replacementBudget * 4);
    const handle = `ctx-${state.nextHandle++}`;
    state.handles.set(handle, { handle, type: "tool_raw", source: `tool://${event.toolName}/${event.toolCallId}`, relevance: 1, summary, raw: text });
    const details = event.details && typeof event.details === "object" ? event.details : {};
    return { content: [{ type: "text", text: `Sherpa compressed long ${event.toolName} output into ${handle}.\n\n${summary}\n\nUse /sherpa:expand ${handle} for raw output.` }], details: { ...details, sherpaRawHandle: handle, sherpaCompressed: true } };
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!state) return; state.turnCount++;
    if (!state.config.enabled || !state.config.proactive.enabled || state.turnCount - state.lastProactiveTurn < state.config.proactive.cooldownTurns) return;
    const usage = ctx.getContextUsage?.();
    if (usage && usage.tokens > 80_000) {
      state.lastProactiveTurn = state.turnCount;
      ctx.ui.setWidget("ai-sherpa", ["🤵 Sherpa: context is high; consider /compact or /sherpa for focused retrieval."], { placement: "belowEditor" });
    }
  });

  pi.registerTool({
    name: "sherpa_request_context",
    label: "Sherpa Context",
    description: "Ask the Sherpa for focused project/session context with expandable handles.",
    promptSnippet: "Retrieve focused project/session context via the Sherpa sidecar.",
    promptGuidelines: ["Use sherpa_request_context when you need focused repo, docs, git, or session context before editing."],
    parameters: requestSchema,
    async execute(_toolCallId, params: RequestParams, _signal, _onUpdate, ctx) {
      // Defensive: ensure state is always initialized before any access
      if (typeof state === "undefined" || state === null) {
        try {
          state = restoreState(ctx, loadConfig(ctx.cwd));
        } catch (e: any) {
          return { content: [{ type: "text", text: `Sherpa init failed: ${e?.message ?? String(e)}` }], details: { error: "init_failed", detail: e?.stack?.slice(0, 300) } };
        }
      }
      setSherpaStatus(ctx, "context", params.focus);
      try {
        const _state = state; // capture at function scope to avoid TDZ issues
        const expanded = (params.expandHandles ?? []).map(h => _state.handles.get(h)).filter(Boolean) as ContextItem[];
        const { sourcePlan, indicators } = await planSources(_state, ctx, params.focus, "explicit", params.sources);
        setSherpaStatus(ctx, `searching ${sourcePlan.sources.join(",")}`, params.focus);
        const bundle = await buildBundle(_state, ctx, params.focus, "explicit", params.tokenBudget ?? _state.config.explicit.tokenBudget, sourcePlan, indicators, { searchOtherProjects: params.searchOtherProjects, includeTaxonomy: params.includeTaxonomy });
        void maybeAutoCompileDspy(ctx, "bundle");
        const extra = expanded.map(i => `\n\n## Expanded ${i.handle}\nSource: ${i.source}\n\n${(i.raw ?? i.summary).slice(0, (params.tokenBudget ?? 3000) * 4)}`).join("");
        persist();
        return { content: [{ type: "text", text: bundleMarkdown(bundle) + extra }], details: bundle };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Sherpa error: ${e?.message ?? String(e)}\n${(e?.stack ?? "").split("\n").slice(0, 5).join("\n")}` }], details: { error: e?.message ?? String(e) } };
      } finally {
        setSherpaStatus(ctx);
      }
    },
  });

  pi.registerTool({
    name: "sherpa_scratchpad_read",
    label: "Sherpa Scratchpad Read",
    description: "Read repo-local Sherpa scratchpad sections from config memory.scratchpadPath.",
    promptSnippet: "Read repo-local Sherpa scratchpad sections: todo, observation, issue, next, distill_candidate.",
    promptGuidelines: ["Use sherpa_scratchpad_read to inspect repo-local project scratchpad notes before planning or resuming work."],
    parameters: scratchpadReadSchema,
    async execute(_toolCallId, params: ScratchpadReadParams, _signal, _onUpdate, ctx) {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      const sections = params.section ? [params.section as ScratchpadSection] : SCRATCHPAD_SECTIONS;
      const parts = sections.map(section => {
        const { target, text } = readScratchpadSection(state!, ctx.cwd, section, params.limitChars ?? 12000);
        const rel = scratchpadRootRelative(state!, ctx.cwd, target);
        return [`## ${section}`, `Path: ${rel}`, "", text.trim() || "(empty)"].join("\n");
      });
      return {
        content: [{ type: "text", text: `# Sherpa Scratchpad\nRoot: ${scratchpadRootPath(state, ctx.cwd)}\n\n${parts.join("\n\n")}` }],
        details: { root: scratchpadRootPath(state, ctx.cwd), sections },
      };
    },
  });

  pi.registerTool({
    name: "sherpa_scratchpad_append",
    label: "Sherpa Scratchpad Append",
    description: "Append a structured note to a repo-local Sherpa scratchpad section under config memory.scratchpadPath.",
    promptSnippet: "Append notes to repo-local Sherpa scratchpad sections: todo, observation, issue, next, distill_candidate.",
    promptGuidelines: ["Use sherpa_scratchpad_append to save ephemeral project todos, observations, issues, next steps, or distillation candidates."],
    parameters: scratchpadAppendSchema,
    async execute(_toolCallId, params: ScratchpadAppendParams, _signal, _onUpdate, ctx) {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      const target = appendScratchpadSection(state, ctx.cwd, params.section as ScratchpadSection, params.text, params.title);
      persist();
      return {
        content: [{ type: "text", text: `Appended to Sherpa scratchpad ${params.section}: ${scratchpadRootRelative(state, ctx.cwd, target)}` }],
        details: { root: scratchpadRootPath(state, ctx.cwd), section: params.section, path: target },
      };
    },
  });

  const scratchpadCompletions = (prefix: string) => {
    const items = SCRATCHPAD_SECTIONS.map(section => ({ value: section, label: section }));
    const filtered = items.filter(item => item.value.startsWith(prefix.trim()));
    return filtered.length ? filtered : items;
  };

  pi.registerCommand("sherpa:scratchpad", {
    description: "Read repo-local Sherpa scratchpad sections",
    getArgumentCompletions: scratchpadCompletions,
    handler: async (args, ctx) => {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      const sectionArg = args?.trim() as ScratchpadSection;
      const sections = SCRATCHPAD_SECTIONS.includes(sectionArg) ? [sectionArg] : SCRATCHPAD_SECTIONS;
      const parts = sections.map(section => {
        const { target, text } = readScratchpadSection(state!, ctx.cwd, section, 12000);
        return [`## ${section}`, `Path: ${scratchpadRootRelative(state!, ctx.cwd, target)}`, "", text.trim() || "(empty)"].join("\n");
      });
      pi.sendMessage({
        customType: "sherpa-scratchpad",
        content: `# Sherpa Scratchpad\nRoot: ${scratchpadRootPath(state, ctx.cwd)}\n\n${parts.join("\n\n")}`,
        display: true,
        details: { root: scratchpadRootPath(state, ctx.cwd), sections },
      }, { triggerTurn: false, deliverAs: "nextTurn" });
    },
  });

  pi.registerCommand("sherpa:scratchpad:add", {
    description: "Append to repo-local Sherpa scratchpad: <section> <text>",
    getArgumentCompletions: (prefix: string) => scratchpadCompletions(prefix.split(/\s+/)[0] ?? ""),
    handler: async (args, ctx) => {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      const match = args?.trim().match(/^(todo|observation|issue|next|distill_candidate)\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("Usage: /sherpa:scratchpad:add <todo|observation|issue|next|distill_candidate> <text>", "warning");
        return;
      }
      const section = match[1] as ScratchpadSection;
      const text = match[2].trim();
      if (!text) return;
      const target = appendScratchpadSection(state, ctx.cwd, section, text);
      persist();
      ctx.ui.notify(`Sherpa scratchpad appended: ${scratchpadRootRelative(state, ctx.cwd, target)}`, "info");
    },
  });

  pi.registerCommand("sherpa", { description: "Ask Sherpa for focused context", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const focus = args?.trim() || await ctx.ui.input("Sherpa", "Focus?"); if (!focus) return;
    setSherpaStatus(ctx, "context", focus);
    try {
      // User-invoked /sherpa should behave like an intervention: inject the context and wake the
      // main agent. Source planning chooses the likely stores before expensive retrieval.
      const { sourcePlan, indicators } = await planSources(state, ctx, focus, "explicit");
      setSherpaStatus(ctx, `searching ${sourcePlan.sources.join(",")}`, focus);
      const bundle = await buildBundle(state, ctx, focus, "explicit", state.config.explicit.tokenBudget, sourcePlan, indicators);
      void maybeAutoCompileDspy(ctx, "bundle");
      const abstainReason = shouldAbstain(bundle.items, "explicit");
      if (abstainReason) {
        state.lastSkip = abstainReason;
        ctx.ui.notify(`Sherpa stepping aside: ${abstainReason}`, "info");
        // Do not wake the main agent with an empty/low-value Sherpa message. If the user wants the
        // main agent, they can ask directly; Sherpa should not add noise just to participate.
        persist();
        return;
      }
      ctx.ui.notify(`Sherpa found ${bundle.items.length} useful items; triggering agent`, "info");
      pi.sendMessage({ customType: "sherpa-context", content: bundleMarkdown(bundle), display: true, details: bundle }, { triggerTurn: true, deliverAs: "steer" });
      persist();
    } finally {
      setSherpaStatus(ctx);
    }
  }});

  pi.registerCommand("sherpa:expand", { description: "Expand a Sherpa context handle", handler: async (args, ctx) => {
    const item = state?.handles.get(args.trim());
    if (!item) return ctx.ui.notify(`Unknown Sherpa handle: ${args}`, "error");
    pi.sendMessage({ customType: "sherpa-context", content: `## Expanded ${item.handle}\n${item.source}\n\n${item.raw ?? item.summary}`, display: true, details: item }, { triggerTurn: false, deliverAs: "nextTurn" });
  }});

  pi.registerCommand("sherpa:evaluate", { description: "Record retrieval quality: [bundle-id] [outcome] [relevance] [precision] [recall] [reflection]", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const parsed = parseEvaluationArgs(args, state.lastBundleId, (bundleId) => getBundle(state!, bundleId));
    if (!parsed.bundleId) return ctx.ui.notify("No recent Sherpa bundle to evaluate", "warning");

    const memoryRoot = obsidianMemoryPath(state);
    const evalRecord = {
      bundleId: parsed.bundleId,
      taskOutcome: parsed.taskOutcome,
      scores: { relevance: parsed.relevance, precision: parsed.precision, recall: parsed.recall },
      noise: [],
      missed: parsed.bundle ? [] : ["bundle not found in recent in-memory records"],
      reflection: parsed.reflection || defaultEvaluationReflection(parsed.bundleId, parsed.bundle),
      improvementHint: evaluationImprovementHint(parsed.recall),
      evaluatedAt: new Date().toISOString(),
    };
    const target = writeEvaluation(memoryRoot, evalRecord);
    writeQualitySummary(memoryRoot, readRecentEvaluations(memoryRoot, 200));
    if (parsed.bundle) void recordSurrealRetrievalFeedback(state, parsed.bundle, evalRecord);
    ctx.ui.notify(`Sherpa evaluation written: ${path.relative(memoryRoot, target)}`, "info");
    void maybeAutoCompileDspy(ctx, "evaluate");
  }});

  pi.registerCommand("sherpa:evals", { description: "Summarize recent Sherpa retrieval evaluations", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const evals = readRecentEvaluations(obsidianMemoryPath(state), 50);
    ctx.ui.notify(evals.length ? formatEvaluationSummary(evals) : "No Sherpa evaluations found yet", "info");
  }});

  pi.registerCommand("sherpa:trace-report", { description: "Summarize recent Sherpa raw trace decisions: /sherpa:trace-report [limit]", handler: async (args, ctx) => {
    const limit = Number(args?.trim()) || 500;
    const traces = readDspyTraces(ctx.cwd, limit);
    if (!traces.length) return ctx.ui.notify("No Sherpa traces found yet", "warning");
    const report = summarizeDspyTraces(traces);
    const fmt = (items: Array<{ source: string; count: number }>) => items.map((item) => `${item.source}×${item.count}`).join(", ") || "none";
    const fmtReasons = (items: Array<{ reason: string; count: number }>) => items.map((item) => `${item.reason}×${item.count}`).join(", ") || "none";
    ctx.ui.notify([
      `Sherpa trace report: traces=${report.traces}`,
      `avg candidates=${report.averageCandidates.toFixed(2)}; avg selected=${report.averageSelected.toFixed(2)}; abstentionRate=${report.abstentionRate.toFixed(2)}`,
      `decisions: selected=${report.decisions.selected}; boosted=${report.decisions.boosted}; rejected=${report.decisions.rejected}; suppressed=${report.decisions.suppressed}`,
      `top selected: ${fmt(report.topSelected)}`,
      `top rejected: ${fmt(report.topRejected)}`,
      `top suppressed: ${fmt(report.topSuppressed)}`,
      `top reasons: ${fmtReasons(report.topReasons)}`,
    ].join("\n"), "info");
  }});

  pi.registerCommand("sherpa:quality", { description: "Write and show the rolling Sherpa retrieval quality summary for this project", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const limit = Number(args?.trim()) || 200;
    const memoryRoot = obsidianMemoryPath(state);
    const evals = readRecentEvaluations(memoryRoot, limit);
    if (!evals.length) return ctx.ui.notify("No Sherpa evaluations found yet", "warning");
    const target = writeQualitySummary(memoryRoot, evals);
    const summary = summarizeEvaluations(evals);
    ctx.ui.notify([
      `Sherpa quality summary written: ${path.relative(memoryRoot, target)}`,
      `window=${summary.count}; avg relevance=${summary.averageRelevance.toFixed(2)} precision=${summary.averagePrecision.toFixed(2)} recall=${summary.averageRecall.toFixed(2)}`,
      `top noise: ${summary.topNoise.slice(0, 5).map(n => `${n.source}×${n.count}`).join(", ") || "none"}`,
      `top missed: ${summary.topMissed.slice(0, 5).map(m => `${m.pattern}×${m.count}`).join(", ") || "none"}`,
    ].join("\n"), "info");
  }});

  pi.registerCommand("sherpa:quality:all", { description: "Refresh and summarize Sherpa retrieval quality summaries across all Obsidian projects", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const limit = Number(args?.trim()) || 200;
    const projectsRoot = path.join(obsidianVaultPath(state), "projects");
    if (!existsSync(projectsRoot)) return ctx.ui.notify(`Projects memory root not found: ${projectsRoot}`, "warning");
    const rows: Array<{ project: string; count: number; relevance: number; precision: number; recall: number; target: string }> = [];
    for (const name of readdirSync(projectsRoot)) {
      const projectRoot = path.join(projectsRoot, name);
      if (!statSync(projectRoot).isDirectory()) continue;
      const evals = readRecentEvaluations(projectRoot, limit);
      if (!evals.length) continue;
      const target = writeQualitySummary(projectRoot, evals);
      const summary = summarizeEvaluations(evals);
      rows.push({ project: name, count: summary.count, relevance: summary.averageRelevance, precision: summary.averagePrecision, recall: summary.averageRecall, target });
    }
    rows.sort((a, b) => a.relevance - b.relevance || b.count - a.count);
    ctx.ui.notify(rows.length ? [
      `Sherpa quality summaries refreshed for ${rows.length} project(s)`,
      ...rows.slice(0, 20).map((row) => `${row.project}: n=${row.count} rel=${row.relevance.toFixed(2)} prec=${row.precision.toFixed(2)} rec=${row.recall.toFixed(2)}`),
    ].join("\n") : "No project Sherpa evaluations found", rows.length ? "info" : "warning");
  }});

  pi.registerCommand("sherpa:dspy:export", { description: "Export Sherpa traces and evaluations as DSPy-style JSONL train/dev datasets", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const limit = Number(args?.trim()) || 2000;
    const evals = readRecentEvaluations(obsidianMemoryPath(state), limit);
    const result = exportDspyDataset(ctx.cwd, evals, { limit });
    ctx.ui.notify([
      "Sherpa DSPy-style dataset exported",
      `traces=${result.traces}; matched evaluations=${result.matchedEvaluations}`,
      `avgMetric=${result.averageMetric.toFixed(2)}; high=${result.highScoringExamples}; low=${result.lowScoringExamples}`,
      `train=${result.train}; dev=${result.dev}`,
      `train: ${path.relative(ctx.cwd, result.trainPath)}`,
      `dev: ${path.relative(ctx.cwd, result.devPath)}`,
    ].join("\n"), result.traces ? "info" : "warning");
  }});

  pi.registerCommand("sherpa:dspy:compile", { description: "Export traces/evaluations and compile a retrieval prompt-feedback artifact (pass --force to ignore quality gates)", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const rawArgs = args?.trim() ?? "";
    const force = /(^|\s)--force(\s|$)/.test(rawArgs);
    const limit = Number(rawArgs.replace(/--force/g, "").trim()) || 2000;
    const evals = readRecentEvaluations(obsidianMemoryPath(state), limit);
    const exported = exportDspyDataset(ctx.cwd, evals, { limit });
    if (!exported.traces) {
      ctx.ui.notify("No Sherpa traces found yet. Use Sherpa normally, evaluate bundles, then retry.", "warning");
      return;
    }
    const qualityProblems = [
      exported.matchedEvaluations < DSPY_COMPILE_MIN_EVALUATIONS ? `need ${DSPY_COMPILE_MIN_EVALUATIONS} matched evaluations; have ${exported.matchedEvaluations}` : "",
      exported.averageMetric < DSPY_COMPILE_MIN_AVG_METRIC ? `average metric ${exported.averageMetric.toFixed(2)} below ${DSPY_COMPILE_MIN_AVG_METRIC}` : "",
      exported.highScoringExamples < DSPY_COMPILE_MIN_HIGH_EXAMPLES ? `need ${DSPY_COMPILE_MIN_HIGH_EXAMPLES} high-scoring examples; have ${exported.highScoringExamples}` : "",
    ].filter(Boolean);
    if (qualityProblems.length && !force) {
      ctx.ui.notify([
        "Sherpa DSPy-style compile skipped: evaluation quality gate failed",
        ...qualityProblems,
        "Run /sherpa:dspy:compile --force only to inspect a low-quality candidate; do not promote it.",
      ].join("\n"), "warning");
      return;
    }
    const scriptPath = path.join(path.dirname(__filename), "scripts", "optimize-sherpa-dspy.py");
    const projectPrompt = path.join(ctx.cwd, ".pi", "sherpa", "prompts", "RETRIEVAL.md");
    const basePrompt = existsSync(projectPrompt) ? projectPrompt : path.join(path.dirname(__filename), "prompts", "RETRIEVAL.md");
    try {
      const candidateDir = path.join(".pi", "sherpa", "compiled-candidates");
      const { stdout, stderr } = await execFileAsync("python3", [scriptPath, "--base-prompt", basePrompt, "--out-dir", candidateDir], { cwd: ctx.cwd, timeout: 120_000, maxBuffer: 1_000_000 });
      state = restoreState(ctx, state.config);
      ctx.ui.notify([
        force ? "Sherpa DSPy-style candidate compile complete (forced)" : "Sherpa DSPy-style candidate compile complete",
        `exported train=${exported.train}; dev=${exported.dev}; matched=${exported.matchedEvaluations}; avgMetric=${exported.averageMetric.toFixed(2)}; high=${exported.highScoringExamples}`,
        `candidate: ${candidateDir}/retrieval.prompt.json`,
        "Promote with /sherpa:dspy:promote, then enable with /sherpa:dspy:on.",
        stdout.trim(),
        stderr.trim(),
      ].filter(Boolean).join("\n"), "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Sherpa DSPy compile failed: ${message}`, "error");
    }
  }});

  pi.registerCommand("sherpa:dspy:eval", { description: "Compare DSPy candidate and active compiled prompt artifacts", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const candidate = readCompiledPrompt(ctx.cwd, ".pi/sherpa/compiled-candidates", "retrieval");
    const active = readCompiledPrompt(ctx.cwd, state.config.dspy.compiledPromptPath, "retrieval");
    const metric = (artifact: ReturnType<typeof readCompiledPrompt>) => {
      const value = artifact?.metadata?.average_metric;
      return typeof value === "number" ? value : undefined;
    };
    const candidateMetric = metric(candidate);
    const activeMetric = metric(active);
    const verdict = candidateMetric === undefined
      ? "candidate has no metric"
      : activeMetric === undefined
        ? "candidate is promotable; no active metric to compare"
        : candidateMetric >= activeMetric
          ? "candidate metric is >= active metric"
          : "candidate metric is below active metric; inspect before promoting";
    ctx.ui.notify([
      "Sherpa DSPy artifact evaluation",
      `candidate=${candidate ? candidate.source : "missing"}`,
      `candidateMetric=${candidateMetric ?? "unknown"}`,
      `active=${active ? active.source : "missing"}`,
      `activeMetric=${activeMetric ?? "unknown"}`,
      `verdict=${verdict}`,
    ].join("\n"), candidate && (!activeMetric || !candidateMetric || candidateMetric >= activeMetric) ? "info" : "warning");
  }});

  pi.registerCommand("sherpa:dspy:promote", { description: "Promote compiled DSPy candidate artifacts to the active compiled prompt directory", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const candidate = path.join(ctx.cwd, ".pi", "sherpa", "compiled-candidates", "retrieval.prompt.json");
    if (!existsSync(candidate)) {
      ctx.ui.notify("No DSPy candidate found. Run /sherpa:dspy:compile first.", "warning");
      return;
    }
    const targetDir = path.isAbsolute(state.config.dspy.compiledPromptPath) ? state.config.dspy.compiledPromptPath : path.join(ctx.cwd, state.config.dspy.compiledPromptPath);
    mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, "retrieval.prompt.json");
    if (existsSync(target)) {
      const backup = path.join(targetDir, `retrieval.prompt.${new Date().toISOString().replace(/[:.]/g, "-")}.bak.json`);
      copyFileSync(target, backup);
    }
    copyFileSync(candidate, target);
    state = restoreState(ctx, state.config);
    ctx.ui.notify(`Sherpa DSPy candidate promoted: ${path.relative(ctx.cwd, target)}`, "info");
  }});

  pi.registerCommand("sherpa:dspy:on", { description: "Enable compiled DSPy prompt artifacts", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    state.config.dspy.enabled = true;
    saveConfig(ctx.cwd, state.config);
    state = restoreState(ctx, state.config);
    ctx.ui.notify(`Sherpa DSPy compiled prompts enabled: ${state.config.dspy.compiledPromptPath}`, "info");
  }});

  pi.registerCommand("sherpa:dspy:off", { description: "Disable compiled DSPy prompt artifacts", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    state.config.dspy.enabled = false;
    saveConfig(ctx.cwd, state.config);
    state = restoreState(ctx, state.config);
    ctx.ui.notify("Sherpa DSPy compiled prompts disabled", "info");
  }});

  pi.registerCommand("sherpa:dspy:status", { description: "Show DSPy compiled prompt status", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const compiled = readCompiledPrompt(ctx.cwd, state.config.dspy.compiledPromptPath, "retrieval");
    ctx.ui.notify([
      `enabled=${state.config.dspy.enabled}`,
      `compiledPromptPath=${state.config.dspy.compiledPromptPath}`,
      `retrievalArtifact=${compiled ? compiled.source : "missing or no prompt field"}`,
      `candidateArtifact=${readCompiledPrompt(ctx.cwd, ".pi/sherpa/compiled-candidates", "retrieval")?.source ?? "missing"}`,
      `activeRetrievalPrompt=${state.retrievalPromptSource}`,
      `autoCompile=${state.config.dspy.autoCompile.enabled ? "on" : "off"}; minTraces=${state.config.dspy.autoCompile.minTraces}; bundleInterval=${state.config.dspy.autoCompile.bundleInterval}`,
      `lastAutoCompile=${state.dspyAuto.lastCompileAt ?? "never"}`,
    ].join("\n"), compiled ? "info" : "warning");
  }});

  pi.registerCommand("sherpa:status", { description: "Show Sherpa status", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const configuredModel = state.config.model.useMainPiModel ? ctx.model : ctx.modelRegistry.find(state.config.model.provider, state.config.model.id);
    const modelStatus = state.config.model.heuristicOnly ? "heuristic-only" : state.config.model.useMainPiModel ? `main Pi model (${ctx.model?.provider}/${ctx.model?.id})` : `${state.config.model.provider}/${state.config.model.id}${configuredModel ? "" : " [NOT FOUND]"}`;
    ctx.ui.notify([
      `Sherpa ${state.config.enabled ? state.config.mode : "off"}; bundles=${state.bundles}; handles=${state.handles.size}`,
      `model=${modelStatus}`,
      `retrievalPrompt=${state.retrievalPromptSource}`,
      `distillPrompt=${state.distillPromptSource}`,
      `documentationPrompt=${state.documentationPromptSource}`,
      `automationPrompt=${state.automationPromptSource}`,
      `surrealMemory=${state.config.memoryStore.surreal.enabled ? `${state.config.memoryStore.surreal.url} mode=${state.config.memoryStore.surreal.mode ?? "memory-api"} ns=${state.config.memoryStore.surreal.namespace} db=${state.config.memoryStore.surreal.database}; source=${state.config.sources.surreal_memory ? "on" : "off"}; depth=${state.config.surrealMemory.evidenceDepth}; chainBoost=${state.config.surrealMemory.chainWeightBoost}` : "disabled"}`,
      `lastSkip=${state.lastSkip}`,
    ].join("\n"), "info");
  }});

  pi.registerCommand("sherpa:prompt", { description: "Show active Sherpa system prompt source", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    pi.sendMessage({ customType: "sherpa-prompt", content: [
      `## Sherpa Retrieval Prompt\nSource: ${state.retrievalPromptSource}\n\n${state.retrievalPrompt}`,
      `## Sherpa Distillation Prompt\nSource: ${state.distillPromptSource}\n\n${state.distillPrompt}`,
      `## Sherpa Documentation Prompt\nSource: ${state.documentationPromptSource}\n\n${state.documentationPrompt}`,
      `## Sherpa Automation Prompt\nSource: ${state.automationPromptSource}\n\n${state.automationPrompt}`,
    ].join("\n\n---\n\n"), display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
  }});

  pi.registerCommand("sherpa:on", { description: "Enable Sherpa", handler: async (_args, ctx) => { if (!state) state = restoreState(ctx, loadConfig(ctx.cwd)); state.config.enabled = true; saveConfig(ctx.cwd, state.config); ctx.ui.setStatus("ai-sherpa", `Sherpa: ${state.config.mode}`); ctx.ui.notify("Sherpa enabled", "info"); }});
  pi.registerCommand("sherpa:off", { description: "Disable Sherpa", handler: async (_args, ctx) => { if (!state) state = restoreState(ctx, loadConfig(ctx.cwd)); state.config.enabled = false; saveConfig(ctx.cwd, state.config); ctx.ui.setStatus("ai-sherpa", "Sherpa: off"); ctx.ui.notify("Sherpa disabled", "info"); }});

  pi.registerCommand("sherpa:model", { description: "Choose Sherpa LLM model", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const available = await (ctx.modelRegistry as any).getAvailable?.().catch?.(() => []) ?? [];
    const choices = ["heuristic-only", "use-main-pi-model", ...available.map((m: any) => `${m.provider}/${m.id}`)];
    const picked = await ctx.ui.select("Sherpa model", choices);
    if (!picked) return;
    state.config.model.heuristicOnly = picked === "heuristic-only";
    state.config.model.useMainPiModel = picked === "use-main-pi-model";
    if (!state.config.model.heuristicOnly && !state.config.model.useMainPiModel) { const [provider, ...rest] = picked.split("/"); state.config.model.provider = provider; state.config.model.id = rest.join("/"); }
    saveConfig(ctx.cwd, state.config); persist(); ctx.ui.notify(`Sherpa model: ${picked}`, "info");
  }});

  // ─── Sherpa Preserve Tool ────────────────────────────────────────────
  // Routes a reflection to the right memory destination.
  // Sherpa's memory backend is implemented in TypeScript under lib/memory.ts.

  const SHERPA_MEMORY_DIR = path.join(path.dirname(__filename), "memory");
  const countMd = (dir: string) => {
    try { return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".md")).length : 0; }
    catch { return 0; }
  };

  pi.registerCommand("sherpa:memory:status", { description: "Show Sherpa memory status", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const projectScratchpad = getProjectKBBasedir(ctx.cwd);
    const obsidianMemory = obsidianMemoryPath(state);
    const lines = [
      "## Sherpa Memory Status",
      "",
      `Sherpa memory dir: ${SHERPA_MEMORY_DIR}`,
      `Project scratchpad: ${projectScratchpad}`,
      `Obsidian vault: ${obsidianVaultPath(state!)}`,
      `Obsidian memory: ${obsidianMemory}`,
      "",
      `Global fallback facts: ${countMd(path.join(SHERPA_MEMORY_DIR, ".l2_facts"))}`,
      `Global fallback skills: ${countMd(path.join(SHERPA_MEMORY_DIR, ".l3_skills"))}`,
      `Project scratchpad todos: ${countMd(path.join(projectScratchpad, "scratchpad", "sections"))}`,
      `Obsidian wiki systems: ${countMd(path.join(obsidianMemory, "wiki", "systems"))}`,
      `Obsidian wiki procedures: ${countMd(path.join(obsidianMemory, "wiki", "procedures"))}`,
      `Obsidian wiki decisions: ${countMd(path.join(obsidianMemory, "wiki", "decisions"))}`,
      `Obsidian wiki concepts: ${countMd(path.join(obsidianMemory, "wiki", "concepts"))}`,
      `Obsidian wiki evidence: ${countMd(path.join(obsidianMemory, "wiki", "evidence"))}`,
      `Obsidian journal: ${countMd(path.join(obsidianMemory, "journal"))}`,
      `Obsidian inbox: ${countMd(path.join(obsidianMemory, "inbox"))}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  }});

  pi.registerCommand("sherpa:checkpoint", { description: "Write project working-context and daily session checkpoint to repo-local scratchpad", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const text = args?.trim() || await ctx.ui.input("Sherpa Checkpoint", "What should be checkpointed?");
    if (!text) return;
    const now = new Date().toISOString();
    const day = todayIsoDate();
    const entry = [
      `\n## ${now}`,
      "",
      text.trim(),
      "",
      `Repo: ${ctx.cwd}`,
    ].join("\n");
    const daily = appendScratchpad(state, ctx.cwd, `sessions/daily/${day}.md`, entry);
    const working = writeScratchpad(state, ctx.cwd, "working-context.md", [
      `# Working Context — ${path.basename(ctx.cwd) || "Project"}`,
      "",
      `Updated: ${now}`,
      "",
      "## Current context",
      "",
      text.trim(),
      "",
      "## Last checkpoint",
      "",
      `- Daily log: ${path.relative(scratchpadRootPath(state, ctx.cwd), daily)}`,
    ].join("\n"));
    ctx.ui.notify(`Sherpa checkpoint saved: ${path.relative(scratchpadRootPath(state, ctx.cwd), working)} + ${path.relative(scratchpadRootPath(state, ctx.cwd), daily)}`, "info");
  }});

  pi.registerCommand("sherpa:mistake", { description: "Record a structured project mistake/improvement note to Obsidian", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const text = args?.trim() || await ctx.ui.input("Sherpa Mistake", "What went wrong and how should we prevent it?");
    if (!text) return;
    const now = new Date().toISOString();
    const entry = [
      `\n## ${now}`,
      "",
      text.trim(),
      "",
      "### Prevention",
      "- Review this before similar future work.",
    ].join("\n");
    const target = appendScratchpad(state, ctx.cwd, "mistakes.md", entry);
    appendScratchpad(state, ctx.cwd, `sessions/daily/${todayIsoDate()}.md`, `\n## Mistake noted — ${now}\n\n${text.trim()}\n`);
    ctx.ui.notify(`Sherpa mistake saved: ${path.relative(scratchpadRootPath(state, ctx.cwd), target)}`, "info");
  }});

  pi.registerCommand("sherpa:session-search", { description: "Search past sessions via FTS5: /sherpa:session-search <query> [limit]", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const parts = (args ?? "").trim().split(/\s+(?=\d+$)/);
    const query = parts.length > 1 ? parts[0]! : (args ?? "").trim();
    const limit = parts.length > 1 ? parseInt(parts[1]!, 10) : 5;
    if (!query) { ctx.ui.notify("Usage: /sherpa:session-search <query> [limit]", "warning"); return; }
    const indexed = indexSessionLog(undefined, ctx.cwd);
    const results = searchSessions(query, limit, undefined, ctx.cwd);
    const total = getIndexedEntryCount(undefined, ctx.cwd);
    if (!results.length) { ctx.ui.notify(`Session search: no results for "${query}" (${total} entries indexed)`, "info"); return; }
    ctx.ui.notify(
      `Session search: "${query}" (${results.length} matches)\n` +
      results.map((r: SessionSearchMatch, i: number) =>
        `${i + 1}. ${r.sessionId} [${r.ts.slice(0, 19)}] ${r.snippet.slice(0, 80)}`
      ).join("\n"),
      "info"
    );
  }});

  pi.registerCommand("sherpa:nudge", { description: "Save an observation to scratchpad: /sherpa:nudge <target> <content>", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const parts = (args ?? "").trim().match(/^(observation|distill_candidate)\s+(.+)$/s);
    if (!parts) { ctx.ui.notify("Usage: /sherpa:nudge observation|distill_candidate <content>", "warning"); return; }
    const target = parts[1] as NudgeTarget;
    const content = parts[2]!.trim();
    const root = scratchpadRootPath(state, ctx.cwd);
    const result = writeNudge(target, content, { scratchpadRoot: root });
    const msg: string[] = [];
    if (result.written) msg.push("✅ Written");
    if (result.deduped) msg.push("⏭ Skipped (exact duplicate)");
    if (result.nearDuplicate) msg.push("⚠ Near-duplicate");
    if (result.capacityWarning) msg.push(`📊 ${result.capacityWarning}`);
    if (result.autoCompacted) msg.push("📦 Auto-compacted");
    ctx.ui.notify(msg.join(" | "), "info");
  }});

  pi.registerCommand("sherpa:auto-distill:status", { description: "Show auto-distillation status", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const root = scratchpadRootPath(state, ctx.cwd);
    const status = getAutoDistillStatus({ scratchpadRoot: root, enabled: state.config.enabled });
    ctx.ui.notify(
      `Auto-distill: ${status.enabled ? "on" : "off"}${status.suppressed ? " (suppressed)" : ""}`,
      status.enabled ? "info" : "warning"
    );
  }});

  pi.registerCommand("sherpa:settings", { description: "Configure Sherpa", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const picked = await ctx.ui.select("Sherpa setting", ["mode:auto", "mode:explicit", "mode:proactive", "mode:off", "toggle front-door", "toggle proactive", "choose model"]);
    if (!picked) return;
    if (picked.startsWith("mode:")) { state.config.mode = picked.slice(5) as Mode; state.config.enabled = state.config.mode !== "off"; }
    if (picked === "toggle front-door") state.config.frontDoor.enabled = !state.config.frontDoor.enabled;
    if (picked === "toggle proactive") state.config.proactive.enabled = !state.config.proactive.enabled;
    saveConfig(ctx.cwd, state.config); ctx.ui.setStatus("ai-sherpa", `Sherpa: ${state.config.enabled ? state.config.mode : "off"}`);
    if (picked === "choose model") pi.sendUserMessage("/sherpa:model", { deliverAs: "followUp" }); else ctx.ui.notify("Sherpa settings saved", "info");
  }});
}
