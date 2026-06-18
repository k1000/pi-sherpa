import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type AutomationRunStats = {
  runs: number;
  failures: number;
  lastStatus: "passed" | "failed";
  lastDurationMs: number;
  lastRunAt: string;
  lastError?: string;
};

export type AutomationState = {
  commandCounts: Record<string, number>;
  candidateHashes: string[];
  runStats: Record<string, AutomationRunStats>;
};

export type RunnableAutomation = {
  name: string;
  kind: "package-script" | "repo-script";
  command: string;
  cwd: string;
  safety: "safe" | "needs-approval" | "unsafe";
  purpose?: string;
  timeoutMs?: number;
  requiredEnv?: string[];
  sideEffects?: "none" | "files" | "network" | "database" | "git" | "unknown";
};

export type AutomationCandidate = {
  title: string;
  command: string;
  count: number;
  hash: string;
  confidence: "medium" | "high";
  safety: "safe" | "needs-approval" | "unsafe";
  proposedArtifact: string;
  markdown: string;
};

const SAFE_PREFIXES = [
  "pnpm ",
  "npm test",
  "npm run",
  "yarn ",
  "bun test",
  "vitest ",
  "rg ",
  "find ",
  "ls ",
  "git status",
  "git diff",
  "git log",
  "node ",
  "tsx ",
  "tsc ",
  "eslint ",
  "python ",
  "python3 ",
  "pytest ",
  "ruff ",
  "mypy ",
];

const NEEDS_APPROVAL = [
  "git push",
  "git commit",
  "git tag",
  "pnpm db:",
  "npm run db:",
  "docker ",
  "kubectl ",
  "ssh ",
  "scp ",
  "rsync ",
];

const UNSAFE = [
  "rm -rf",
  "git reset --hard",
  "git clean",
  "drop database",
  "truncate table",
  "db:push",
];

export function createAutomationState(): AutomationState {
  return { commandCounts: {}, candidateHashes: [], runStats: {} };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeCommand(command: string) {
  return command
    .replace(/\s+/g, " ")
    .replace(/^cd [^&]+&&\s*/, "")
    .trim();
}

export function extractCommandsFromText(text: string): string[] {
  const commands = new Set<string>();

  for (const match of text.matchAll(/"command"\s*:\s*"((?:\\"|[^"])*)"/g)) {
    try {
      const parsed = JSON.parse(`"${match[1]}"`);
      const normalized = normalizeCommand(parsed);
      if (isCandidateCommand(normalized)) commands.add(normalized);
    } catch {
      // ignore malformed JSON fragments
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[$>]\s*/, "");
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
    if (isCandidateCommand(trimmed)) commands.add(normalizeCommand(trimmed));
  }

  return [...commands];
}

function isCandidateCommand(command: string) {
  if (command.length < 8 || command.length > 500) return false;
  if (/token|password|secret|api[_-]?key|bearer\s+[a-z0-9._-]+/i.test(command)) return false;
  return /\b(pnpm|npm|yarn|bun|vitest|tsx|tsc|eslint|node|python|python3|pytest|ruff|mypy|rg|find|git|docker|kubectl|ssh|rsync)\b/.test(command);
}

export function classifyAutomationSafety(command: string, metadata?: Partial<RunnableAutomation>): AutomationCandidate["safety"] {
  if (metadata?.sideEffects && metadata.sideEffects !== "none") return metadata.sideEffects === "unknown" ? "needs-approval" : "needs-approval";
  const lower = command.toLowerCase();
  if (UNSAFE.some((pattern) => lower.includes(pattern))) return "unsafe";
  if (NEEDS_APPROVAL.some((pattern) => lower.startsWith(pattern) || lower.includes(`&& ${pattern}`))) return "needs-approval";
  if (SAFE_PREFIXES.some((pattern) => lower.startsWith(pattern))) return "safe";
  return "needs-approval";
}

export function parseAutomationMetadata(content: string): Partial<RunnableAutomation> {
  const metadata: Partial<RunnableAutomation> = {};
  const header = content.slice(0, 2000);
  const readTag = (tag: string) => {
    const match = header.match(new RegExp(`@sherpa-${tag}\\s+([^\\n\\r*]+)`, "i"));
    return match?.[1]?.trim();
  };

  const purpose = readTag("purpose");
  if (purpose) metadata.purpose = purpose;

  const timeout = readTag("timeout");
  if (timeout && /^\d+$/.test(timeout)) metadata.timeoutMs = Number(timeout);

  const env = readTag("env");
  if (env) metadata.requiredEnv = env.split(/[ ,]+/).map((item) => item.trim()).filter(Boolean);

  const sideEffects = readTag("side-effects")?.toLowerCase();
  if (sideEffects && ["none", "files", "network", "database", "git", "unknown"].includes(sideEffects)) {
    metadata.sideEffects = sideEffects as RunnableAutomation["sideEffects"];
  }

  const safe = readTag("safe")?.toLowerCase();
  if (safe === "false") metadata.safety = "needs-approval";
  if (safe === "true" && (!metadata.sideEffects || metadata.sideEffects === "none")) metadata.safety = "safe";

  return metadata;
}

function titleForCommand(command: string) {
  if (command.includes("vitest") || command.includes(" test")) return "Automate repeated test command";
  if (command.includes("typecheck")) return "Automate repeated typecheck command";
  if (command.startsWith("rg ")) return "Automate repeated code search";
  if (command.startsWith("git status") || command.startsWith("git diff")) return "Automate repeated git inspection";
  return "Automate repeated command";
}

function detectProjectLanguage(cwd: string): "typescript" | "javascript" | "python" | "unknown" {
  if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "requirements.txt"))) return "python";
  if (existsSync(path.join(cwd, "tsconfig.json"))) return "typescript";
  if (existsSync(path.join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (pkg.type === "module" || deps.typescript || deps.tsx || deps["ts-node"]) return "typescript";
    } catch {
      // ignore malformed package.json
    }
    return "javascript";
  }
  return "unknown";
}

