import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getProjectKBBasedir } from "./project-kb";

export type AutoMemoryState = {
  lastAgentEndAt: number;
  lastSessionEventAt: number;
  writtenHashes: string[];
  docAuditHashes: string[];
};

export type AutoMemoryConfig = {
  cwd: string;
  obsidianVault: string;
  obsidianMemoryPath: string;
  appendScratchpadCandidate: (text: string, title?: string) => void;
};

export function createAutoMemoryState(): AutoMemoryState {
  return { lastAgentEndAt: 0, lastSessionEventAt: 0, writtenHashes: [], docAuditHashes: [] };
}

export function stringifyForAutoMemory(value: unknown, max = 12000): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, (_key, val) => {
      if (typeof val === "string" && val.length > 1000) return `${val.slice(0, 1000)}…`;
      return val;
    });
    return (text ?? "").slice(0, max);
  } catch {
    return String(value ?? "").slice(0, max);
  }
}

export function hashAutoMemory(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Naive keyword extractor — DEPRECATED.
 *
 * This regex-based approach misses research findings, conclusions, and
 * emergent patterns because it only matches imperative keywords
 * ("must", "should", "always", etc.). Real knowledge extraction requires
 * reading comprehension, not pattern matching.
 *
 * Archivist now uses its dedicated model for session analysis.
 * This function is kept for backward compatibility but returns empty.
 */
export function extractAutoMemoryCandidates(_text: string): string[] {
  return [];
}

function ensureObsidianMemoryDirs(obsidianMemoryPath: string): string {
  for (const dir of [
    "wiki/systems",
    "wiki/procedures",
    "wiki/decisions",
    "wiki/concepts",
    "wiki/evidence",
    "journal",
    "inbox",
    // Note: sources/ is intentionally NOT auto-created. It is for external
    // material only (papers, articles, third-party reports). Repo docs live
    // in the repo and are retrieved via Sherpa's file source — never mirrored.
  ]) {
    mkdirSync(path.join(obsidianMemoryPath, dir), { recursive: true });
  }
  return obsidianMemoryPath;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function writeAutoMemoryArtifact(
  state: AutoMemoryState,
  config: AutoMemoryConfig,
  reason: string,
  rawText: string,
) {
  getProjectKBBasedir(config.cwd); // Keep repo-local scratchpad/scaffold available; durable memory lives in Obsidian.
  const obsidianBase = ensureObsidianMemoryDirs(config.obsidianMemoryPath);
  const hash = hashAutoMemory(`${reason}\n${rawText}`);
  if (state.writtenHashes.includes(hash)) return { written: false, hash, candidates: [] as string[] };

  const candidates = extractAutoMemoryCandidates(rawText);

  if (candidates.length) {
    const now = new Date().toISOString();
    const sessionPath = path.join(obsidianBase, "journal", `${todayIsoDate()}.md`);
    mkdirSync(path.dirname(sessionPath), { recursive: true });
    appendFileSync(sessionPath, [
      `\n## ${now} — ${reason}`,
      "",
      "### Candidate learnings",
      ...candidates.map((candidate) => `- ${candidate}`),
      "",
    ].join("\n"));

    config.appendScratchpadCandidate([
      `Reason: ${reason}`,
      `Hash: ${hash}`,
      `Durable destination: ${path.relative(config.obsidianVault, obsidianBase)}/journal`,
      "",
      ...candidates.map((candidate) => `- ${candidate}`),
    ].join("\n"), "Auto memory candidates");
  }

  state.writtenHashes = [...state.writtenHashes.slice(-49), hash];
  return { written: candidates.length > 0, hash, candidates };
}
