import type { UserMessage } from "@mariozechner/pi-ai";
import { addDocCandidates, addSessionCandidates } from "./lib/basic-candidate-sources";
import { candidateSortKey, postProcessCandidates } from "./lib/candidate-postprocess";
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
} from "./lib/automation";
import type { AutomationState } from "./lib/automation";
import { graphifyAllowedForQuery, graphifyGraphPath, searchGraphify } from "./lib/graphify-search";
import { gitChanged } from "./lib/git-status";
import { getProjectKBBasedir } from "./lib/project-kb";
import {
  createBundleId,
  getBundle,
  readQualitySummary,
  readRecentEvaluations,
  stashContextBundle,
  summarizeEvaluations,
  writeEvaluation,
  writeQualitySummary,
  type ContextBundleRecord,
  type ContextEvaluation,
} from "./lib/evaluation";
import { defaultEvaluationReflection, evaluationImprovementHint, formatEvaluationSummary, parseEvaluationArgs } from "./lib/evaluation-command";
import { exportDspyDataset, readCompiledPrompt, readDspyTraces, summarizeDspyTraces } from "./lib/dspy";
import { recordDspyTrace } from "./lib/dspy-trace-recording";
import { contextCompilerManifest, contextCompilerMessage, parseCompiledContextItems, parseCurationRejected, preserveExpandHint, type RejectionManifestItem } from "./lib/context-compiler";
import { buildContextSignal } from "./lib/context-signal";
import { inferTaskType, whyItemMatters } from "./lib/context-signal-helpers";
import { routeSkipsPath } from "./lib/doc-discovery";
import { addExplicitPathCandidates, pathSourceLabel } from "./lib/exact-source";
import { labelRgSource, latestTraceFiles, readSnippetAround, traceFileStats } from "./lib/file-snippet";
import { getSherpaModelAuth, getSherpaModelAuthWithReason, notifySherpaModelFallback } from "./lib/model-auth";
import { completeJsonObjectWithTimeout, llmSummarize, timeoutAfter } from "./lib/model-completion";
import { configDiff, isPlainObject, mergeConfig, todayIsoDate, type DeepPartial } from "./lib/config-merge";
import { heuristicCurateResult, pickFinalContextItems, shouldAbstain } from "./lib/context-selection";

import { compactScratchpad, classifyTaskOutcome, suggestVerificationCommands } from "./lib/lifecycle";
import { applyEvaluationFeedbackToCandidates, applyReflectionModelOutput, evaluatePostTaskContext } from "./lib/post-task-evaluation";
import { isGloballyNoisySource } from "./lib/noise-filter";
import { allowsRepeatedMetaDebugContext, isCodePrompt, isPiSherpaMetaDebugPrompt, isSourceLookupPrompt, isTraceLogMetricsPrompt } from "./lib/query-classifier";
import { extractQueryTarget } from "./lib/query-target";
import { applyConditionalSourceActivation } from "./lib/source-activation";
import { fileSnippetAllowed, focusAllowsGitStatus, focusAllowsHistoricalMemory, focusAllowsPackageManifest, focusAllowsResearchMemory, isGenericNoiseSource, isHistoricalMemorySource, isPackageManifestSource, isRootReadmeSource, isStickyGenericSnippet, permitsRootReadme } from "./lib/source-guards";
import { extractJsonArray } from "./lib/json-utils";
import { collectRecentTaskFileEvidence, extractMentionedRepoFiles } from "./lib/repo-file-evidence";
import { approxTokens, conciseSummary, isTrivial, score, summarize } from "./lib/text-utils";
import { safeNotify, toolErrorResult } from "./lib/tool-results";
import type { ContextSignalV1, SuggestedCommand } from "./lib/context-types";
import { extractUrls } from "./lib/url-utils";
import { searchWebForState } from "./lib/web-search";
export { isGloballyNoisySource }; // re-export so tests/global-noise.test.ts (imports from ../index) keep working
export { isPiSherpaMetaDebugPrompt, isTraceLogMetricsPrompt }; // re-export so tests/golden-retrieval.test.ts keep working
import { runModelSearchLoop, modelStepMessage, type SearchTool, type ModelStep, type ModelSearchCandidate } from "./lib/model-search";
import { makeFileFinderTool, makeMemorySearchTool } from "./lib/model-search-tools";

import { indexSherpaMemory, searchSherpaMemory, closeSherpaMemoryIndexes } from "./lib/memory-index";
import { indexSessionLog, searchSessions, loadSession, listSessions, getIndexedEntryCount, closeSessionDb } from "./lib/session-search";
import type { SessionSearchMatch } from "./lib/session-search";
import { writeNudge } from "./lib/nudge";
import type { NudgeTarget } from "./lib/nudge";
import { ensureRouteMap } from "./lib/route-map";
import { searchSemble } from "./lib/semble";
import { parseRgOutput, rg } from "./lib/rg";
import { catalogMatches, readGlobalTaxonomy } from "./lib/catalog";
import { addCurrentProjectMemory, addOntologyFallbackMemory, addOtherProjectMemory, addResearchMemory, addTaxonomyMemory } from "./lib/project-memory-readers";
import { parseGitStatusFiles } from "./lib/common";
import { focusAllowsGenericSource, genericSourceClass } from "./lib/generic-source";
import type { RoutePlan } from "./lib/route-map";
import { matchRoutePlan } from "./lib/route-match";
import { applySessionUsageFeedback } from "./lib/retrieval-feedback";
import { filterAlreadySeenSources, itemAlreadySeen, previouslyShownSourceSet, sessionText } from "./lib/session-novelty";
import { bundleMarkdown } from "./lib/signal-render";
import { extractSearchTerms, heuristicIndicators, heuristicSourcePlan, normalizeSources, parsePlannedIndicators, parseSourcePlan, sourcePlanningMessage } from "./lib/source-planning";
export { conciseSummary }; // re-export so tests/golden-retrieval.test.ts keep working
export { postProcessCandidates }; // re-export so tests/golden-retrieval.test.ts keep working
export { extractQueryTarget }; // re-export so tests/golden-retrieval.test.ts keep working
export { parseCompiledContextItems }; // re-export so tests/golden-retrieval.test.ts keep working
export { heuristicSourcePlan }; // re-export so tests/source-plan.test.ts and golden tests keep working
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
type Source = "files" | "git" | "docs" | "session" | "web" | "logs" | "project_memory" | "semble" | "graphify";

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
  plannerReason?: string;
};
type ContextBundle = { bundleId: string; taskId: string; focus: string; mode: string; budgetUsedTokens: number; items: ContextItem[]; candidateCount?: number; sourcePlan?: SourcePlan; signal?: ContextSignalV1 };

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
  evaluationHashes: string[];
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
  sources: { files: true, git: true, docs: true, session: true, web: false, logs: false, project_memory: true, semble: true, graphify: true },
  privacy: { allowNetwork: false, allowRemoteModel: false },
  model: { provider: "olmx", id: "Qwen3.6-35B-A3B-4bit", useMainPiModel: false, heuristicOnly: false, fallbackToHeuristics: true },
  summarization: { maxToolResultChars: 12000, replacementBudget: 1500 },
  memory: { obsidianVault: "/Users/kamil/Documents/articles", obsidianMemoryPath: "projects/project", scratchpadPath: ".pi-memory/scratchpad" },
  web: { enabled: false, provider: "brave", apiKeyEnv: "BRAVE_SEARCH_API_KEY", maxResults: 5, timeoutMs: 5000, cacheTtlMs: 6 * 60 * 60 * 1000 },
  semble: { enabled: true, command: "semble", topK: 8, timeoutMs: 3000 },
  graphify: { enabled: true, command: "graphify", graphPath: "graphify-out/graph.json", timeoutMs: 1200, budgetTokens: 1200, maxLines: 24 },
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
function globalConfigPath() { return path.join(homedir(), ".pi", "sherpa.config.json"); }
function defaultConfigForCwd(cwd: string): SherpaConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.obsidianMemoryPath = projectMemoryRel(cwd);
  return cfg;
}
function readConfigPatch(p: string): DeepPartial<SherpaConfig> | undefined {
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return undefined; }
}
function loadBaseConfig(cwd: string): SherpaConfig {
  return mergeConfig(defaultConfigForCwd(cwd), readConfigPatch(globalConfigPath()));
}
function loadConfig(cwd: string): SherpaConfig {
  return mergeConfig(loadBaseConfig(cwd), readConfigPatch(configPath(cwd)));
}
function saveConfig(cwd: string, cfg: SherpaConfig) {
  const p = configPath(cwd); mkdirSync(path.dirname(p), { recursive: true });
  const projectPatch = configDiff(loadBaseConfig(cwd), cfg) ?? {};
  writeFileSync(p, JSON.stringify(projectPatch, null, 2) + "\n");
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

const SHERPA_UI_KEY = "ai-sherpa";
const SHERPA_LEGACY_UI_KEY = "ai-sherpa-progress";
const SHERPA_CONTEXT_TYPE = "sherpa-context";
const CURATION_TIMEOUT_MS = 12_000;
const FINAL_QUALITY_TIMEOUT_MS = 20_000;
const SOURCE_PLANNER_TIMEOUT_MS = 12_000;
const DSPY_COMPILE_MIN_EVALUATIONS = 10;
const DSPY_COMPILE_MIN_AVG_METRIC = 0.65;
const DSPY_COMPILE_MIN_HIGH_EXAMPLES = 3;

function heuristicOrderCandidates(candidates: ContextItem[], focus: string, mode: string) {
  return postProcessCandidates(candidates, focus, mode);
}

async function inferSearchIndicators(state: State, ctx: ExtensionContext, focus: string): Promise<SearchIndicators> {
  // Stage 1: model infers which unique technical identifiers would appear in relevant context.
  // Runs ONCE per request and feeds into all subsequent searches.
  if (state.config.model.heuristicOnly) {
    return { indicators: heuristicIndicators(focus), reason: "heuristic extraction", confidence: 0.3, planner: "heuristic" };
  }
  const modelAuth = await getSherpaModelAuthWithReason(state, ctx);
  if (!modelAuth.ok) {
    notifySherpaModelFallback(ctx, modelAuth.reason);
    return { indicators: heuristicIndicators(focus), reason: `${modelAuth.reason}, falling back`, confidence: 0.3, planner: "heuristic" };
  }
  const { model, auth } = modelAuth.value;
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
    const result = await completeJsonObjectWithTimeout(state, ctx, model, auth, message, SOURCE_PLANNER_TIMEOUT_MS, "indicator inference timed out");
    if (result.aborted) {
      notifySherpaModelFallback(ctx, "indicator inference aborted");
      return { indicators: heuristicIndicators(focus), reason: "model aborted, falling back", confidence: 0.2, planner: "heuristic" };
    }
    const parsed = result.parsed as any;
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
    notifySherpaModelFallback(ctx, "indicator inference returned invalid JSON");
    return { indicators: heuristicIndicators(focus), reason: "model returned invalid JSON, falling back", confidence: 0.2, planner: "heuristic" };
  } catch (error) {
    notifySherpaModelFallback(ctx, `indicator inference error: ${error instanceof Error ? error.message : String(error)}`);
    return { indicators: heuristicIndicators(focus), reason: "model error, falling back", confidence: 0.2, planner: "heuristic" };
  }
}

