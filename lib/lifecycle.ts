import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CatalogRow } from "./catalog";

export type TaskOutcome = "completed" | "partial" | "blocked" | "failed" | "reverted" | "unknown";
export type LifecycleStage = "active" | "fading" | "archived";
export type KnowledgeGap = { entity: string; mentionCount: number; firstSeenAt: number; lastSeenAt: number; hasCatalogEntry: boolean };

export type VerificationAdvice = {
  commands: Array<{ command: string; reason: string }>;
  docsReview: boolean;
  catalogReview: boolean;
};

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|sql|json|md|yml|yaml)$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export function computeLifecycleStage(lastAccessedAt: number | undefined, confidence: number | undefined, now = Date.now()): LifecycleStage {
  if (typeof confidence === "number" && confidence >= 8) return "active";
  if (lastAccessedAt === undefined) return "active";
  const daysSinceAccess = Math.max(0, (now - lastAccessedAt) / DAY_MS);
  if (daysSinceAccess > 60) return "archived";
  if (daysSinceAccess > 30) return "fading";
  return "active";
}

const COMMON_CAPITALIZED_TERMS = new Set(["The", "This", "That", "These", "Those", "When", "Where", "What", "Why", "How", "Please", "Sherpa", "Pi"]);

function catalogContainsEntity(entity: string, catalog: CatalogRow[]): boolean {
  const normalized = entity.toLowerCase();
  return catalog.some((row) => Object.values(row).some((value) => {
    const text = String(value ?? "").toLowerCase();
    return text === normalized || text.includes(normalized);
  }));
}

export function detectKnowledgeGaps(focus: string, recentMessages: string[], catalog: CatalogRow[]): KnowledgeGap[] {
  const counts = new Map<string, { entity: string; mentionCount: number; firstSeenAt: number; lastSeenAt: number }>();
  const messages = [focus, ...recentMessages];
  messages.forEach((message, index) => {
    const seenInMessage = new Set<string>();
    for (const match of message.matchAll(/\b(?:[A-Z][A-Za-z0-9]+|[A-Z]{2,})(?:[\s-]+(?:[A-Z][A-Za-z0-9]+|[A-Z]{2,}))*\b/g)) {
      const entity = match[0].replace(/\s+/g, " ").trim();
      if (entity.length < 4 || COMMON_CAPITALIZED_TERMS.has(entity)) continue;
      const key = entity.toLowerCase();
      if (seenInMessage.has(key)) continue;
      seenInMessage.add(key);
      const at = index + 1;
      const existing = counts.get(key) ?? { entity, mentionCount: 0, firstSeenAt: at, lastSeenAt: at };
      existing.mentionCount++;
      existing.lastSeenAt = at;
      counts.set(key, existing);
    }
  });
  return [...counts.values()]
    .map((gap) => ({ ...gap, hasCatalogEntry: catalogContainsEntity(gap.entity, catalog) }))
    .filter((gap) => gap.mentionCount >= 2 && !gap.hasCatalogEntry)
    .sort((a, b) => b.mentionCount - a.mentionCount || a.entity.localeCompare(b.entity));
}

export function formatKnowledgeGapsForCompiler(gaps: KnowledgeGap[]): string {
  if (!gaps.length) return "";
  return [
    "Knowledge gaps detected:",
    ...gaps.map((gap) => `- ${gap.entity} (${gap.mentionCount} mentions; missing catalog entry)`),
    "Consider whether docs, web, or project memory retrieval should cover these entities.",
  ].join("\n");
}

export function classifyTaskOutcome(text: string): { outcome: TaskOutcome; reason: string } {
  const lower = text.toLowerCase();
  const tail = lower.slice(-2500);
  const normalized = tail.replace(/\b0\s+(failed|failures?|errors?)\b/g, "zero test issues");

  if (/\b(revert(ed)?|rolled back|rollback|discarded changes)\b/.test(tail)) return { outcome: "reverted", reason: "revert/rollback signal detected" };
  if (/\b(blocked|cannot proceed|waiting on|needs approval|missing credentials|permission denied)\b/.test(tail)) return { outcome: "blocked", reason: "blocked/waiting signal detected" };

  // Prefer final-task intent over historical logs in the transcript. Error text is
  // often the bug being fixed, not evidence that the task failed.
  const completionSignal = /\b(done|completed|implemented|fixed|resolved|verified|successfully|tests? pass(?:ed)?|all tests pass|bun test[^\n]*(?:pass|passed)|\d+\s+pass(?:ed)?)\b/.test(normalized);
  const explicitFailure = /\b(typecheck failed|tests failed|test failed|exit code [1-9]|could not|not fixed|still failing|failed to fix|unable to|crash(?:ed)?|fatal)\b/.test(normalized);

  if (explicitFailure && !completionSignal) return { outcome: "failed", reason: "explicit final failure signal detected" };
  if (/\b(partial|in progress|remaining|todo|follow[- ]?up|next steps?)\b/.test(tail) && !completionSignal) return { outcome: "partial", reason: "partial/follow-up signal detected" };
  if (completionSignal) return { outcome: "completed", reason: "completion/verification signal detected" };
  if (/\b(error|exception)\b/.test(normalized)) return { outcome: "partial", reason: "error/debug signal without final failure" };
  return { outcome: "unknown", reason: "no strong lifecycle signal detected" };
}