function preferredScriptPattern(cwd: string) {
  const language = detectProjectLanguage(cwd);
  if (language === "typescript") return "scripts/*.ts plus a package.json script";
  if (language === "javascript") return "scripts/*.js plus a package.json script";
  if (language === "python") return "scripts/*.py or a package-native CLI entrypoint";
  return "scripts/* helper using the project's existing automation language";
}

function artifactForCommand(command: string, safety: AutomationCandidate["safety"], cwd: string) {
  if (safety !== "safe") return "project scratchpad automation proposal (approval required)";
  if (command.includes("pnpm") || command.includes("vitest")) return `package.json script or ${preferredScriptPattern(cwd)}`;
  return `${preferredScriptPattern(cwd)} or Sherpa automation skill`;
}

export function updateAutomationCandidates(
  state: AutomationState,
  text: string,
  threshold = 3,
  cwd = process.cwd(),
): AutomationCandidate[] {
  const commands = extractCommandsFromText(text);
  const candidates: AutomationCandidate[] = [];

  for (const command of commands) {
    const count = (state.commandCounts[command] ?? 0) + 1;
    state.commandCounts[command] = count;
    if (count < threshold) continue;

    const candidateHash = hash(command);
    if (state.candidateHashes.includes(candidateHash)) continue;

    const safety = classifyAutomationSafety(command);
    if (safety === "unsafe") continue;

    const title = titleForCommand(command);
    const proposedArtifact = artifactForCommand(command, safety, cwd);
    const confidence = count >= threshold + 2 ? "high" : "medium";
    const markdown = [
      "## Automation Candidate",
      "",
      `Title: ${title}`,
      `Confidence: ${confidence}`,
      `Safety: ${safety}`,
      "",
      "### Repeated workflow",
      `1. \`${command}\``,
      "",
      "### Why automate",
      `- Observed ${count} times in Sherpa session/tool history.`,
      "- Repetition suggests this should become a reusable check or helper.",
      "",
      "### Proposed artifact",
      `- ${proposedArtifact}`,
      "",
      "### Language policy",
      `- Prefer the project-native automation language (${detectProjectLanguage(cwd)} detected).`,
      "",
      "### Suggested implementation",
      "```bash",
      command,
      "```",
      "",
      "### Validation",
      "- Run the command once from a clean working tree and confirm output/exit code.",
    ].join("\n");

    state.candidateHashes = [...state.candidateHashes.slice(-49), candidateHash];
    candidates.push({ title, command, count, hash: candidateHash, confidence, safety, proposedArtifact, markdown });
  }

  return candidates;
}