function heuristicSearchIndicators(focus: string): SearchIndicators {
  return { indicators: heuristicIndicators(focus), reason: "heuristic", confidence: 0.3, planner: "heuristic" };
}

function routedFallbackPlan(state: State, ctx: ExtensionContext, focus: string, mode: string, routePlan?: RoutePlan): SourcePlan {
  const fallbackPlan = { ...heuristicSourcePlan(focus, mode), routePlan };
  if (routePlan) {
    fallbackPlan.sources = normalizeSources([...fallbackPlan.sources, ...(routePlan.read.length ? ["files"] : []), ...(routePlan.docs.length ? ["docs"] : [])], mode);
    fallbackPlan.reason = `route ${routePlan.name}: ${fallbackPlan.reason}`;
    fallbackPlan.confidence = Math.max(fallbackPlan.confidence, 0.8);
  }
  fallbackPlan.sources = applyConditionalSourceActivation(state, focus, mode, fallbackPlan.sources);
  return fallbackPlan;
}

function parsePlannedSourcePlan(state: State, focus: string, mode: string, parsed: any, routePlan?: RoutePlan): SourcePlan | null {
  if (!parsed?.sources) return null;
  const sourcePlan = parseSourcePlan(JSON.stringify(parsed.sources), mode);
  if (!sourcePlan?.sources.length) return null;
  const mergedSources = normalizeSources([...sourcePlan.sources, ...(routePlan?.read.length ? ["files"] : []), ...(routePlan?.docs.length ? ["docs"] : [])], mode);
  return { ...sourcePlan, sources: applyConditionalSourceActivation(state, focus, mode, mergedSources), routePlan };
}

async function planSources(state: State, ctx: ExtensionContext, focus: string, mode: string, sourceOverride?: string[]): Promise<{ sourcePlan: SourcePlan; indicators: SearchIndicators }> {
  const routePlan = matchRoutePlan(state, ctx.cwd, focus, mode);
  const overridden = normalizeSources(sourceOverride, mode);
  if (overridden.length) return { sourcePlan: { sources: overridden, reason: "explicit source override", confidence: 1, planner: "override", routePlan }, indicators: await inferSearchIndicators(state, ctx, focus) };

  const fallbackPlan = routedFallbackPlan(state, ctx, focus, mode, routePlan);
  const heuristicInds = heuristicSearchIndicators(focus);
  if (state.config.model.heuristicOnly) {
    return { sourcePlan: { ...fallbackPlan, planner: "fallback", reason: `planner skipped: model.heuristicOnly=true; ${fallbackPlan.reason}` }, indicators: heuristicInds };
  }
  if (mode !== "front-door" && mode !== "explicit") return { sourcePlan: { ...fallbackPlan, planner: "fallback", reason: `planner skipped: mode=${mode}; ${fallbackPlan.reason}` }, indicators: heuristicInds };

  const modelAuth = await getSherpaModelAuthWithReason(state, ctx);
  if (!modelAuth.ok) {
    notifySherpaModelFallback(ctx, modelAuth.reason);
    return { sourcePlan: { ...fallbackPlan, planner: "fallback", reason: `planner skipped: ${modelAuth.reason}; ${fallbackPlan.reason}` }, indicators: { ...heuristicInds, reason: `${modelAuth.reason}; ${heuristicInds.reason}` } };
  }
  const { model, auth } = modelAuth.value;

  try {
    const result = await completeJsonObjectWithTimeout(state, ctx, model, auth, sourcePlanningMessage(focus), SOURCE_PLANNER_TIMEOUT_MS, "source + indicator planning timed out");
    if (result.aborted) {
      notifySherpaModelFallback(ctx, "source planner aborted");
      return { sourcePlan: { ...fallbackPlan, planner: "fallback", reason: `planner aborted; ${fallbackPlan.reason}` }, indicators: heuristicInds };
    }
    if (!result.parsed) {
      notifySherpaModelFallback(ctx, "source planner returned invalid JSON");
      return { sourcePlan: { ...fallbackPlan, planner: "fallback", reason: `planner invalid JSON; ${fallbackPlan.reason}` }, indicators: heuristicInds };
    }
    const parsed = result.parsed as any;
    const indicators = parsePlannedIndicators(parsed, heuristicInds);
    const sourcePlan = parsePlannedSourcePlan(state, focus, mode, parsed, routePlan);
    if (!sourcePlan) notifySherpaModelFallback(ctx, "source planner returned unusable source plan");
    return { sourcePlan: sourcePlan ?? { ...fallbackPlan, planner: "fallback", reason: `planner returned invalid source plan; ${fallbackPlan.reason}` }, indicators };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifySherpaModelFallback(ctx, `source planner error: ${message}`);
    return { sourcePlan: { ...fallbackPlan, planner: "fallback", reason: `planner error: ${message}; ${fallbackPlan.reason}` }, indicators: heuristicInds };
  }
}


const PROJECT_DOMAIN = "pi coding agent, Sherpa context retrieval, file operations, bash commands, "
  + "pi extensions, pi skills, Sherpa memory, Obsidian knowledge bases, coding tasks, "
  + "alphabot trading strategies, backtesting, and workspace operations.";

// Directive: whatever Sherpa delivers must be filtered by the sidecar model before
// reaching the main model. Under R1+R2, heuristic abstention without the model forces
// the main model to search itself — the exact accidental-data pollution Sherpa exists
// to prevent. So when the deterministic prefilter empties the pool but raw candidates
// exist, the model still filters them rather than heuristic-abstaining. Only a truly
// empty search (zero raw candidates) bypasses the model: it cannot manufacture context
// that was never found.
export function resolveModelFilterPool(filteredPool: ContextItem[], candidates: ContextItem[]): ContextItem[] | undefined {
  if (filteredPool.length) return filteredPool;
  if (candidates.length) return [...candidates].sort((a, b) => b.relevance - a.relevance).slice(0, 12);
  return undefined;
}

