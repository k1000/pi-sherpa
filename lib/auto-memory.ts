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

export function extractAutoMemoryCandidates(text: string): string[] {
  const structural = /\b(always|never|must|should|invariant|rule|pattern|convention|schema|migration|idempotent|dryRun|dry run|typecheck|direct db|SKIP LOCKED|caps\.id|text not uuid|production|staging|worker|sherpa|reflect|memory|distill)\b/i;
  const noisy = /^(\s*[{\[]|\s*at\s|\s*\d+\)|\s*✓|\s*RUN\s|\s*>\s)/;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const raw of text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 45 || line.length > 420) continue;
    if (noisy.test(line)) continue;
    if (!structural.test(line)) continue;

    const normalized = line.replace(/^[-*]\s*/, "");
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(normalized);
    if (candidates.length >= 12) break;
  }

  return candidates;
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
    "sources",
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
  const now = new Date().toISOString();
  const hash = hashAutoMemory(`${reason}\n${rawText}`);
  if (state.writtenHashes.includes(hash)) return { written: false, hash, candidates: [] as string[] };

  const candidates = extractAutoMemoryCandidates(rawText);
  const sessionPath = path.join(obsidianBase, "journal", `${todayIsoDate()}.md`);
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  appendFileSync(sessionPath, [
    `\n## ${now} — ${reason}`,
    "",
    candidates.length ? "### Candidate learnings" : "### Session event",
    ...(candidates.length
      ? candidates.map((candidate) => `- ${candidate}`)
      : ["- No durable structural learning candidate detected; event recorded for audit continuity."]),
    "",
  ].join("\n"));

  if (candidates.length) {
    config.appendScratchpadCandidate([
      `Reason: ${reason}`,
      `Hash: ${hash}`,
      `Durable destination: ${path.relative(config.obsidianVault, obsidianBase)}/inbox`,
      "",
      ...candidates.map((candidate) => `- ${candidate}`),
    ].join("\n"), "Auto memory candidates");

    const candidatePath = path.join(obsidianBase, "inbox", `auto-session-${todayIsoDate()}-${hash}.md`);
    writeFileSync(candidatePath, [
      `# Auto Session Learning — ${todayIsoDate()}`,
      "",
      "## Metadata",
      `- **Reason:** ${reason}`,
      `- **Created:** ${now}`,
      "- **Source:** Sherpa auto-memory lifecycle hook",
      `- **Project:** ${path.basename(config.cwd)}`,
      "- **Confidence:** low",
      "",
      "## Candidate Learnings",
      ...candidates.map((candidate) => `- ${candidate}`),
      "",
      "## Review Note",
      "Automatically extracted; review before promoting into a maintained wiki concept, procedure, decision, system, or evidence page.",
    ].join("\n"));
  }

  state.writtenHashes = [...state.writtenHashes.slice(-49), hash];
  return { written: true, hash, candidates };
}