function discoverPackageScripts(cwd: string): RunnableAutomation[] {
  const packageJson = path.join(cwd, "package.json");
  if (!existsSync(packageJson)) return [];
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8"));
    const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
    return Object.entries(scripts)
      .filter(([, v]) => typeof v === "string")
      .map(([name, commandValue]) => ({
        name,
        kind: "package-script" as const,
        command: `pnpm run ${name}`,
        cwd,
        safety: classifyAutomationSafety(String(commandValue)),
        purpose: `package.json script: ${name}`,
      }));
  } catch {
    return [];
  }
}

function scriptFileCommand(rel: string, name: string): string {
  if (name.endsWith(".sh")) return `bash ${rel}`;
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return `pnpm exec tsx ${rel}`;
  if (name.endsWith(".py")) return `python3 ${rel}`;
  return `node ${rel}`;
}

function discoverScriptsDir(cwd: string): RunnableAutomation[] {
  const scriptsDir = path.join(cwd, "scripts");
  if (!existsSync(scriptsDir)) return [];
  try {
    return readdirSync(scriptsDir).sort()
      .filter((name) => {
        const scriptPath = path.join(scriptsDir, name);
        return statSync(scriptPath).isFile() && /\.(sh|js|mjs|cjs|ts|tsx|py)$/.test(name);
      })
      .map((name) => {
        const rel = path.relative(cwd, path.join(scriptsDir, name)).replace(/\\/g, "/");
        const command = scriptFileCommand(rel, name);
        const metadata = parseAutomationMetadata(readFileSync(path.join(scriptsDir, name), "utf8"));
        return {
          name: rel,
          kind: "repo-script" as const,
          command,
          cwd,
          ...metadata,
          safety: metadata.safety ?? classifyAutomationSafety(command, metadata),
        };
      });
  } catch {
    return [];
  }
}

export function discoverRunnableAutomations(cwd: string): RunnableAutomation[] {
  return [...discoverPackageScripts(cwd), ...discoverScriptsDir(cwd)];
}

export function findRunnableAutomation(cwd: string, name: string) {
  return discoverRunnableAutomations(cwd).find((automation) => automation.name === name || automation.command === name);
}

export function recordAutomationRun(
  state: AutomationState,
  automation: RunnableAutomation,
  status: "passed" | "failed",
  durationMs: number,
  error?: string,
) {
  const previous = state.runStats[automation.name] ?? { runs: 0, failures: 0, lastStatus: status, lastDurationMs: 0, lastRunAt: "" };
  state.runStats[automation.name] = {
    runs: previous.runs + 1,
    failures: previous.failures + (status === "failed" ? 1 : 0),
    lastStatus: status,
    lastDurationMs: durationMs,
    lastRunAt: new Date().toISOString(),
    ...(error ? { lastError: error.slice(0, 500) } : {}),
  };
}

export function formatRunnableAutomation(automation: RunnableAutomation, stats?: AutomationRunStats) {
  const parts = [`[${automation.safety}] ${automation.name}: ${automation.command}`];
  if (automation.purpose) parts.push(`purpose=${automation.purpose}`);
  if (automation.sideEffects) parts.push(`sideEffects=${automation.sideEffects}`);
  if (automation.timeoutMs) parts.push(`timeoutMs=${automation.timeoutMs}`);
  if (automation.requiredEnv?.length) parts.push(`env=${automation.requiredEnv.join(",")}`);
  if (stats) parts.push(`runs=${stats.runs}`, `failures=${stats.failures}`, `last=${stats.lastStatus}`);
  return parts.join(" | ");
}