async function compileContextWithModel(state: State, ctx: ExtensionContext, focus: string, mode: string, candidates: ContextItem[]): Promise<CurateResult> {
  const pool = resolveModelFilterPool(postProcessCandidates(candidates, focus, mode).slice(0, 12), candidates);
  if (!pool) return { items: [], abstain: true, abstainReason: "no candidates found by any source", rejected: [], confidence: 0.3, planner: "heuristic", plannerReason: "empty search — no candidates for the sidecar model to filter" };

  const fallback = () => {
    const items = filterAlreadySeenSources(ctx, pool, state).slice(0, 3);
    if (items.length) return heuristicCurateResult(items, 0.25, "context compiler fallback: deterministic prefilter + novelty");
    if (allowsRepeatedMetaDebugContext(focus)) {
      return heuristicCurateResult(pool.slice(0, 3), 0.22, "context compiler fallback: meta/debug exact-source context already in session, repeated instead of abstaining");
    }
    return { items: [], abstain: true, abstainReason: "deterministic novelty filter removed all context", rejected: [], confidence: 0.25, planner: "heuristic" as const, plannerReason: "context compiler fallback" };
  };

  if (state.config.model.heuristicOnly) {
    return fallback();
  }
  const modelAuth = await getSherpaModelAuthWithReason(state, ctx);
  if (!modelAuth.ok) {
    notifySherpaModelFallback(ctx, `context compiler skipped: ${modelAuth.reason}`);
    return fallback();
  }

  try {
    const { model, auth } = modelAuth.value;
    const result = await completeJsonObjectWithTimeout(state, ctx, model, auth, contextCompilerMessage(ctx, state, focus, mode, pool), FINAL_QUALITY_TIMEOUT_MS, "context compiler timed out");
    if (result.aborted) {
      notifySherpaModelFallback(ctx, "context compiler aborted");
      return fallback();
    }
    if (!result.parsed) {
      notifySherpaModelFallback(ctx, "context compiler returned invalid JSON");
      return fallback();
    }
    const parsed = result.parsed as any;
    const selected = parseCompiledContextItems(parsed, pool.length);
    if (parsed.abstain === true || !selected.length) {
      const reason = String(parsed.reason ?? "context compiler abstained").slice(0, 240);
      const rejected = parseCurationRejected(parsed, contextCompilerManifest(ctx, pool, focus, mode, state) as any);
      if (allowsRepeatedMetaDebugContext(focus) && /already[_\s-]?in[_\s-]?session|novel|known|repeat/i.test(reason + " " + rejected.map((r) => r.reason).join(" "))) {
        return heuristicCurateResult(pool.slice(0, 3), 0.22, "context compiler novelty fallback for meta/debug lookup");
      }
      return { items: [], abstain: true, abstainReason: reason, rejected, confidence: Math.max(0.1, Math.min(1, Number(parsed.confidence ?? 0.7))), planner: "llm", plannerReason: reason };
    }
    const compiled = selected.map(({ index, summary }) => {
      const item = pool[index];
      return summary ? { ...item, summary: preserveExpandHint(summary, item.summary, item.handle), inline: false } : item;
    });
    const processedCompiled = postProcessCandidates(compiled, focus, mode);
    const guarded = filterAlreadySeenSources(ctx, processedCompiled, state).slice(0, 3);
    if (!guarded.length && allowsRepeatedMetaDebugContext(focus) && processedCompiled.length) {
      return heuristicCurateResult(processedCompiled.slice(0, 3), 0.22, "context compiler guardrail novelty fallback for meta/debug lookup");
    }
    if (!guarded.length) return { items: [], abstain: true, abstainReason: "deterministic guardrails removed compiler output", rejected: [], confidence: 0.5, planner: "llm", plannerReason: "context compiler output failed guardrails" };
    return { items: guarded, abstain: false, abstainReason: "", rejected: parseCurationRejected(parsed, contextCompilerManifest(ctx, pool, focus, mode, state) as any), confidence: Math.max(0.1, Math.min(1, Number(parsed.confidence ?? 0.7))), planner: "llm", plannerReason: String(parsed.reason ?? "context compiler selected compact context").slice(0, 240) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifySherpaModelFallback(ctx, `context compiler error: ${message}`);
    return fallback();
  }
}

// ── Escalation tier: model-driven search loop ─────────────────────────────
// When the deterministic fast path yields no candidates, hand control to the
// sidecar model with a small toolset so it can BROADEN the research — searching
// places/queries the deterministic pass cannot (e.g. ~/.pi dotfiles that rg is
// guardrailed away from). The model is the delivery gate; the loop only gathers.

// Tool: find files by name/glob within scoped safe roots. This is the capability
// the deterministic path lacks — rg refuses $HOME, so config files like
// ~/.pi/agent/models.json are invisible to it. The model picks the pattern.
function makeModelStepRunner(state: State, ctx: ExtensionContext, timeoutMs = 8000) {
  return async (_transcript: string, toolsDescription: string): Promise<ModelStep | undefined> => {
    const modelAuth = await getSherpaModelAuthWithReason(state, ctx);
    if (!modelAuth.ok) return { action: "stop", reason: `no sidecar model: ${modelAuth.reason}` };
    const { model, auth } = modelAuth.value;
    const result = await completeJsonObjectWithTimeout(state, ctx, model, auth, modelStepMessage(_transcript, toolsDescription), timeoutMs, "model search step timed out");
    if (result.aborted || !result.parsed) return undefined;
    const p = result.parsed as any;
    if (p.action === "search") return { action: "search", tool: String(p.tool ?? ""), query: String(p.query ?? ""), reason: String(p.reason ?? "") };
    if (p.action === "deliver") return { action: "deliver", items: Array.isArray(p.items) ? p.items.map((i: any) => ({ source: String(i.source ?? ""), summary: String(i.summary ?? "") })) : [], reason: String(p.reason ?? "") };
    return { action: "stop", reason: String(p.reason ?? "unknown action") };
  };
}

async function escalateToModelSearch(state: State, ctx: ExtensionContext, focus: string, indicators: SearchIndicators): Promise<ContextItem[]> {
  if (state.config.model.heuristicOnly) return [];
  const tools: Record<string, SearchTool> = {
    find_file: makeFileFinderTool(ctx),
    search_memory: makeMemorySearchTool(),
  };
  const result = await runModelSearchLoop({
    focus,
    tools,
    modelStep: makeModelStepRunner(state, ctx),
    budget: { maxRounds: 3, maxToolCalls: 4 },
  });
  return result.candidates.map((c) => ({
    handle: `ctx-${state.nextHandle++}`,
    type: "model_search",
    source: c.source,
    relevance: c.relevance,
    summary: c.summary,
    inline: false,
  }));
}

async function runDspyPromptCompile(cwd: string) {
  const scriptPath = path.join(path.dirname(__filename), "scripts", "optimize-sherpa-dspy.py");
  const projectPrompt = path.join(cwd, ".pi", "sherpa", "prompts", "RETRIEVAL.md");
  const basePrompt = existsSync(projectPrompt) ? projectPrompt : path.join(path.dirname(__filename), "prompts", "RETRIEVAL.md");
  const candidateDir = path.join(".pi", "sherpa", "compiled-candidates");
  const result = await execFileAsync("python3", [scriptPath, "--base-prompt", basePrompt, "--out-dir", candidateDir], { cwd, timeout: 120_000, maxBuffer: 1_000_000 });
  return { ...result, candidateDir };
}

function createEmptyContextBundle(state: State, focus: string, mode: string, candidates: ContextItem[], sourcePlan: SourcePlan): ContextBundle {
  state.bundles++;
  const bundle: ContextBundle = {
    bundleId: createBundleId(),
    taskId: `sherpa-${Date.now()}`,
    focus,
    mode,
    budgetUsedTokens: 0,
    items: [],
    candidateCount: candidates.length,
    sourcePlan,
  };
  bundle.signal = buildContextSignal(bundle);
  stashContextBundle(state, bundle);
  return bundle;
}

type AddContextItem = (type: string, source: string, raw: string, relBoost?: number) => void;

function normalizedName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mentionedPiExtensionRoots(focus: string): Array<{ name: string; root: string }> {
  const extensionRoot = path.dirname(__filename);
  const extensionsDir = path.dirname(extensionRoot);
  if (!existsSync(extensionsDir)) return [];
  const focusLower = focus.toLowerCase();
  const compactFocus = normalizedName(focus);
  const out: Array<{ name: string; root: string }> = [];
  for (const name of readdirSync(extensionsDir).slice(0, 120)) {
    const root = path.join(extensionsDir, name);
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch { continue; }
    const aliases = [name, name.replace(/^pi-/, "")].filter((alias) => alias.length >= 4);
    if (aliases.some((alias) => focusLower.includes(alias.toLowerCase()) || compactFocus.includes(normalizedName(alias)))) {
      out.push({ name, root });
    }
  }
  return out.slice(0, 4);
}

function addRuntimeTraceCandidates(ctx: ExtensionContext, focus: string, add: AddContextItem) {
  if (!isTraceLogMetricsPrompt(focus)) return;
  const traceDir = path.join(ctx.cwd, ".pi-memory", "sherpa-traces");
  if (!existsSync(traceDir)) return;
  const files = latestTraceFiles(traceDir);
  add("sherpa_trace_location", pathSourceLabel(traceDir, ctx.cwd), [
    "Sherpa retrieval traces are written under the active cwd, not necessarily under the pi-sherpa extension checkout.",
    `Active trace directory: ${traceDir}`,
    files.length ? "Recent trace files:" : "No trace jsonl files found.",
    ...files.map((file) => traceFileStats(traceDir, file)),
  ].join("\n"), 0.88);
}

function addPiSherpaDebugSourceCandidates(ctx: ExtensionContext, focus: string, root: string, add: AddContextItem) {
  if (!isPiSherpaMetaDebugPrompt(focus)) return;
  const dspyPath = path.join(root, "lib", "dspy.ts");
  const indexPath = path.join(root, "index.ts");
  if (isTraceLogMetricsPrompt(focus) && existsSync(dspyPath)) {
    const raw = readSnippetAround(dspyPath, ["dspyTraceDir", "writeDspyTrace", "readDspyTraces", "summarizeDspyTraces"]);
    if (raw) add("file", pathSourceLabel(dspyPath, ctx.cwd), raw, 0.82);
  }
  if (existsSync(indexPath)) {
    const raw = readSnippetAround(indexPath, ["recordDspyTrace", "buildBundle", "compileContextWithModel", "planSources"]);
    if (raw) add("file", pathSourceLabel(indexPath, ctx.cwd), raw, 0.66);
  }
}

async function addPiExtensionCandidates(ctx: ExtensionContext, focus: string, indicators: SearchIndicators, add: AddContextItem) {
  const roots = mentionedPiExtensionRoots(focus);
  for (const { name, root } of roots) {
    const keyFiles = ["README.md", "package.json", "index.ts", "SHERPA_SYSTEM.md", "lib/dspy.ts"]
      .filter((file) => existsSync(path.join(root, file)));
    add("pi_extension_route", pathSourceLabel(root, ctx.cwd), [
      `Pi extension route: ${name}`,
      `Root: ${root}`,
      keyFiles.length ? `Key files: ${keyFiles.join(", ")}` : "Key files: none detected",
      isTraceLogMetricsPrompt(focus) ? "Trace logs: active cwd .pi-memory/sherpa-traces/*.jsonl" : "",
    ].filter(Boolean).join("\n"), 0.7);
    addPiSherpaDebugSourceCandidates(ctx, focus, root, add);

    const query = [focus, ...indicators.indicators].join(" ");
    const out = await rg(ctx.cwd, query, root);
    for (const { fileAndLine, content } of parseRgOutput(out, 12)) {
      if (content) add("file", labelRgSource(fileAndLine, ctx.cwd), content, 0.42);
    }
  }
}

async function addRoutedFileCandidates(ctx: ExtensionContext, focus: string, sourcePlan: SourcePlan, add: AddContextItem) {
  for (const rel of sourcePlan?.routePlan?.read ?? []) {
    if (routeSkipsPath(sourcePlan?.routePlan, rel)) continue;
    const p = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        add("file", `repo://${rel}`, readFileSync(p, "utf8").slice(0, 1200), 0.35);
      } else if (existsSync(p) && statSync(p).isDirectory()) {
        const routedOut = await rg(ctx.cwd, focus, p);
        for (const { fileAndLine, content } of parseRgOutput(routedOut, 12)) {
          if (content && !routeSkipsPath(sourcePlan?.routePlan, fileAndLine)) add("file", `repo://${fileAndLine}`, content, 0.3);
        }
      }
    } catch { /* ignore route file */ }
  }
}

