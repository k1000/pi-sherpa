/**
 * Agent-Curated Nudge Tool — Agent-triggered observation saving.
 *
 * Ported from Hermes Agent's agent-curated memory with periodic nudges.
 * The agent proactively saves observations, preferences, environment facts,
 * corrections, and conventions — with dedup, capacity management, and auto-compact.
 *
 * Hermes pattern: Agent decides what to remember, saves to MEMORY.md/USER.md
 * with strict char limits and consolidation pressure.
 *
 * Sherpa adaptation: Nudge writes to the existing scratchpad observation or
 * distill_candidate sections with SHA256 dedup and near-duplicate detection.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export type NudgeTarget = "observation" | "distill_candidate";
export const NUDGE_TARGETS: NudgeTarget[] = ["observation", "distill_candidate"];

export type NudgeResult = {
  written: boolean;
  deduped: boolean;
  nearDuplicate: boolean;
  capacityWarning: string | null;
  autoCompacted: boolean;
  path: string;
  entryCount: number;
  usagePercent: number;
};

export type NudgeConfig = {
  /** Scratchpad root directory (e.g., `.pi-memory/scratchpad`) */
  scratchpadRoot: string;
  /** Maximum bytes per section before warning. Default: 80_000 (80KB) */
  warnThresholdBytes?: number;
  /** Maximum bytes per section before auto-compact. Default: 95_000 (95KB) */
  compactThresholdBytes?: number;
  /** Maximum bytes to keep after auto-compact. Default: 40_000 (40KB) */
  compactTargetBytes?: number;
  /** Path to the nudge digest log (for dedup). Default: <scratchpadRoot>/nudge-digest.jsonl */
  digestPath?: string;
};

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_WARN_THRESHOLD = 80_000;
const DEFAULT_COMPACT_THRESHOLD = 95_000;
const DEFAULT_COMPACT_TARGET = 40_000;

// ── Token-overlap near-duplicate detector ────────────────────────────

/**
 * Simple token-overlap similarity heuristic.
 * Returns 0.0–1.0 similarity score.
 */
