/**
 * Auto-Distillation on Task End — Hook lifecycle tracking to auto-invoke archivist_distill.
 *
 * Ported from Hermes Agent's session-end memory extraction pattern.
 * When a task completes with detected learnings, Sherpa auto-invokes
 * archivist_distill to persist reusable procedures.
 *
 * Hermes pattern: Memory providers auto-extract facts on session commit.
 * Sherpa adaptation: After a completed task with >3 file changes, check
 * the distill_candidate section and invoke archivist_distill for new entries.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export type DistillTrigger = {
  outcome: string;
  changedFiles: number;
  hasDistillCandidates: boolean;
};

export type AutoDistillResult = {
  triggered: boolean;
  reason: string;
  candidatesFound: number;
  candidatesDistilled: number;
  dryRun: boolean;
  domains: string[];
};

export type AutoDistillConfig = {
  /** Path to the scratchpad root directory */
  scratchpadRoot: string;
  /** Minimum changed files to trigger auto-distill. Default: 3 */
  minChangedFiles?: number;
  /** Whether auto-distill is enabled. Default: true */
  enabled?: boolean;
  /** Marker file path to disable auto-distill. Default: <scratchpadRoot>/.auto-distill-mode */
  suppressMarkerPath?: string;
};

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MIN_CHANGED_FILES = 3;

// ── State tracking ──────────────────────────────────────────────────

function lastDistillMarkerPath(root: string): string {
  return path.join(root, "last-auto-distill.txt");
}

function getLastDistillRun(root: string): string | null {
  const p = lastDistillMarkerPath(root);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim() || null;
}

export function markAutoDistillRun(root: string): void {
  const dir = path.dirname(lastDistillMarkerPath(root));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(lastDistillMarkerPath(root), new Date().toISOString(), "utf8");
}

function isSuppressed(root: string, config: AutoDistillConfig): boolean {
  const p = config.suppressMarkerPath ?? path.join(root, ".auto-distill-mode");
  if (!existsSync(p)) return false;
  const content = readFileSync(p, "utf8").trim().toUpperCase();
  return content.includes("AUTO_DISTILL_OFF");
}

// ── Distill candidate reading ───────────────────────────────────────

function distillCandidatesPath(root: string): string {
  return path.join(root, "sections", "distill_candidate.md");
}

/**
 * Read distill candidates that were added since the last auto-distill run.
 */