async function addIndicatorFileCandidates(ctx: ExtensionContext, mode: string, sourcePlan: SourcePlan, indicators: SearchIndicators, add: AddContextItem) {
  const indicatorText = indicators.indicators.join(" ");
  const out = await rg(ctx.cwd, indicators.indicators);
  for (const { fileAndLine, content } of parseRgOutput(out, 30)) {
    if (!content || routeSkipsPath(sourcePlan?.routePlan, fileAndLine) || !fileSnippetAllowed(fileAndLine, indicatorText, mode)) continue;
    add("file", `repo://${fileAndLine}`, content, 0.15);
  }
}


async function addFileCandidates(ctx: ExtensionContext, focus: string, mode: string, sourcePlan: SourcePlan, indicators: SearchIndicators, add: AddContextItem) {
  addExplicitPathCandidates(ctx.cwd, focus, add);
  addRuntimeTraceCandidates(ctx, focus, add);
  await addPiExtensionCandidates(ctx, focus, indicators, add);
  await addRoutedFileCandidates(ctx, focus, sourcePlan, add);
  await addIndicatorFileCandidates(ctx, mode, sourcePlan, indicators, add);
}

async function addProjectMemoryCandidates(state: State, ctx: ExtensionContext, focus: string, indicators: SearchIndicators, options: { searchOtherProjects?: boolean; includeTaxonomy?: boolean }, add: AddContextItem) {
  const root = obsidianMemoryPath(state);
  const vault = obsidianVaultPath(state);
  const indicatorText = indicators.indicators.join(" ");
  const currentProjectMatches = addCurrentProjectMemory(root, indicatorText, add);
  addResearchMemory(vault, indicatorText, add);
  if (options.searchOtherProjects) addOtherProjectMemory(vault, path.resolve(root), indicatorText, add);
  if (options.includeTaxonomy || /\b(taxonomy|tag|tags|label|labels|category|relationship|nomenclature)\b/i.test(focus)) addTaxonomyMemory(focus, add);
  // If current project catalog is absent or did not match, fall back to current
  // project's semantic ontology folders only. Do not scan legacy bucket folders.
  if (!currentProjectMatches.length) addOntologyFallbackMemory(root, focus, add);
}

async function addSembleCandidates(state: State, ctx: ExtensionContext, focus: string, mode: string, sourcePlan: SourcePlan, indicators: SearchIndicators, add: AddContextItem) {
  const query = [focus, ...indicators.indicators].join(" ").trim();
  const results = await searchSemble(ctx.cwd, query, state.config.semble);
  for (const result of results) {
    if (routeSkipsPath(sourcePlan?.routePlan, result.filePath) || !fileSnippetAllowed(result.filePath, indicators.indicators.join(" "), mode)) continue;
    add("file", `repo://${result.filePath}:${result.startLine}`, result.content, 0.4);
  }
}

function addMemoryIndexCandidates(state: State, ctx: ExtensionContext, focus: string, indicators: SearchIndicators, add: AddContextItem) {
  try {
    const memoryConfig = {
      scratchpadRoot: scratchpadRootPath(state, ctx.cwd),
      catalogRoots: [ctx.cwd, obsidianMemoryPath(state)],
      evaluationRoot: obsidianMemoryPath(state),
    };
    indexSherpaMemory(ctx.cwd, memoryConfig);
    const memoryHits = searchSherpaMemory(ctx.cwd, [focus, ...indicators.indicators].join(" "), 8, memoryConfig);
    for (const hit of memoryHits) {
      add("memory_index", `memory-index://${hit.kind}/${path.relative(ctx.cwd, hit.sourcePath)}`, [
        `Kind: ${hit.kind}`,
        `Title: ${hit.title}`,
        hit.summary ? `Summary: ${hit.summary}` : "",
        `Source: ${hit.sourcePath}`,
        "",
        hit.snippet || hit.summary,
      ].filter(Boolean).join("\n"), 0.24);
    }
  } catch { /* memory index recall is opportunistic */ }
}

async function retryFrontDoorFileCandidates(state: State, ctx: ExtensionContext, focus: string, mode: string, sourcePlan: SourcePlan, candidates: ContextItem[], add: AddContextItem, enabled: (s: Source) => boolean) {
  if (mode !== "front-door" || !enabled("files") || postProcessCandidates(candidates, focus, mode).length !== 0) return;
  if (enabled("semble") && state.config.semble?.enabled) {
    const retrySemble = await searchSemble(ctx.cwd, focus, state.config.semble);
    for (const result of retrySemble.slice(0, 8)) {
      if (routeSkipsPath(sourcePlan?.routePlan, result.filePath) || !fileSnippetAllowed(result.filePath, focus, mode)) continue;
      add("file", `repo://${result.filePath}:${result.startLine}`, result.content, 0.35);
    }
  }
  const retryOut = postProcessCandidates(candidates, focus, mode).length ? "" : await rg(ctx.cwd, focus);
  for (const { fileAndLine, content } of parseRgOutput(retryOut, 16)) {
    if (!content || routeSkipsPath(sourcePlan?.routePlan, fileAndLine) || !fileSnippetAllowed(fileAndLine, focus, mode)) continue;
    add("file", `repo://${fileAndLine}`, content, 0.08);
  }
}

