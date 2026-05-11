import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  createAutoMemoryState,
  hashAutoMemory,
  stringifyForAutoMemory,
  writeAutoMemoryArtifact,
} from "./lib/auto-memory";
import type { AutoMemoryState } from "./lib/auto-memory";
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
import { recallMemory, syncReflectMemory } from "./lib/memory";
import { writeDistilledSkill } from "./lib/distillation";
import { evaluatePersistence } from "./lib/preserve";
import { compactScratchpad, classifyTaskOutcome, suggestVerificationCommands } from "./lib/lifecycle";
import { ensureRouteMap, parseRouteMap } from "./lib/route-map";
import type { RoutePlan } from "./lib/route-map";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
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
type Source = "files" | "git" | "docs" | "session" | "web" | "logs" | "project_memory";

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
  writeSide: { enabled: boolean; owner: "archivist" | "sherpa" };
  memory: { obsidianVault: string; obsidianMemoryPath: string; scratchpadPath: string };
  web: { enabled: boolean; provider: "brave" | "tavily" | "serpapi"; apiKeyEnv: string; maxResults: number; timeoutMs: number; cacheTtlMs: number };
  routeMap: { enabled: boolean; path: string; applyTo: "all" | "front-door" | "explicit" };
  dedupe: { urls: { enabled: boolean; normalize: boolean; scope: "bundle" } };
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
type ContextBundle = { taskId: string; focus: string; mode: string; budgetUsedTokens: number; items: ContextItem[]; candidateCount?: number; sourcePlan?: SourcePlan; signal?: ContextSignalV1 };

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
  autoMemory: AutoMemoryState;
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
  sources: { files: true, git: true, docs: true, session: true, web: false, logs: false, project_memory: true },
  privacy: { allowNetwork: false, allowRemoteModel: false },
  model: { provider: "olmx", id: "Qwen3.6-35B-A3B-4bit", useMainPiModel: false, heuristicOnly: false, fallbackToHeuristics: true },
  summarization: { maxToolResultChars: 12000, replacementBudget: 1500 },
  writeSide: { enabled: false, owner: "archivist" },
  memory: { obsidianVault: "/Users/kamil/Documents/articles", obsidianMemoryPath: "projects/project", scratchpadPath: ".pi-memory/scratchpad" },
  web: { enabled: false, provider: "brave", apiKeyEnv: "BRAVE_SEARCH_API_KEY", maxResults: 5, timeoutMs: 5000, cacheTtlMs: 6 * 60 * 60 * 1000 },
  routeMap: { enabled: true, path: "routes.csv", applyTo: "all" },
  dedupe: { urls: { enabled: true, normalize: true, scope: "bundle" } },
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
function sherpaWriteSideEnabled(state: State | undefined) {
  return Boolean(state?.config.writeSide?.enabled);
}
function writeSideMovedMessage() {
  return "Sherpa write-side bookkeeping is disabled; Archivist owns durable memory/documentation writes. Use archivist_* tools or /archivist:* commands. Sherpa still owns read-side retrieval and scratchpad.";
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

function isCodePrompt(focus: string) {
  return /\b(fix|bug|implement|refactor|test|typecheck|lint|compile|failing|error|exception|stack|function|class|api|route|service|schema|repository|component|hook|module|typescript|javascript|python|sql)\b/i.test(focus);
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

function candidateSortKey(item: ContextItem, focus: string, mode: string) {
  if (mode !== "front-door" || !isCodePrompt(focus)) return item.relevance;
  const sourcePriority = item.type === "file_snippet" ? 0.25
    : item.type === "doc_snippet" ? -0.2
    : 0;
  return item.relevance + sourcePriority;
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

function heuristicOrderCandidates(candidates: ContextItem[], focus: string, mode: string) {
  return [...candidates].sort((a, b) => candidateSortKey(b, focus, mode) - candidateSortKey(a, focus, mode));
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

const ALL_RETRIEVAL_SOURCES: Source[] = ["files", "docs", "git", "session", "project_memory", "web"];

function normalizeSources(input: string[] | undefined, mode: string): Source[] {
  const allowed = new Set<Source>(mode === "front-door"
    ? ["files", "docs", "git", "project_memory", "web"]
    : ALL_RETRIEVAL_SOURCES);
  const out: Source[] = [];
  for (const raw of input ?? []) {
    const s = raw;
    if (allowed.has(s as Source) && !out.includes(s as Source)) out.push(s as Source);
  }
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

function heuristicSourcePlan(focus: string, mode: string): SourcePlan {
  const f = focus.toLowerCase();
  const sources: Source[] = [];
  const add = (...ss: Source[]) => { for (const s of ss) if (!sources.includes(s)) sources.push(s); };

  if (/\b(fix|bug|implement|refactor|test|typecheck|lint|compile|failing|error|exception|stack|function|class|api|route|service|schema|repository|component|module)\b/.test(f)) add("files");
  if (/\b(doc|docs|readme|guide|explain|overview|architecture|design|how\s+to|reference|manual)\b/.test(f)) add("docs");
  if (/\b(git|diff|changed|changes|status|staged|unstaged|commit|branch|recent)\b/.test(f)) add("git");
  if (/\b(memory|remember|convention|pattern|known\s+issue|lesson|skill|kb|knowledge|policy|catalog|taxonomy|tag|tags|ontology)\b/.test(f)) add("project_memory");
  if (/\b(internet|web|online|search\s+web|latest|current|today|recent\s+news|external\s+source|documentation\s+online)\b/.test(f)) add("web");
  if (mode !== "front-door" && /\b(previous|earlier|continue|session|conversation|last\s+time|we\s+discussed)\b/.test(f)) add("session");

  if (!sources.length) add(...(mode === "front-door" ? ["files", "docs"] as Source[] : ["files", "docs", "git", "project_memory"] as Source[]));
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
      "Available: files, docs, git, project_memory, web.",
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
        return { sourcePlan: { ...sourcePlan, sources: mergedSources, routePlan }, indicators };
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

  if (mode !== "front-door" || state.config.model.heuristicOnly || candidates.length <= 1) {
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

  const manifest = heuristicOrdered
    .filter(c => !isNoisy(c))
    .slice(0, 30)
    .map((c, i) => ({
      index: i,
      type: c.type,
      source: c.source,
      relevance: Number(c.relevance.toFixed(2)),
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
      if (!Number.isInteger(n) || n < 0 || n >= manifest.length || seen.has(n)) continue;
      seen.add(n);
      picked.push(heuristicOrdered[n]);
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
  if (!auth.ok || !auth.apiKey) {
    if (state.config.model.fallbackToHeuristics) return summarize(raw, budgetChars);
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
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

  return {
    version: "1",
    focus: bundle.focus,
    taskType,
    confidence,
    disposition,
    proposedResponse,
    items: signalItems,
    risks,
    missingInfo,
    suggestedCommands,
    renderHints: { style: bundle.mode === "front-door" ? "minimal" : "normal", maxItems: 8 },
    diagnostics: { sourcesSearched: bundle.sourcePlan?.sources ?? [], candidateCount: bundle.candidateCount ?? bundle.items.length, selectedCount: bundle.items.length },
  };
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
  const items = signal.items.map(i => {
    const body = i.inline
      ? `\n\`\`\`\n${i.inline}\n\`\`\``
      : `\n  ${i.summary}\n  Why: ${i.why}\n  Pointer: ${i.source}. Expand: /sherpa:expand ${i.handle}`;
    return `- **${i.handle}** [${i.type}, ${(i.relevance * 100).toFixed(0)}%] ${i.source}${body}`;
  }).join("\n");
  return `## Sherpa Context (${mode}, ~${budgetUsedTokens} tokens)${routeLine}${dispositionLine}${proposal}${riskBlock}${commandBlock}\n### Context items\n${items}`;
}

function bundleMarkdown(bundle: ContextBundle) {
  const signal = bundle.signal ?? buildContextSignal(bundle);
  return signalMarkdown(signal, bundle.mode, bundle.budgetUsedTokens, bundle.sourcePlan);
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

async function rg(cwd: string, query: string, searchPath = cwd) {
  const terms = query.match(/[A-Za-z0-9_./-]{4,}/g)?.slice(0, 6) ?? [];
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

  await Promise.allSettled(retrievalTasks);

// Stage 3: model judges candidates with hard suppression gate.
  const curateResult = await curateCandidates(state, ctx, candidates, focus, mode, indicators);

  // HARD GATE: if Stage 3 suppressed everything, return empty bundle (triggers abstain)
  if (curateResult.abstain) {
    state.bundles++;
    const abstainBundle: ContextBundle = {
      taskId: `sherpa-${Date.now()}`,
      focus,
      mode,
      budgetUsedTokens: 0,
      items: [],
      candidateCount: candidates.length,
      sourcePlan,
    };
    abstainBundle.signal = buildContextSignal(abstainBundle);
    return abstainBundle;
  }

  const items: ContextItem[] = []; let used = 0;
  for (const c of curateResult.items) {
    const t = approxTokens(c.summary) + 30;
    if (used + t <= tokenBudget) { items.push(c); used += t; }
    if (items.length >= 8) break;
  }
  state.bundles++;
  const bundle: ContextBundle = { taskId: `sherpa-${Date.now()}`, focus, mode, budgetUsedTokens: used, items, candidateCount: candidates.length, sourcePlan };
  bundle.signal = buildContextSignal(bundle);
  return bundle;
}

function restoreState(ctx: ExtensionContext, config: SherpaConfig): State {
  const retrievalPrompt = loadPromptKind(ctx.cwd, "retrieval", config);
  const distillPrompt = loadPromptKind(ctx.cwd, "distillation", config);
  const documentationPrompt = loadPromptKind(ctx.cwd, "documentation", config);
  const automationPrompt = loadPromptKind(ctx.cwd, "automation", config);
  const state: State = { config, handles: new Map(), nextHandle: 1, bundles: 0, lastSkip: "none", turnCount: 0, lastProactiveTurn: -999, feedback: [], autoMemory: createAutoMemoryState(), automation: createAutomationState(), lifecycleHashes: [], systemPrompt: retrievalPrompt.prompt, systemPromptSource: retrievalPrompt.source, retrievalPrompt: retrievalPrompt.prompt, retrievalPromptSource: retrievalPrompt.source, distillPrompt: distillPrompt.prompt, distillPromptSource: distillPrompt.source, documentationPrompt: documentationPrompt.prompt, documentationPromptSource: documentationPrompt.source, automationPrompt: automationPrompt.prompt, automationPromptSource: automationPrompt.source };
  for (const e of ctx.sessionManager.getEntries() as any[]) {
    if (e.type === "custom" && e.customType === "ai-sherpa-state" && e.data) {
      state.nextHandle = Math.max(state.nextHandle, e.data.nextHandle ?? 1);
      state.bundles = e.data.bundles ?? state.bundles;
      state.feedback = e.data.feedback ?? state.feedback;
      state.autoMemory = { ...state.autoMemory, ...(e.data.autoMemory ?? {}) };
      state.automation = { ...state.automation, ...(e.data.automation ?? {}) };
      state.lifecycleHashes = Array.isArray(e.data.lifecycleHashes) ? e.data.lifecycleHashes : state.lifecycleHashes;
    }
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

function recentTurnWrittenFiles(messages: any[] | undefined, cwd: string) {
  const files = new Set<string>();
  for (const msg of messages ?? []) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall" || !["write", "edit"].includes(block.name)) continue;
      const rawPath = block.arguments?.path;
      if (typeof rawPath !== "string" || !rawPath) continue;
      const cleaned = rawPath.replace(/^@/, "");
      const absolute = path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned);
      const relative = path.relative(cwd, absolute).replace(/\\/g, "/");
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) files.add(relative);
    }
  }
  return [...files];
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

async function auditDocumentationDrift(state: State, ctx: ExtensionContext, changedFilesOverride?: string[]) {
  const status = await gitChanged(ctx.cwd);
  const files = changedFilesOverride ?? parseGitStatusFiles(status);
  const changedSources = files.filter(isSourcePath);
  if (!changedSources.length) return { needed: false, reason: "no source changes" };
  const changedDocs = files.filter(isDocumentationPath);
  if (changedDocs.length) return { needed: false, reason: "documentation changed with source", changedSources, changedDocs };

  const hash = hashAutoMemory(`doc-audit\n${changedSources.sort().join("\n")}`);
  if (state.autoMemory.docAuditHashes.includes(hash)) return { needed: false, reason: "already audited", changedSources };

  const candidates = findDocumentationCandidates(ctx.cwd, changedSources);
  appendScratchpadSection(state, ctx.cwd, "todo", [
    "Sherpa detected source/config changes without documentation changes.",
    "",
    "Changed source/config files:",
    ...changedSources.map(f => `- ${f}`),
    "",
    candidates.length ? "Likely documentation to review:" : "No obvious documentation file found; decide whether README/docs need a note.",
    ...candidates.map(f => `- ${f}`),
  ].join("\n"), "Documentation drift audit");

  state.autoMemory.docAuditHashes = [...state.autoMemory.docAuditHashes.slice(-49), hash];
  return { needed: true, hash, changedSources, candidates };
}

function documentationAuditMessage(audit: { changedSources?: string[]; candidates?: string[] }, promptSource?: string) {
  const sources = audit.changedSources ?? [];
  const docs = audit.candidates ?? [];
  return [
    "## Sherpa Documentation Audit",
    "",
    "Sherpa detected code/config changes without accompanying documentation updates.",
    "Please review whether docs should be updated before considering the task complete.",
    "Use the dedicated documentation-maintenance prompt as the policy source for this review.",
    promptSource ? `Prompt: ${promptSource}` : "Prompt: prompts/DOCUMENTATION.md",
    "",
    "### Changed source/config files",
    ...(sources.length ? sources.map(f => `- ${f}`) : ["- (none listed)"]),
    "",
    docs.length ? "### Likely documentation to review" : "### Documentation to review",
    ...(docs.length ? docs.map(f => `- ${f}`) : ["- No obvious doc file found; check README/docs if behavior or usage changed."]),
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  let state: State | undefined;
  const persist = () => state && pi.appendEntry("ai-sherpa-state", { nextHandle: state.nextHandle, bundles: state.bundles, feedback: state.feedback, autoMemory: state.autoMemory, automation: state.automation, lifecycleHashes: state.lifecycleHashes, config: state.config });
  const autoMemoryConfig = (ctx: ExtensionContext) => ({
    cwd: ctx.cwd,
    obsidianVault: obsidianVaultPath(state!),
    obsidianMemoryPath: obsidianMemoryPath(state!),
    appendScratchpadCandidate: (text: string, title?: string) => appendScratchpadSection(state!, ctx.cwd, "distill_candidate", text, title),
  });
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

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx, loadConfig(ctx.cwd));
    getProjectKBBasedir(ctx.cwd);
    ensureRouteMap(state.config.routeMap, ctx.cwd);
    ctx.ui.setStatus(SHERPA_LEGACY_UI_KEY, undefined);
    ctx.ui.setWidget(SHERPA_LEGACY_UI_KEY, undefined);
    setSherpaStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state?.config.enabled || !sherpaWriteSideEnabled(state)) return;
    const now = Date.now();
    if (now - state.autoMemory.lastAgentEndAt >= 30_000) {
      state.autoMemory.lastAgentEndAt = now;
      const raw = stringifyForAutoMemory(event.messages ?? ctx.sessionManager.getEntries().slice(-12));
      const result = writeAutoMemoryArtifact(state.autoMemory, autoMemoryConfig(ctx), "agent_end", raw);
      if (result.written && result.candidates.length) {
        ctx.ui.setStatus(SHERPA_UI_KEY, `🤵 memory: ${result.candidates.length} candidate(s)`);
      }

      const automationCandidates = updateAutomationCandidates(state.automation, raw, 3, ctx.cwd);
      for (const candidate of automationCandidates) {
        appendScratchpadSection(state, ctx.cwd, "distill_candidate", `${candidate.markdown}\n\nPolicy source: ${state.automationPromptSource}`, "Automation candidate");
      }
      if (automationCandidates.length) {
        ctx.ui.notify(`Sherpa detected ${automationCandidates.length} automation candidate(s)`, "info");
      }
    }

    const recentText = stringifyForAutoMemory(event.messages ?? ctx.sessionManager.getEntries().slice(-12));
    const outcome = classifyTaskOutcome(recentText);
    const status = await gitChanged(ctx.cwd);
    const changedFiles = parseGitStatusFiles(status);
    const lifecycleHash = hashAutoMemory(`lifecycle\n${outcome.outcome}\n${changedFiles.sort().join("\n")}`);
    if (!state.lifecycleHashes.includes(lifecycleHash) && (changedFiles.length || outcome.outcome !== "unknown")) {
      const verification = suggestVerificationCommands(changedFiles);
      appendScratchpadSection(state, ctx.cwd, "observation", [
        `Outcome: ${outcome.outcome}`,
        `Reason: ${outcome.reason}`,
        "",
        changedFiles.length ? "Changed files:" : "Changed files: none detected",
        ...changedFiles.slice(0, 30).map((file) => `- ${file}`),
        "",
        verification.commands.length ? "Suggested verification:" : "Suggested verification: none",
        ...verification.commands.map((item) => `- \`${item.command}\` — ${item.reason}`),
        verification.docsReview ? "- Documentation review recommended." : "- Documentation review not required by heuristic.",
        verification.routesReview ? "- routes.csv review recommended." : "- routes.csv review not required by heuristic.",
      ].join("\n"), "Task lifecycle summary");
      state.lifecycleHashes = [...state.lifecycleHashes.slice(-49), lifecycleHash];
    }

    const compacted = compactScratchpad(scratchpadRootPath(state, ctx.cwd));
    if (compacted.compacted.length) ctx.ui.notify(`Sherpa compacted scratchpad sections: ${compacted.compacted.join(", ")}`, "info");

    // Only auto-audit docs for files this turn actually edited inside the current repo.
    // Otherwise stale/unrelated dirty worktrees can interrupt global extension work.
    const audit = await auditDocumentationDrift(state, ctx, recentTurnWrittenFiles(event.messages, ctx.cwd));
    if (audit.needed) {
      ctx.ui.notify("Sherpa detected possible documentation drift", "warning");
      pi.sendMessage({ customType: "sherpa-doc-audit", content: documentationAuditMessage(audit, state.documentationPromptSource), display: true, details: audit }, { triggerTurn: true, deliverAs: "steer" });
    }
    persist();
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!state?.config.enabled || !sherpaWriteSideEnabled(state)) return;
    const raw = stringifyForAutoMemory(event.compactionEntry ?? ctx.sessionManager.getEntries().slice(-20));
    writeAutoMemoryArtifact(state.autoMemory, autoMemoryConfig(ctx), "session_compact", raw);
    persist();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    ctx.ui.setWidget(SHERPA_UI_KEY, undefined);
    ctx.ui.setStatus(SHERPA_UI_KEY, undefined);
    ctx.ui.setWidget(SHERPA_LEGACY_UI_KEY, undefined);
    ctx.ui.setStatus(SHERPA_LEGACY_UI_KEY, undefined);

    if (!state?.config.enabled || !sherpaWriteSideEnabled(state)) return;
    const now = Date.now();
    if (now - state.autoMemory.lastSessionEventAt < 10_000) return;
    state.autoMemory.lastSessionEventAt = now;
    const raw = stringifyForAutoMemory({ reason: event.reason, recent: ctx.sessionManager.getEntries().slice(-20) });
    writeAutoMemoryArtifact(state.autoMemory, autoMemoryConfig(ctx), `session_shutdown:${event.reason}`, raw);
    persist();
  });

  pi.registerTool({
    name: "sherpa_run_automation",
    label: "Sherpa Run Automation",
    description: "Run a safe registered project automation from package.json or scripts/. Unsafe or approval-required automations are refused.",
    parameters: runAutomationSchema,
    async execute(_toolCallId, params: RunAutomationParams, _signal, _onUpdate, ctx) {
      if (!sherpaWriteSideEnabled(state)) return { content: [{ type: "text" as const, text: writeSideMovedMessage() }], details: { movedTo: "archivist_run_automation" } };
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

  pi.registerCommand("sherpa:automations", { description: "List safe project automations Sherpa can run", handler: async (_args, ctx) => {
    if (!sherpaWriteSideEnabled(state)) return ctx.ui.notify(writeSideMovedMessage(), "info");
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
        `＇　️ Indicators: ${indicators.indicators.slice(0, 5).join(", ")}${indicators.indicators.length > 5 ? "..." : ""}`
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
    return { content: [{ type: "text", text: `Sherpa compressed long ${event.toolName} output into ${handle}.\n\n${summary}\n\nUse /sherpa:expand ${handle} for raw output.` }], details: { ...(event.details ?? {}), sherpaRawHandle: handle, sherpaCompressed: true } };
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
      ctx.ui.notify(`Sherpa scratchpad appended: ${scratchpadRootRelative(state, ctx.cwd, target)}`, "success");
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
      const abstainReason = shouldAbstain(bundle.items, "explicit");
      if (abstainReason) {
        state.lastSkip = abstainReason;
        ctx.ui.notify(`Sherpa stepping aside: ${abstainReason}`, "info");
        // Do not wake the main agent with an empty/low-value Sherpa message. If the user wants the
        // main agent, they can ask directly; Sherpa should not add noise just to participate.
        persist();
        return;
      }
      ctx.ui.notify(`Sherpa found ${bundle.items.length} useful items; triggering agent`, "success");
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
      `writeSide=${sherpaWriteSideEnabled(state) ? "enabled (legacy Sherpa)" : "disabled (Archivist-owned)"}`,
      `lastSkip=${state.lastSkip}`,
    ].join("\n"), "info");
  }});

  pi.registerCommand("sherpa:docs:audit", { description: "Audit whether changed code/config needs documentation updates", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    if (!sherpaWriteSideEnabled(state)) return ctx.ui.notify(writeSideMovedMessage(), "info");
    const audit = await auditDocumentationDrift(state, ctx);
    persist();
    if (audit.needed) {
      ctx.ui.notify("Sherpa detected possible documentation drift", "warning");
      pi.sendMessage({ customType: "sherpa-doc-audit", content: documentationAuditMessage(audit, state.documentationPromptSource), display: true, details: audit }, { triggerTurn: true, deliverAs: "steer" });
      return;
    }
    ctx.ui.notify(`Sherpa documentation audit: ${audit.reason}`, "info");
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

  pi.registerCommand("sherpa:on", { description: "Enable Sherpa", handler: async (_args, ctx) => { if (!state) state = restoreState(ctx, loadConfig(ctx.cwd)); state.config.enabled = true; saveConfig(ctx.cwd, state.config); ctx.ui.setStatus("ai-sherpa", `Sherpa: ${state.config.mode}`); ctx.ui.notify("Sherpa enabled", "success"); }});
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
    saveConfig(ctx.cwd, state.config); persist(); ctx.ui.notify(`Sherpa model: ${picked}`, "success");
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
    ctx.ui.notify(`Sherpa checkpoint saved: ${path.relative(scratchpadRootPath(state, ctx.cwd), working)} + ${path.relative(scratchpadRootPath(state, ctx.cwd), daily)}`, "success");
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
    ctx.ui.notify(`Sherpa mistake saved: ${path.relative(scratchpadRootPath(state, ctx.cwd), target)}`, "success");
  }});

  function memoryPaths(ctx: ExtensionContext) {
    return {
      cwd: ctx.cwd,
      extensionMemoryDir: SHERPA_MEMORY_DIR,
      obsidianVault: obsidianVaultPath(state!),
      obsidianMemoryPath: obsidianMemoryPath(state!),
    };
  }

  function parseSyncArgs(args?: string) {
    const parts = args?.trim() ? args.trim().split(/\s+/) : [];
    const out: { refId?: string; destination?: string; dryRun?: boolean; since?: string } = {};
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part === "--dry-run") out.dryRun = true;
      if (part === "--ref-id") out.refId = parts[++i];
      if (part === "--destination") out.destination = parts[++i];
      if (part === "--since") out.since = parts[++i];
    }
    return out;
  }

  pi.registerCommand("sherpa:recall", { description: "Recall Sherpa long-term memory", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const query = args?.trim() || await ctx.ui.input("Sherpa Recall", "Query?");
    if (!query) return;
    try {
      ctx.ui.notify(recallMemory(memoryPaths(ctx), query), "info");
    } catch (e: any) {
      ctx.ui.notify(`Sherpa recall failed: ${e.message ?? e}`, "error");
    }
  }});

  pi.registerCommand("sherpa:sync-reflect", { description: "Sync reflect captures into Sherpa memory", handler: async (args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    if (!sherpaWriteSideEnabled(state)) return ctx.ui.notify(writeSideMovedMessage(), "info");
    try {
      const result = await syncReflectMemory(memoryPaths(ctx), parseSyncArgs(args));
      ctx.ui.notify(result, "success");
    } catch (e: any) {
      ctx.ui.notify(`Sherpa reflect sync failed: ${e.message ?? e}`, "error");
    }
  }});

  // ─── Decision Gate ─────────────────────────────────────────────────
  // Sherpa evaluates whether something is worth persisting before writing.

  const preserveSchema = Type.Object({
    refId: Type.String({ description: "Reflect capture ID (e.g. ref_20260322_abc123)" }),
    type: Type.String({ description: "reflect type: knowledge | process | automation | pattern" }),
    title: Type.String({ description: "Short title of the reflection" }),
    summary: Type.String({ description: "Summary or content of the reflection" }),
    importance: Type.String({ description: "low | medium | high | critical" }),
    tags: Type.Array(Type.String(), { description: "Tags for routing and search" }),
    storage: Type.Optional(Type.String({ description: "auto | obsidian | project | scratchpad — overrides Sherpa routing if set" })),
  });

  pi.registerTool({
    name: "sherpa_preserve",
    label: "Sherpa Preserve",
    description: "Evaluate a reflection for persistence value and route it to the right memory destination. Sherpa runs a decision gate: only persists if it contains structural knowledge worth preserving. Call this after reflect_capture.",
    parameters: preserveSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!sherpaWriteSideEnabled(state)) return { content: [{ type: "text" as const, text: writeSideMovedMessage() }], details: { movedTo: "archivist_preserve" } };
      const decision = evaluatePersistence({
        type: params.type,
        title: params.title,
        summary: params.summary,
        importance: params.importance,
        tags: params.tags,
      });

      if (decision.decision === "discard") {
        return {
          content: [{
            type: "text" as const,
            text: [
              `🚫 Discarded: "${params.title}"`,
              ``,
              `Reason: ${decision.reason}`,
              `Confidence: ${decision.confidence}`,
            ].join("\n"),
          }],
          details: { decision: "discard", reason: decision.reason, confidence: decision.confidence },
        };
      }

      const dest = params.storage && params.storage !== "auto"
        ? params.storage
        : decision.destination;

      if (dest === "none") {
        return {
          content: [{ type: "text", text: `⏭ Skipped: "${params.title}" — not worth persisting` }],
          details: { decision: "discard", reason: decision.reason, refId: params.refId },
        };
      }

      const syncResult = await syncReflectMemory(memoryPaths(ctx), { refId: params.refId, destination: dest });

      return {
        content: [{
          type: "text" as const,
          text: [
            `✅ Persisted: "${params.title}"`,
            ``,
            `Destination: ${dest}`,
            `Confidence: ${decision.confidence}`,
            ``,
            `Reason: ${decision.reason}`,
            ``,
            syncResult,
          ].join("\n"),
        }],
        details: { decision: "persist", destination: dest, refId: params.refId, confidence: decision.confidence },
      };
    },
  });

  // ─── Sherpa Distill Tool ────────────────────────────────────────────
  // Evolves prompts, skills, MCP definitions, and behavioral rules from failures.

  const distillSchema = Type.Object({
    trigger: Type.String({ description: "What triggered this distillation: success | failure | pattern" }),
    task: Type.String({ description: "What was being attempted" }),
    outcome: Type.String({ description: "What happened — success, partial, or failure details" }),
    context: Type.Optional(Type.String({ description: "What led to this outcome" })),
    domain: Type.Optional(Type.String({ description: "Domain: python, typescript, git, trading, etc." })),
    existingSkill: Type.Optional(Type.String({ description: "Name of an existing skill to update/improve" })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for routing/update matching" })),
    operation: Type.Optional(Type.String({ description: "auto | create | update" })),
    mergePolicy: Type.Optional(Type.String({ description: "deterministic | llm | manual" })),
    targetPath: Type.Optional(Type.String({ description: "Existing memory path to update" })),
    targetId: Type.Optional(Type.String({ description: "Existing memory id to update" })),
  });

  pi.registerTool({
    name: "sherpa_distill",
    label: "Sherpa Distill",
    description: "Evolve prompts, skills, MCP definitions, and behavioral rules from failures and successes.",
    parameters: distillSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!sherpaWriteSideEnabled(state)) return { content: [{ type: "text" as const, text: writeSideMovedMessage() }], details: { movedTo: "archivist_distill" } };
      const distill = writeDistilledSkill({
        trigger: params.trigger,
        task: params.task,
        outcome: params.outcome,
        context: params.context,
        domain: params.domain,
        targetPath: params.targetPath,
      }, ctx.cwd, obsidianMemoryPath(state!));
      const { slug, skillPath } = distill;

      return {
        content: [{
          type: "text" as const,
          text: [
            `🧪 Distilled: ${params.task}`,
            "",
            `Trigger: ${params.trigger}`,
            `Domain: ${params.domain ?? "general"}`,
            `Scope: ${distill.destination === "explicit" ? "explicit target" : "obsidian project memory"}`,
            `Skill: ${skillPath}`,
            "",
            `**Lesson:** ${params.outcome.slice(0, 300)}`,
          ].join("\n"),
        }],
        details: { trigger: params.trigger, domain: params.domain, slug, skillPath, destination: distill.destination },
      };
    },
  });
  pi.registerCommand("sherpa:settings", { description: "Configure Sherpa", handler: async (_args, ctx) => {
    if (!state) state = restoreState(ctx, loadConfig(ctx.cwd));
    const picked = await ctx.ui.select("Sherpa setting", ["mode:auto", "mode:explicit", "mode:proactive", "mode:off", "toggle front-door", "toggle proactive", "choose model"]);
    if (!picked) return;
    if (picked.startsWith("mode:")) { state.config.mode = picked.slice(5) as Mode; state.config.enabled = state.config.mode !== "off"; }
    if (picked === "toggle front-door") state.config.frontDoor.enabled = !state.config.frontDoor.enabled;
    if (picked === "toggle proactive") state.config.proactive.enabled = !state.config.proactive.enabled;
    saveConfig(ctx.cwd, state.config); ctx.ui.setStatus("ai-sherpa", `Sherpa: ${state.config.enabled ? state.config.mode : "off"}`);
    if (picked === "choose model") pi.sendUserMessage("/sherpa:model", { deliverAs: "followUp" }); else ctx.ui.notify("Sherpa settings saved", "success");
  }});
}