function readNewCandidates(root: string, since: string | null): string[] {
  const p = distillCandidatesPath(root);
  if (!existsSync(p)) return [];

  const content = readFileSync(p, "utf8");
  const entries = content.split(/\n(?=###)/).map((entry) => entry.trim()).filter((entry) => entry.startsWith("###"));

  if (!since) return entries; // First run — distill all existing

  // Only return entries added after the last run
  const newEntries: string[] = [];
  for (const entry of entries) {
    const tsMatch = entry.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    if (tsMatch && tsMatch[1]! >= since.slice(0, 16)) {
      newEntries.push(entry);
    }
  }
  return newEntries;
}

// ── Domain detection ────────────────────────────────────────────────

/**
 * Simple domain detection from distill candidate text.
 * Looks for keywords to determine the domain for archivist_distill.
 */
function detectDomain(text: string): string {
  const lower = text.toLowerCase();

  const domainPatterns: Array<[RegExp, string]> = [
    [/\b(typescript|javascript|ts|js|node|bun|deno)\b/, "typescript"],
    [/\b(python|pytest|pip|uv|django|fastapi|flask)\b/, "python"],
    [/\b(trading|strategy|backtest|grid|bot|order|position|portfolio)\b/, "trading"],
    [/\b(react|vue|svelte|angular|css|html|frontend|ui|component)\b/, "frontend"],
    [/\b(sql|postgres|mysql|sqlite|database|schema|migration|query)\b/, "database"],
    [/\b(docker|kubernetes|k8s|deploy|ci|cd|github.actions)\b/, "devops"],
    [/\b(sherpa|archivist|pi.agent|extension|tool)\b/, "ai-agents"],
    [/\b(crypto|ethereum|solana|web3|smart.contract|defi)\b/, "blockchain"],
    [/\b(rust|cargo|crates|unsafe|trait|impl)\b/, "rust"],
    [/\b(go|golang|goroutine|channel|interface)\b/, "go"],
    [/\b(machine.learning|deep.learning|llm|model|training|inference)\b/, "ai"],
    [/\b(api|rest|graphql|grpc|endpoint|route|middleware)\b/, "api"],
  ];

  for (const [pattern, domain] of domainPatterns) {
    if (pattern.test(lower)) return domain;
  }

  return "general";
}

// ── Main API ────────────────────────────────────────────────────────

/**
 * Check whether auto-distillation should be triggered.
 *
 * Conditions:
 * 1. Auto-distill is enabled
 * 2. Suppression file is not present
 * 3. Task outcome is "completed"
 * 4. More than minChangedFiles files were changed
 * 5. There are new distill candidates since last run
 */
export function checkAutoDistill(
  trigger: DistillTrigger,
  config: AutoDistillConfig,
): { shouldTrigger: boolean; reason: string; newCandidates: string[] } {
  if (config.enabled === false) {
    return { shouldTrigger: false, reason: "auto-distill disabled", newCandidates: [] };
  }

  if (isSuppressed(config.scratchpadRoot, config)) {
    return { shouldTrigger: false, reason: "suppressed by .auto-distill-mode", newCandidates: [] };
  }

  const minFiles = config.minChangedFiles ?? DEFAULT_MIN_CHANGED_FILES;

  if (trigger.outcome !== "completed") {
    return { shouldTrigger: false, reason: `outcome is '${trigger.outcome}', not 'completed'`, newCandidates: [] };
  }

  if (trigger.changedFiles < minFiles) {
    return { shouldTrigger: false, reason: `only ${trigger.changedFiles} files changed, need ${minFiles}`, newCandidates: [] };
  }

  const lastRun = getLastDistillRun(config.scratchpadRoot);
  const newCandidates = readNewCandidates(config.scratchpadRoot, lastRun);

  if (newCandidates.length === 0) {
    return { shouldTrigger: false, reason: "no new distill candidates since last run", newCandidates: [] };
  }

  return {
    shouldTrigger: true,
    reason: `${newCandidates.length} new distill candidate(s) after completed task with ${trigger.changedFiles} file changes`,
    newCandidates,
  };
}

/**
 * Prepare the archivist_distill arguments from new candidates.
 * Returns an array of { trigger, task, outcome, context, domain } objects.
 *
 * Does NOT call archivist_distill itself — returns the prepared data so
 * the caller (index.ts) can invoke it through the proper API.
 */
export function prepareDistillPayloads(
  newCandidates: string[],
): Array<{
  trigger: string;
  task: string;
  outcome: string;
  context: string;
  domain: string;
}> {
  return newCandidates.map((entry) => {
    // Extract title from ### header
    const titleMatch = entry.match(/###\s+(.+)/);
    const title = titleMatch?.[1]?.trim() ?? "Auto-distilled task";

    // Extract content body (everything after the header)
    const body = entry.replace(/^###\s+.*\n/, "").trim();

    // Detect domain from the full entry
    const domain = detectDomain(entry);

    return {
      trigger: "auto-distill",
      task: title,
      outcome: body.length > 200 ? body.slice(0, 200) + "..." : body,
      context: body,
      domain,
    };
  });
}

/**
 * Get current auto-distill status for display.
 */
export function getAutoDistillStatus(config: AutoDistillConfig): {
  enabled: boolean;
  suppressed: boolean;
  minChangedFiles: number;
  lastRun: string | null;
  candidateCount: number;
} {
  const suppressed = isSuppressed(config.scratchpadRoot, config);
  const lastRun = getLastDistillRun(config.scratchpadRoot);
  const p = distillCandidatesPath(config.scratchpadRoot);
  const candidateCount = existsSync(p)
    ? readFileSync(p, "utf8").split(/\n(?=###)/).filter(Boolean).length
    : 0;

  return {
    enabled: config.enabled !== false,
    suppressed,
    minChangedFiles: config.minChangedFiles ?? DEFAULT_MIN_CHANGED_FILES,
    lastRun,
    candidateCount,
  };
}