function createContextAdder(state: State, focus: string, candidates: ContextItem[]): AddContextItem {
  return (type: string, source: string, raw: string, relBoost = 0) => {
    if (!raw.trim() || isGloballyNoisySource(source)) return;
    const handle = `ctx-${state.nextHandle++}`;
    const inline = raw.length <= 700 && !type.includes("session");
    const summary = summarize(raw);
    const pointer = inline ? "" : ` (expand with /sherpa:expand ${handle})`;
    const item: ContextItem = { handle, type, source, relevance: Math.min(1, score(raw + " " + source, focus) + relBoost), summary: summary + pointer, raw, inline };
    state.handles.set(handle, item);
    candidates.push(item);
  };
}

function addUrlReferences(state: State, focus: string, add: AddContextItem) {
  const urls = state.config.dedupe?.urls?.enabled ? extractUrls(focus) : (focus.match(/https?:\/\/\S+/g) ?? []);
  for (const url of urls) {
    add("url_reference", url, state.config.privacy.allowNetwork || state.config.sources.web
      ? `User provided URL: ${url}. Sherpa did not fetch it yet; the main agent should fetch/read it with an approved web tool if needed.`
      : `User provided URL: ${url}. Network/web retrieval is disabled in Sherpa privacy settings, so this is passed through as an explicit reference for the main agent.`, 0.9);
  }
}

function retrievalEnabled(state: State, sourcePlan: SourcePlan) {
  return (s: Source) => Boolean(state.config.sources[s]) && sourcePlan.sources.includes(s);
}

function collectRetrievalTasks(state: State, ctx: ExtensionContext, focus: string, mode: string, sourcePlan: SourcePlan, indicators: SearchIndicators, options: { searchOtherProjects?: boolean; includeTaxonomy?: boolean }, add: AddContextItem, enabled: (s: Source) => boolean): Promise<void>[] {
  const tasks: Promise<void>[] = [];
  if (enabled("files")) tasks.push(addFileCandidates(ctx, focus, mode, sourcePlan, indicators, add));
  if (enabled("semble") && state.config.semble?.enabled) tasks.push(addSembleCandidates(state, ctx, focus, mode, sourcePlan, indicators, add));
  if (enabled("graphify") && state.config.graphify?.enabled && graphifyAllowedForQuery(focus)) tasks.push((async () => {
    const raw = await searchGraphify(ctx.cwd, focus, state.config.graphify);
    if (raw) add("graphify_code_graph", `graphify://${path.relative(ctx.cwd, graphifyGraphPath(ctx.cwd, state.config.graphify)) || state.config.graphify.graphPath}`, raw, 0.32);
  })());
  if (enabled("docs")) tasks.push(Promise.resolve().then(() => addDocCandidates(ctx, mode, sourcePlan, indicators, add)));
  if (enabled("git") && focusAllowsGitStatus(focus)) tasks.push((async () => add("git_status", "git://status", await gitChanged(ctx.cwd), 0.05))());
  if (enabled("web")) tasks.push((async () => { for (const r of await searchWebForState(ctx.cwd, state, focus, DEFAULT_CONFIG.web.cacheTtlMs)) add("web_snippet", r.url, `${r.title}\n${r.snippet}`, 0.25); })());
  if (enabled("project_memory")) tasks.push(addProjectMemoryCandidates(state, ctx, focus, indicators, options, add));
  if (enabled("session")) tasks.push(Promise.resolve().then(() => addSessionCandidates(ctx, add)));
  if (enabled("project_memory")) tasks.push(Promise.resolve().then(() => addMemoryIndexCandidates(state, ctx, focus, indicators, add)));
  return tasks;
}

function applyRetrievalFeedback(state: State, focus: string, candidates: ContextItem[]) {
  try {
    const memoryRoot = obsidianMemoryPath(state);
    const recentEvaluations = readRecentEvaluations(memoryRoot, 200);
    const qualitySummary = readQualitySummary(memoryRoot);
    const adjusted = applyEvaluationFeedbackToCandidates(candidates, recentEvaluations, qualitySummary, { focus });
    candidates.splice(0, candidates.length, ...adjusted);
    applySessionUsageFeedback(state, candidates);
    return { recentEvaluations: recentEvaluations.length, qualitySummaryUsed: Boolean(qualitySummary) };
  } catch {
    applySessionUsageFeedback(state, candidates);
    return {};
  }
}

async function buildBundle(state: State, ctx: ExtensionContext, focus: string, mode: string, tokenBudget: number, sourcePlan: SourcePlan, indicators: SearchIndicators, options: { searchOtherProjects?: boolean; includeTaxonomy?: boolean } = {}): Promise<ContextBundle> {
  const enabled = retrievalEnabled(state, sourcePlan);
  const candidates: ContextItem[] = [];
  const add = createContextAdder(state, focus, candidates);

  addUrlReferences(state, focus, add);
  await Promise.allSettled(collectRetrievalTasks(state, ctx, focus, mode, sourcePlan, indicators, options, add, enabled));
  await retryFrontDoorFileCandidates(state, ctx, focus, mode, sourcePlan, candidates, add, enabled);

  const traceFeedback = applyRetrievalFeedback(state, focus, candidates);
  let compileResult = await compileContextWithModel(state, ctx, focus, mode, candidates);

  // Escalation tier: when the deterministic fast path + model filter abstained due to
  // an empty/thin search (not a deliberate model rejection), hand control to the sidecar
  // model with search tools so it can BROADEN the research — e.g. find config files under
  // ~/.pi that rg is guardrailed away from. Then re-compile so the model still gates delivery.
  if (compileResult.abstain && candidates.length === 0 && !state.config.model.heuristicOnly) {
    const searched = await escalateToModelSearch(state, ctx, focus, indicators);
    if (searched.length) {
      for (const item of searched) { state.handles.set(item.handle, item); candidates.push(item); }
      compileResult = await compileContextWithModel(state, ctx, focus, mode, candidates);
    }
  }

  if (compileResult.abstain) {
    const abstainBundle = createEmptyContextBundle(state, focus, mode, candidates, sourcePlan);
    recordDspyTrace(ctx.cwd, abstainBundle, indicators, candidates, compileResult, traceFeedback);
    return abstainBundle;
  }

  const { items, used } = pickFinalContextItems(compileResult.items, tokenBudget);
  state.bundles++;
  const bundle: ContextBundle = { bundleId: createBundleId(), taskId: `sherpa-${Date.now()}`, focus, mode, budgetUsedTokens: used, items, candidateCount: candidates.length, sourcePlan };
  bundle.signal = buildContextSignal(bundle);
  recordDspyTrace(ctx.cwd, bundle, indicators, candidates, compileResult, traceFeedback);
  stashContextBundle(state, bundle);
  return bundle;
}