export function suggestVerificationCommands(changedFiles: string[]): VerificationAdvice {
  const commands: VerificationAdvice["commands"] = [];
  const hasTs = changedFiles.some((file) => /\.(ts|tsx)$/.test(file));
  const hasJs = changedFiles.some((file) => /\.(js|jsx|mjs|cjs)$/.test(file));
  const hasPy = changedFiles.some((file) => /\.py$/.test(file));
  const hasWorker = changedFiles.some((file) => file.includes("apps/workers") || file.includes("packages/domains/workers") || file.includes("worker"));
  const hasSchema = changedFiles.some((file) => file.includes("db/drizzle") || /migration|schema/i.test(file));
  const hasSherpa = changedFiles.some((file) => file.includes("pi-sherpa") || file.includes(".pi/sherpa"));
  const hasHyperPodFrontend = changedFiles.some((file) => file === "src/server/public/client.js" || file === "src/server/public/index.html" || file === "src/server/public/styles.css");
  const hasPiExtension = changedFiles.some((file) => file.includes(".pi/extensions/") || (file.includes("/extensions/") && file.endsWith(".ts")));
  const hasDocs = changedFiles.some((file) => /(^|\/)docs\/|README|AGENTS\.md|catalog\.csv/.test(file));

  if (hasHyperPodFrontend) commands.push({ command: "bun test src/server/frontend.test.ts", reason: "HyperPod frontend assets changed" });
  if (hasTs) commands.push({ command: "pnpm typecheck", reason: "TypeScript files changed" });
  if (hasWorker) commands.push({ command: "pnpm --filter workers typecheck", reason: "worker-related files changed" });
  if (hasPy) commands.push({ command: "pytest", reason: "Python files changed" });
  if (hasSchema) commands.push({ command: "pnpm db:generate", reason: "schema/migration files changed; inspect generated SQL before applying" });
  if (hasSherpa) commands.push({ command: "pnpm exec esbuild /Users/kamil/.pi/agent/extensions/pi-sherpa/index.ts --bundle --platform=node --format=esm --external:@mariozechner/pi-ai --external:@mariozechner/pi-coding-agent --external:typebox --outfile=/tmp/pi-sherpa-check.mjs", reason: "Sherpa extension changed" });
  if (hasPiExtension) commands.push({ command: "pi /reload", reason: "Pi extension changed; reload or restart Pi and smoke-test the hook" });
  if (hasJs && !hasHyperPodFrontend) commands.push({ command: "bun test", reason: "JavaScript files changed" });

  const unique = new Map(commands.map((item) => [item.command, item]));
  return { commands: [...unique.values()].slice(0, 8), docsReview: !hasDocs && changedFiles.some((file) => SOURCE_EXT.test(file)), catalogReview: changedFiles.some((file) => file === "catalog.csv" || file.startsWith("scripts/") || file.includes("docs/") || file.includes("package.json")) };
}

function splitScratchpadEntries(raw: string): string[] {
  const matches = [...raw.matchAll(/^### .*$/gm)];
  if (!matches.length) return raw.trim() ? [raw] : [];
  return matches.map((match, index) => raw.slice(match.index!, matches[index + 1]?.index ?? raw.length));
}

function entryLastAccessedAt(entry: string): number | undefined {
  const match = entry.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/);
  if (!match) return undefined;
  const time = Date.parse(match[0]);
  return Number.isFinite(time) ? time : undefined;
}

function entryConfidence(entry: string): number | undefined {
  const match = entry.match(/\bconfidence\s*[:=]\s*(\d+(?:\.\d+)?)\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export function compactScratchpadLifecycle(root: string, options: { now?: number; archiveDir?: string } = {}) {
  const sectionsDir = path.join(root, "sections");
  if (!existsSync(sectionsDir)) return { archived: [] as string[] };
  const archiveDir = options.archiveDir ?? path.join(root, ".archived");
  const now = options.now ?? Date.now();
  const archived: string[] = [];

  for (const file of readdirSync(sectionsDir)) {
    if (!file.endsWith(".md")) continue;
    const target = path.join(sectionsDir, file);
    const stat = statSync(target);
    if (!stat.isFile()) continue;
    const raw = readFileSync(target, "utf8");
    const entries = splitScratchpadEntries(raw);
    const keep: string[] = [];
    const move: string[] = [];
    for (const entry of entries) {
      const stage = computeLifecycleStage(entryLastAccessedAt(entry), entryConfidence(entry), now);
      if (stage === "archived") move.push(entry.trim());
      else keep.push(entry.trim());
    }
    if (!move.length) continue;
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, file);
    const existing = existsSync(archivePath) ? readFileSync(archivePath, "utf8").trim() : "";
    writeFileSync(archivePath, [existing, ...move].filter(Boolean).join("\n\n") + "\n");
    writeFileSync(target, keep.length ? keep.join("\n\n") + "\n" : "");
    archived.push(file);
  }

  return { archived };
}

export function compactScratchpad(root: string, options: { maxBytes?: number; archiveDir?: string } = {}) {
  const sectionsDir = path.join(root, "sections");
  if (!existsSync(sectionsDir)) return { compacted: [] as string[] };
  const maxBytes = options.maxBytes ?? 80_000;
  const archiveDir = options.archiveDir ?? path.join(root, "archive");
  const compacted: string[] = [];

  for (const file of readdirSync(sectionsDir)) {
    if (!file.endsWith(".md")) continue;
    const target = path.join(sectionsDir, file);
    const stat = statSync(target);
    if (!stat.isFile() || stat.size <= maxBytes) continue;
    const raw = readFileSync(target, "utf8");
    const keep = raw.slice(-Math.floor(maxBytes * 0.75));
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${new Date().toISOString().slice(0, 10)}-${file}`);
    writeFileSync(archivePath, raw.slice(0, raw.length - keep.length));
    writeFileSync(target, [`# ${file.replace(/\.md$/, "")} — compacted`, "", `Older entries archived to ${path.relative(root, archivePath)}.`, "", keep.trim(), ""].join("\n"));
    compacted.push(file);
  }

  return { compacted };
}