function tokenOverlapSimilarity(a: string, b: string): number {
  const tokensA = new Set(
    a.toLowerCase().split(/\W+/).filter((t) => t.length > 2),
  );
  const tokensB = new Set(
    b.toLowerCase().split(/\W+/).filter((t) => t.length > 2),
  );

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Digest log (dedup) ──────────────────────────────────────────────

function digestPath(root: string, configuredPath?: string): string {
  return configuredPath ? path.resolve(root, configuredPath) : path.join(root, "nudge-digest.jsonl");
}

function computeDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function loadDigests(root: string, configuredPath?: string): Set<string> {
  const dp = digestPath(root, configuredPath);
  if (!existsSync(dp)) return new Set();

  const digests = new Set<string>();
  const lines = readFileSync(dp, "utf8").split("\n").filter(Boolean);
  // Keep only the last 500 digests to prevent unbounded growth
  const recent = lines.slice(-500);
  for (const line of recent) {
    try {
      const entry = JSON.parse(line);
      if (entry.digest) digests.add(entry.digest);
    } catch {
      // Skip corrupt lines
    }
  }
  return digests;
}

function recordDigest(root: string, digest: string, configuredPath?: string): void {
  const dp = digestPath(root, configuredPath);
  const dir = path.dirname(dp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  appendFileSync(
    dp,
    JSON.stringify({
      digest,
      ts: new Date().toISOString(),
    }) + "\n",
    "utf8",
  );
}

// ── Capacity management ─────────────────────────────────────────────

function sectionPath(root: string, target: NudgeTarget): string {
  return path.join(root, "sections", `${target}.md`);
}

function sectionArchiveDir(root: string): string {
  return path.join(root, "archive");
}

function getSectionSize(root: string, target: NudgeTarget): number {
  const sp = sectionPath(root, target);
  if (!existsSync(sp)) return 0;
  return statSync(sp).size;
}

/**
 * Read existing entries from a section, stripping the header.
 */
function readSectionEntries(root: string, target: NudgeTarget): string[] {
  const sp = sectionPath(root, target);
  if (!existsSync(sp)) return [];

  const content = readFileSync(sp, "utf8").trim();
  // Strip the YAML-like header (first line if it starts with #)
  const body = content.replace(/^#.*\n/, "").trim();
  // Split on section markers (### or timestamps)
  const entries = body.split(/\n(?=###|## |\d{4}-\d{2}-\d{2})/).filter(Boolean);
  return entries;
}

/**
 * Get the number of entries in a section.
 */
function getEntryCount(root: string, target: NudgeTarget): number {
  const entries = readSectionEntries(root, target);
  return Math.max(1, entries.length); // At least 1 (the header/reduced form)
}

// ── Main API ────────────────────────────────────────────────────────

type WriteNudgeOptions = {
  /** Optional dedup key to combine with content for dedup. Default: content itself */
  dedupKey?: string;
  /** Skip dedup check. Default: false */
  skipDedup?: boolean;
};

type NudgeRuntime = {
  root: string;
  warnBytes: number;
  compactBytes: number;
  compactTarget: number;
  path: string;
  currentSize: number;
  usagePercent: number;
};

function nudgeRuntime(target: NudgeTarget, config: NudgeConfig): NudgeRuntime {
  const root = config.scratchpadRoot;
  const sectionsDir = path.join(root, "sections");
  if (!existsSync(sectionsDir)) mkdirSync(sectionsDir, { recursive: true });
  const warnBytes = config.warnThresholdBytes ?? DEFAULT_WARN_THRESHOLD;
  return {
    root,
    warnBytes,
    compactBytes: config.compactThresholdBytes ?? DEFAULT_COMPACT_THRESHOLD,
    compactTarget: config.compactTargetBytes ?? DEFAULT_COMPACT_TARGET,
    path: sectionPath(root, target),
    currentSize: getSectionSize(root, target),
    usagePercent: Math.round((getSectionSize(root, target) / warnBytes) * 100),
  };
}

function nudgeDigestKey(content: string, options?: WriteNudgeOptions): string {
  return options?.dedupKey ? `${content}||${options.dedupKey}` : content;
}

function dedupedNudgeResult(runtime: NudgeRuntime, target: NudgeTarget): NudgeResult {
  return {
    written: false,
    deduped: true,
    nearDuplicate: false,
    capacityWarning: null,
    autoCompacted: false,
    path: runtime.path,
    entryCount: getEntryCount(runtime.root, target),
    usagePercent: runtime.usagePercent,
  };
}

function contentHasNearDuplicate(root: string, target: NudgeTarget, content: string): boolean {
  for (const entry of readSectionEntries(root, target).slice(-20)) {
    const entryText = entry.replace(/^###\s+.*\n/, "").replace(/^-{3,}/, "").trim();
    if (entryText && tokenOverlapSimilarity(content, entryText) >= 0.8) return true;
  }
  return false;
}

function capacityWarningFor(newSize: number, warnBytes: number): string | null {
  if (newSize < warnBytes) return null;
  const pct = Math.round((newSize / warnBytes) * 100);
  return `Section at ${pct}% capacity (${Math.round(newSize / 1024)}KB/${Math.round(warnBytes / 1024)}KB). Consider consolidating.`;
}

function compactNudgeSection(root: string, target: NudgeTarget, sp: string, compactTarget: number): boolean {
  const archiveDir = sectionArchiveDir(root);
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

  const entries = readSectionEntries(root, target);
  const kept: string[] = [];
  let keptSize = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const entrySize = Buffer.byteLength(entry, "utf8");
    if (keptSize + entrySize <= compactTarget || kept.length === 0) {
      kept.unshift(entry);
      keptSize += entrySize;
      if (keptSize > compactTarget) break;
    } else {
      break;
    }
  }

  const archiveStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(archiveDir, `${archiveStamp}-${target}-nudge-archive.md`);
  const archived = entries.slice(0, entries.length - kept.length);
  if (archived.length > 0) {
    writeFileSync(archivePath, `# Archived ${target} entries — ${archiveStamp}\n\n${archived.join("\n\n---\n\n")}\n`, "utf8");
  }

  const header = `# ${target} — compacted\n\nOlder entries archived to \`archive/${path.basename(archivePath)}\`.\n\n`;
  writeFileSync(sp, header + kept.join("\n\n"), "utf8");
  return true;
}

function appendNudgeEntry(sp: string, content: string): void {
  appendFileSync(sp, `\n\n### Nudge — ${new Date().toISOString()}\n\n${content.trim()}`, "utf8");
}

/**
 * Write a nudge entry to the scratchpad.
 *
 * - Deduplicates exact matches via SHA256 digest
 * - Warns on near-duplicates (80%+ token overlap)
 * - Warns when capacity exceeds threshold
 * - Auto-compacts when capacity exceeds compact threshold
 *
 * Returns a NudgeResult describing what happened.
 */
export function writeNudge(
  target: NudgeTarget,
  content: string,
  config: NudgeConfig,
  options?: WriteNudgeOptions,
): NudgeResult {
  const runtime = nudgeRuntime(target, config);
  const digest = computeDigest(nudgeDigestKey(content, options));

  if (!options?.skipDedup && loadDigests(runtime.root, config.digestPath).has(digest)) {
    return dedupedNudgeResult(runtime, target);
  }

  const nearDuplicate = !options?.skipDedup && contentHasNearDuplicate(runtime.root, target, content);
  const newSize = runtime.currentSize + Buffer.byteLength(content, "utf8");
  const capacityWarning = capacityWarningFor(newSize, runtime.warnBytes);
  const autoCompacted = newSize >= runtime.compactBytes
    ? compactNudgeSection(runtime.root, target, runtime.path, runtime.compactTarget)
    : false;

  appendNudgeEntry(runtime.path, content);
  if (!options?.skipDedup) recordDigest(runtime.root, digest, config.digestPath);

  return {
    written: true,
    deduped: false,
    nearDuplicate,
    capacityWarning,
    autoCompacted,
    path: runtime.path,
    entryCount: getEntryCount(runtime.root, target),
    usagePercent: Math.round((newSize / runtime.warnBytes) * 100),
  };
}

/**
 * Check the current capacity status of a scratchpad section.
 */
export function checkCapacity(
  target: NudgeTarget,
  config: NudgeConfig,
): { usagePercent: number; totalBytes: number; warnBytes: number; entryCount: number } {
  const root = config.scratchpadRoot;
  const warnBytes = config.warnThresholdBytes ?? DEFAULT_WARN_THRESHOLD;
  const currentSize = getSectionSize(root, target);
  return {
    usagePercent: Math.round((currentSize / warnBytes) * 100),
    totalBytes: currentSize,
    warnBytes,
    entryCount: getEntryCount(root, target),
  };
}