type PersistedSherpaState = Partial<Pick<State, "nextHandle" | "bundles" | "feedback" | "automation" | "lifecycleHashes" | "evaluationHashes" | "lastBundleId" | "dspyAuto">> & {
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
    evaluationHashes: [],
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
  state.evaluationHashes = Array.isArray(data.evaluationHashes) ? data.evaluationHashes : state.evaluationHashes;
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
    evaluationHashes: state.evaluationHashes,
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
      ctx.ui.setStatus(SHERPA_UI_KEY, `🤵 Sherpa ${action}${subject ? `: ${statusLabel(subject)}` : ""}`);
      return;
    }
    ctx.ui.setStatus(SHERPA_UI_KEY, state?.config.enabled ? `Sherpa: ${state.config.mode}` : "Sherpa: off");
  };

  const startSherpaWorkUi = (ctx: ExtensionContext, focus: string, mode: string) => {
    let phase = "starting";
    let detail = "Preparing retrieval.";
    let finished = false;
    const startedAt = Date.now();
    const render = () => {
      if (!ctx.hasUI) return;
      const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      ctx.ui.setStatus(SHERPA_LEGACY_UI_KEY, undefined);
      ctx.ui.setStatus(SHERPA_UI_KEY, `🤵 Sherpa working ${elapsed}s: ${statusLabel(phase)}`);
      ctx.ui.setWidget(SHERPA_UI_KEY, [
        "🤵 Sherpa is working — Pi is not frozen.",
        `Mode: ${mode}`,
        `Phase: ${phase}`,
        `Elapsed: ${elapsed}s`,
        detail,
        `Focus: ${statusLabel(focus)}`,
      ]);
    };
    render();
    const timer = ctx.hasUI ? setInterval(render, 1000) : undefined;
    return {
      update(nextPhase: string, nextDetail?: string) {
        phase = nextPhase;
        if (nextDetail) detail = nextDetail;
        render();
      },
      done(finalAction?: string) {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        if (!ctx.hasUI) return;
        ctx.ui.setWidget(SHERPA_UI_KEY, undefined);
        if (finalAction) ctx.ui.setStatus(SHERPA_UI_KEY, `🤵 Sherpa ${finalAction}`);
        else setSherpaStatus(ctx);
      },
    };
  };

  const compileDspyCandidate = async (ctx: ExtensionContext, reason: string, notify: boolean, options: { force?: boolean } = {}) => {
    if (!state?.config.dspy.autoCompile.enabled && !options.force) return { ran: false, reason: "auto compile disabled" };
    const cwd = ctx.cwd;
    const limit = 2000;
    const evals = readRecentEvaluations(obsidianMemoryPath(state), limit);
    const exported = exportDspyDataset(cwd, evals, { limit });
    if (exported.traces < state.config.dspy.autoCompile.minTraces) return { ran: false, reason: `need ${state.config.dspy.autoCompile.minTraces} traces; have ${exported.traces}` };
    if (!options.force) {
      if (exported.matchedEvaluations < DSPY_COMPILE_MIN_EVALUATIONS) return { ran: false, reason: `need ${DSPY_COMPILE_MIN_EVALUATIONS} matched evaluations; have ${exported.matchedEvaluations}` };
      if (exported.averageMetric < DSPY_COMPILE_MIN_AVG_METRIC) return { ran: false, reason: `average metric ${exported.averageMetric.toFixed(2)} below ${DSPY_COMPILE_MIN_AVG_METRIC}` };
      if (exported.highScoringExamples < DSPY_COMPILE_MIN_HIGH_EXAMPLES) return { ran: false, reason: `need ${DSPY_COMPILE_MIN_HIGH_EXAMPLES} high-scoring examples; have ${exported.highScoringExamples}` };
    }
    const { stdout } = await runDspyPromptCompile(cwd);
    state.dspyAuto = { lastCompileAt: new Date().toISOString(), lastCompileDate: todayIsoDate(), lastBundleCount: state.bundles };
    persist();
    if (notify) safeNotify(ctx, [`Sherpa DSPy-style prompt-feedback candidate compiled (${reason})`, `traces=${exported.traces}; matched=${exported.matchedEvaluations}; avgMetric=${exported.averageMetric.toFixed(2)}; high=${exported.highScoringExamples}`, `train=${exported.train}; dev=${exported.dev}`, stdout.trim()].filter(Boolean).join("\n"), "info");
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
      if (event !== "bundle") safeNotify(ctx, `Sherpa DSPy auto-compile failed: ${message}`, "warning");
    }
  };

  const runSidecarSmoke = async (ctx: ExtensionContext) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const modelAuth = await getSherpaModelAuthWithReason(state, ctx);
    if (!modelAuth.ok) return { ok: false, lines: [`❌ model auth: ${modelAuth.reason}`] };
    const { model, auth } = modelAuth.value;
    const smokePrompts: Array<{ name: string; message: UserMessage; validate: (parsed: any) => string | undefined }> = [
      {
        name: "source planner",
        message: sourcePlanningMessage("review pi-sherpa context curation quality"),
        validate: (parsed) => parsed?.indicators?.indicators?.length && parsed?.sources?.sources?.length ? undefined : "missing indicators/sources",
      },
      {
        name: "context compiler",
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: [
            "User query: review pi-sherpa context curation quality",
            "Return ONLY JSON selecting useful context from candidates.",
            '{"abstain":false,"items":[{"index":0,"summary":"minimal context","why":"why useful"}],"rejected":[],"reason":"ok"}',
            JSON.stringify([{ index: 0, source: "repo://index.ts:1100", novelty: "new", summary: "compileContextWithModel validates and compacts context" }]),
          ].join("\n") }],
        },
        validate: (parsed) => (parsed?.abstain === true || Array.isArray(parsed?.items)) ? undefined : "missing abstain/items",
      },
      {
        name: "abstain contract",
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: 'Return ONLY JSON: {"abstain":true,"items":[],"reason":"no useful context"}' }],
        },
        validate: (parsed) => parsed?.abstain === true && Array.isArray(parsed?.items) ? undefined : "missing abstain true/items array",
      },
    ];
    const lines = [`✅ model auth: ${model.provider}/${model.id ?? model.name ?? "unknown"}`];
    let ok = true;
    for (const smoke of smokePrompts) {
      const start = Date.now();
      try {
        const result = await completeJsonObjectWithTimeout(state, ctx, model, auth, smoke.message, FINAL_QUALITY_TIMEOUT_MS, `${smoke.name} smoke timed out`);
        const elapsed = Date.now() - start;
        const error = result.aborted ? "aborted" : smoke.validate(result.parsed);
        if (error) { ok = false; lines.push(`❌ ${smoke.name}: ${error} (${elapsed}ms)`); }
        else lines.push(`✅ ${smoke.name}: valid JSON (${elapsed}ms)`);
      } catch (error) {
        ok = false;
        lines.push(`❌ ${smoke.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ok, lines };
  };

  const taskReflectionMessage = (bundle: ContextBundleRecord, evalRecord: ContextEvaluation, outcome: ReturnType<typeof classifyTaskOutcome>, evidence: ReturnType<typeof collectRecentTaskFileEvidence>, referencedFiles: string[], changedFiles: string[], recentText: string): UserMessage => ({
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      "You are Sherpa's post-task reflection evaluator.",
      "Judge whether the Sherpa context helped the main agent complete the user's task.",
      "Use only the structured packet below; do not invent missing tool evidence.",
      "",
      "Return ONLY JSON:",
      '{"outcome":"completed|partial|blocked|failed|unknown","sherpa_context_usefulness":"useful|partial|unused|harmful|not_needed","missed_context":["repo/path.ts"],"noisy_context":["source"],"scores":{"relevance":0.0,"precision":0.0,"recall":0.0},"lesson":"short reusable lesson or empty","should_preserve":false,"improvement_hint":"short routing/scoring hint","reason":"why"}',
      "",
      JSON.stringify({
        focus: bundle.focus,
        deterministicOutcome: outcome,
        shownContext: bundle.items,
        toolEvidence: { ...evidence, referencedFiles, changedFiles },
        deterministicEvaluation: evalRecord,
        finalText: recentText.slice(-1800),
      }, null, 2),
    ].join("\n") }],
  });

  const reflectTaskEvaluationWithModel = async (stateObj: State, ctx: ExtensionContext, bundle: ContextBundleRecord, evalRecord: ContextEvaluation, outcome: ReturnType<typeof classifyTaskOutcome>, evidence: ReturnType<typeof collectRecentTaskFileEvidence>, referencedFiles: string[], changedFiles: string[], recentText: string) => {
    if (stateObj.config.model.heuristicOnly) return { evalRecord, modelUsed: false, reason: "model.heuristicOnly=true" };
    const modelAuth = await getSherpaModelAuthWithReason(stateObj, ctx);
    if (!modelAuth.ok) return { evalRecord, modelUsed: false, reason: modelAuth.reason };
    const { model, auth } = modelAuth.value;
    try {
      const result = await completeJsonObjectWithTimeout(stateObj, ctx, model, auth, taskReflectionMessage(bundle, evalRecord, outcome, evidence, referencedFiles, changedFiles, recentText), 12_000, "task reflection timed out");
      if (result.aborted || !result.parsed) return { evalRecord, modelUsed: false, reason: result.aborted ? "aborted" : "invalid JSON" };
      const parsed = applyReflectionModelOutput(evalRecord, result.parsed);
      return { ...parsed, modelUsed: true, reason: "sidecar reflection applied" };
    } catch (error) {
      return { evalRecord, modelUsed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };


  const recordLifecycleObservation = async (stateObj: State, cwd: string, recentMessages: unknown[]) => {
    const recentText = stringifyForAutoMemory(recentMessages);
    const outcome = classifyTaskOutcome(recentText);
    const status = await gitChanged(cwd);
    const changedFiles = parseGitStatusFiles(status);
    const lifecycleHash = hashAutoMemory(`lifecycle\n${outcome.outcome}\n${changedFiles.sort().join("\n")}`);
    if (!stateObj.lifecycleHashes.includes(lifecycleHash) && (changedFiles.length || outcome.outcome !== "unknown")) {
      const verification = suggestVerificationCommands(changedFiles);
      appendScratchpadSection(stateObj, cwd, "observation", [
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
      stateObj.lifecycleHashes = [...stateObj.lifecycleHashes.slice(-49), lifecycleHash];
    }
    return { recentText, outcome, changedFiles };
  };

  const evaluateRecentBundle = async (stateObj: State, ctx: ExtensionContext, cwd: string, recentMessages: unknown[], recentText: string, outcome: ReturnType<typeof classifyTaskOutcome>, changedFiles: string[]) => {
    try {
      const bundle = stateObj.lastBundleId ? getBundle(stateObj, stateObj.lastBundleId) : undefined;
      if (!bundle || Date.now() - bundle.timestamp >= 2 * 60 * 60 * 1000) return;
      if (stateObj.evaluationHashes.includes(bundle.bundleId)) return;
      const evidence = collectRecentTaskFileEvidence(recentMessages, cwd);
      const referencedFiles = extractMentionedRepoFiles(recentText, cwd);
      const hasTaskSignal = evidence.readFiles.length || evidence.writtenFiles.length || referencedFiles.length || outcome.outcome !== "unknown";
      if (!hasTaskSignal) return;
      const deterministicEval = evaluatePostTaskContext({
        bundle,
        outcome: outcome.outcome,
        files: { ...evidence, referencedFiles, changedFiles },
        finalText: recentText.slice(-2000),
      });
      const reflected = await reflectTaskEvaluationWithModel(stateObj, ctx, bundle, deterministicEval, outcome, evidence, referencedFiles, changedFiles, recentText);
      const evalRecord = reflected.evalRecord;
      stateObj.feedback = [...stateObj.feedback.slice(-49), {
        used: [...new Set([...evidence.readFiles, ...evidence.writtenFiles, ...referencedFiles])].filter((file) => !evalRecord.missed.includes(file)),
        unused: evalRecord.noise,
        missing: evalRecord.missed,
        at: Date.now(),
      }];
      const memoryRoot = obsidianMemoryPath(stateObj);
      const target = writeEvaluation(memoryRoot, evalRecord);
      writeQualitySummary(memoryRoot, readRecentEvaluations(memoryRoot, 200));
      appendScratchpadSection(stateObj, cwd, "observation", [
        `Bundle: ${evalRecord.bundleId}`,
        `Scores: relevance=${evalRecord.scores.relevance} precision=${evalRecord.scores.precision} recall=${evalRecord.scores.recall}`,
        reflected.usefulness ? `Usefulness: ${reflected.usefulness}` : `Usefulness: deterministic-only (${reflected.reason})`,
        evalRecord.noise.length ? `Noise: ${evalRecord.noise.slice(0, 8).join(", ")}` : "Noise: none detected",
        evalRecord.missed.length ? `Missed: ${evalRecord.missed.slice(0, 8).join(", ")}` : "Missed: none detected",
        `Hint: ${evalRecord.improvementHint}`,
        `Stored: ${path.relative(memoryRoot, target)}`,
      ].join("\n"), "Sherpa retrieval evaluation");
      if (reflected.shouldPreserve && reflected.lesson) {
        appendScratchpadSection(stateObj, cwd, "distill_candidate", reflected.lesson, "Sherpa reflection lesson");
      }
      stateObj.evaluationHashes = [...stateObj.evaluationHashes.slice(-49), bundle.bundleId];
      stateObj.lastBundleId = undefined;
      void maybeAutoCompileDspy(ctx, "evaluate");
    } catch { /* retrieval evaluation must never affect task completion */ }
  };


  const compactScratchpadAndNotify = (stateObj: State, ctx: ExtensionContext, cwd: string) => {
    const compacted = compactScratchpad(scratchpadRootPath(stateObj, cwd));
    if (compacted.compacted.length) {
      try { ctx.ui.notify(`Sherpa compacted scratchpad sections: ${compacted.compacted.join(", ")}`, "info"); } catch {}
    }
  };

  const runPostTaskWork = async (ctx: ExtensionContext, cwd: string, recentMessages: unknown[]) => {
    if (!state?.config.enabled) return;
    const stateObj = state;
    try {
      const { recentText, outcome, changedFiles } = await recordLifecycleObservation(stateObj, cwd, recentMessages);
      await evaluateRecentBundle(stateObj, ctx, cwd, recentMessages, recentText, outcome, changedFiles);
      compactScratchpadAndNotify(stateObj, ctx, cwd);
    } catch (error) {
      try { ctx.ui.notify(`Sherpa post-task work failed: ${String(error)}`, "warning"); } catch {}
    } finally {
      persist();
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
    const recentMessages = event.messages ?? ctx.sessionManager.getEntries().slice(-12);
    const cwd = ctx.cwd;
    setTimeout(() => { void runPostTaskWork(ctx, cwd, recentMessages).catch(() => {}); }, 0);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (state?.config.enabled) void maybeAutoCompileDspy(ctx, "session_shutdown").catch(() => {});
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
      } catch (e: unknown) {
        return toolErrorResult("Session search error", e);
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
          const kindLines = stats.kindCounts.map((k) => `- ${k.kind}: ${k.count}`).join("\n");
          return { content: [{ type: "text" as const, text: `## Sherpa Memory Index\nDocuments: ${stats.documents}\nSource paths: ${stats.sourcePaths}\nScratchpad entries: ${stats.scratchpadEntries}\nCatalog entries: ${stats.catalogEntries}\nEvaluations: ${stats.evaluations}\nDedup hashes: ${stats.dedupHashes}\nLast indexed: ${stats.lastIndexedAt ?? "unknown"}\nDB: ${stats.dbPath}\n\n### Kinds\n${kindLines || "(none)"}` }], details: stats };
        }
        const results = searchSherpaMemory(ctx.cwd, params.query, params.limit ?? 10, config);
        const lines = results.map((r, i) => `### ${i + 1}. ${r.title}\n**Kind:** ${r.kind}\n**Source:** ${r.sourcePath}\n${r.snippet || r.summary}`).join("\n\n");
        return { content: [{ type: "text" as const, text: `## Sherpa Memory Search: "${params.query}"\n${results.length} result(s)\n\n${lines || "(no matches)"}` }], details: { stats, results } };
      } catch (e: unknown) {
        return toolErrorResult("Sherpa memory search error", e);
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

    const sherpaUi = startSherpaWorkUi(ctx, event.prompt, "front-door");

    try {
      sherpaUi.update("planning sources", "Choosing files/docs/git/memory sources.");
      const { sourcePlan, indicators } = await planSources(state, ctx, event.prompt, "front-door");
      sherpaUi.update(
        `searching ${sourcePlan.sources.join(", ")}`,
        `Planner: ${sourcePlan.planner}; indicators: ${indicators.indicators.slice(0, 5).join(", ") || "none"}`,
      );

      // Front-door context must stay high-signal. Avoid session_recent by default because it often
      // echoes tool-result noise back into the next prompt. Explicit Sherpa requests can still use it.
      const bundle = await Promise.race([
        buildBundle(state, ctx, event.prompt, "front-door", state.config.frontDoor.tokenBudget, sourcePlan, indicators),
        timeoutAfter<ContextBundle>(CURATION_TIMEOUT_MS, "front-door curation timed out"),
      ]);
      sherpaUi.update("curating results", `Candidates: ${bundle.candidateCount ?? bundle.items.length}; selected: ${bundle.items.length}`);
      bundle.items = filterAlreadySeenSources(ctx, bundle.items, state);
      bundle.signal = buildContextSignal(bundle);
      void maybeAutoCompileDspy(ctx, "bundle");
      const abstainReason = shouldAbstain(bundle.items, "front-door");
      if (abstainReason) { state.lastSkip = abstainReason; return; }
      sherpaUi.done(`injecting ${bundle.items.length} item(s)`);
      return { message: { customType: SHERPA_CONTEXT_TYPE, content: bundleMarkdown(bundle), display: true, details: bundle } };
    } catch (err: any) {
      state.lastSkip = `front-door error: ${err?.message ?? err}`;
      ctx.ui.notify(`Sherpa context skipped: ${err?.message ?? err}; continuing without extra context`, "warning");
      return;
    } finally {
      sherpaUi.done();
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
      const sherpaUi = startSherpaWorkUi(ctx, params.focus, "explicit tool");
      try {
        const _state = state; // capture at function scope to avoid TDZ issues
        const expanded = (params.expandHandles ?? []).map(h => _state.handles.get(h)).filter(Boolean) as ContextItem[];
        sherpaUi.update("planning sources", "Choosing memory/files/docs/git sources.");
        const { sourcePlan, indicators } = await planSources(_state, ctx, params.focus, "explicit", params.sources);
        sherpaUi.update(
          `searching ${sourcePlan.sources.join(", ")}`,
          `Planner: ${sourcePlan.planner}; indicators: ${indicators.indicators.slice(0, 5).join(", ") || "none"}`,
        );
        const bundle = await buildBundle(_state, ctx, params.focus, "explicit", params.tokenBudget ?? _state.config.explicit.tokenBudget, sourcePlan, indicators, { searchOtherProjects: params.searchOtherProjects, includeTaxonomy: params.includeTaxonomy });
        sherpaUi.update("formatting context", `Candidates: ${bundle.candidateCount ?? bundle.items.length}; selected: ${bundle.items.length}`);
        void maybeAutoCompileDspy(ctx, "bundle");
        const extra = expanded.map(i => `\n\n## Expanded ${i.handle}\nSource: ${i.source}\n\n${(i.raw ?? i.summary).slice(0, (params.tokenBudget ?? 3000) * 4)}`).join("");
        persist();
        return { content: [{ type: "text", text: bundleMarkdown(bundle) + extra }], details: bundle };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Sherpa error: ${e?.message ?? String(e)}\n${(e?.stack ?? "").split("\n").slice(0, 5).join("\n")}` }], details: { error: e?.message ?? String(e) } };
      } finally {
        sherpaUi.done();
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

  pi.registerCommand("sherpa:smoke:sidecar", {
    description: "Run live Sherpa sidecar model smoke checks for JSON planning/compilation",
    handler: async (_args, ctx) => {
      if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
      const result = await runSidecarSmoke(ctx);
      pi.sendMessage({
        customType: "sherpa-sidecar-smoke",
        content: [`# Sherpa sidecar smoke`, "", ...result.lines].join("\n"),
        display: true,
        details: result,
      }, { triggerTurn: false, deliverAs: "nextTurn" });
    },
  });

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
    const sherpaUi = startSherpaWorkUi(ctx, focus, "slash command");
    try {
      // User-invoked /sherpa should behave like an intervention: inject the context and wake the
      // main agent. Source planning chooses the likely stores before expensive retrieval.
      sherpaUi.update("planning sources", "Choosing memory/files/docs/git sources.");
      const { sourcePlan, indicators } = await planSources(state, ctx, focus, "explicit");
      sherpaUi.update(
        `searching ${sourcePlan.sources.join(", ")}`,
        `Planner: ${sourcePlan.planner}; indicators: ${indicators.indicators.slice(0, 5).join(", ") || "none"}`,
      );
      const bundle = await buildBundle(state, ctx, focus, "explicit", state.config.explicit.tokenBudget, sourcePlan, indicators);
      sherpaUi.update("curating results", `Candidates: ${bundle.candidateCount ?? bundle.items.length}; selected: ${bundle.items.length}`);
      bundle.items = filterAlreadySeenSources(ctx, bundle.items, state);
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
      sherpaUi.done();
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
      `source planner reasons: ${fmtReasons(report.topSourcePlanReasons)}`,
      `curation reasons: ${fmtReasons(report.topCurationReasons)}`,
      `process decisions: ${fmtReasons(report.topProcessDecisions)}`,
      `data sufficiency: ${fmtReasons(report.topDataSufficiency)}`,
      `final context: ${fmtReasons(report.topFinalContext)}`,
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
    try {
      const { stdout, stderr, candidateDir } = await runDspyPromptCompile(ctx.cwd);
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
      `inquirerMemory=managed-by-Archivist/Inquirer (Sherpa has no direct Surreal source)`,
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

  const buildMemoryDoctorReport = (ctx: ExtensionContext) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const reflectIndex = path.join(ctx.cwd, ".pi", "reflect", "index.jsonl");
    const reflectMemory = path.join(ctx.cwd, ".pi", "reflect", "MEMORY.md");
    const reflectAutomations = path.join(ctx.cwd, ".pi", "reflect", "AUTOMATIONS.md");
    const reflectOutbox = path.join(ctx.cwd, ".pi", "reflect", "archivist-outbox.jsonl");
    const reflectRows = existsSync(reflectIndex) ? readFileSync(reflectIndex, "utf8").split(/\r?\n/).filter(Boolean) : [];
    const outboxRows = existsSync(reflectOutbox) ? readFileSync(reflectOutbox, "utf8").split(/\r?\n/).filter(Boolean) : [];
    const stats = indexSherpaMemory(ctx.cwd, {
      scratchpadRoot: scratchpadRootPath(state, ctx.cwd),
      catalogRoots: [ctx.cwd, obsidianMemoryPath(state)],
      evaluationRoot: obsidianMemoryPath(state),
    });
    const reflectKinds = stats.kindCounts.filter((k) => k.kind.startsWith("reflect:")).map((k) => `${k.kind}:${k.count}`).join(", ") || "none";
    const reflectSearchOk = reflectRows.length === 0 || searchSherpaMemory(ctx.cwd, "Reflect Memory", 1, {
      scratchpadRoot: scratchpadRootPath(state, ctx.cwd),
      catalogRoots: [ctx.cwd, obsidianMemoryPath(state)],
      evaluationRoot: obsidianMemoryPath(state),
    }).some((result) => result.kind.startsWith("reflect:") || result.sourcePath.includes(".pi/reflect"));
    return {
      reflectIndexExists: existsSync(reflectIndex),
      reflectMemoryExists: existsSync(reflectMemory),
      reflectAutomationsExists: existsSync(reflectAutomations),
      reflectRows: reflectRows.length,
      reflectOutboxRows: outboxRows.length,
      indexedDocuments: stats.documents,
      reflectKinds,
      reflectSearchOk,
      dbPath: stats.dbPath,
    };
  };

  pi.registerTool({
    name: "sherpa_memory_doctor",
    label: "Sherpa Memory Doctor",
    description: "Audit Sherpa/Reflect memory alignment: reflect store, generated discovery files, outbox, and Sherpa memory index visibility.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const report = buildMemoryDoctorReport(ctx);
      return { content: [{ type: "text" as const, text: [
        "## Sherpa/Reflect Memory Doctor",
        `Reflect index: ${report.reflectIndexExists ? "yes" : "no"} (${report.reflectRows} rows)`,
        `Reflect MEMORY.md: ${report.reflectMemoryExists ? "yes" : "no"}`,
        `Reflect AUTOMATIONS.md: ${report.reflectAutomationsExists ? "yes" : "no"}`,
        `Archivist outbox rows: ${report.reflectOutboxRows}`,
        `Sherpa indexed docs: ${report.indexedDocuments}`,
        `Reflect indexed kinds: ${report.reflectKinds}`,
        `Reflect search visible: ${report.reflectSearchOk ? "yes" : "no"}`,
        `DB: ${report.dbPath}`,
      ].join("\n") }], details: report };
    },
  });

  pi.registerCommand("sherpa:memory-doctor", { description: "Audit Sherpa/Reflect memory alignment", handler: async (_args, ctx) => {
    const report = buildMemoryDoctorReport(ctx);
    ctx.ui.notify([
      "## Sherpa/Reflect Memory Doctor",
      `Reflect index: ${report.reflectIndexExists ? "yes" : "no"} (${report.reflectRows} rows)`,
      `Reflect MEMORY.md: ${report.reflectMemoryExists ? "yes" : "no"}`,
      `Reflect AUTOMATIONS.md: ${report.reflectAutomationsExists ? "yes" : "no"}`,
      `Archivist outbox rows: ${report.reflectOutboxRows}`,
      `Sherpa indexed docs: ${report.indexedDocuments}`,
      `Reflect indexed kinds: ${report.reflectKinds}`,
      `Reflect search visible: ${report.reflectSearchOk ? "yes" : "no"}`,
      `DB: ${report.dbPath}`,
    ].join("\n"), report.reflectSearchOk ? "info" : "warning");
  }});

  pi.registerCommand("sherpa:memory-index:status", { description: "Show SQLite-backed Sherpa memory index status", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const stats = indexSherpaMemory(ctx.cwd, {
      scratchpadRoot: scratchpadRootPath(state, ctx.cwd),
      catalogRoots: [ctx.cwd, obsidianMemoryPath(state)],
      evaluationRoot: obsidianMemoryPath(state),
    });
    const kinds = stats.kindCounts.slice(0, 8).map((k) => `${k.kind}:${k.count}`).join(", ") || "none";
    ctx.ui.notify(`Memory index: ${stats.documents} docs, ${stats.sourcePaths} sources, ${stats.scratchpadEntries} scratchpad, ${stats.catalogEntries} catalog, ${stats.evaluations} evals. Kinds: ${kinds}`, "info");
  }});

  pi.registerCommand("sherpa:auto-distill:status", { description: "Show auto-distillation ownership", handler: async (_args, ctx) => {
    ctx.ui.notify("Auto-distill moved to the reflect extension. Use /reflect stats/recent to inspect captured learning outputs.", "info");
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
