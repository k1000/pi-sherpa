/** Shared small utilities used by Sherpa and Archivist. */

export type ReflectSyncArgs = {
  refId?: string;
  destination?: string;
  dryRun?: boolean;
  since?: string;
};

import { statSync } from "node:fs";

/**
 * True when a file's body is actually stored locally and readable.
 * macOS iCloud can evict file bodies while keeping the directory entry:
 * stat() still works but st_blocks === 0, and readFileSync() then blocks for
 * ~1s+ per file while iCloud materializes it. Sherpa's vault readers must
 * never touch those files synchronously — a single retrieval can otherwise
 * freeze the whole agent for minutes (1093/1304 vault files were evicted
 * as of 2026-07-31). Skipping evicted files is safe: they are either
 * already indexed or will be picked up once iCloud downloads them.
 */
export function fileIsMaterialized(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    return st.isFile() && st.size > 0 && st.blocks > 0;
  } catch {
    return false;
  }
}

/** Parse reflect sync command args used by /sherpa:sync-reflect and /archivist:sync-reflect. */
export function parseReflectSyncArgs(args?: string): ReflectSyncArgs {
  const parts = args?.trim() ? args.trim().split(/\s+/) : [];
  const out: ReflectSyncArgs = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "--dry-run") out.dryRun = true;
    else if (part === "--ref-id") out.refId = parts[++i];
    else if (part === "--destination") out.destination = parts[++i];
    else if (part === "--since") out.since = parts[++i];
  }
  return out;
}

/**
 * Parse `git status --short` output into changed file paths.
 * Handles rename rows (`old -> new`) and quoted paths better than whitespace-split parsing.
 */
export function parseGitStatusFiles(status: string): string[] {
  const files: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const file = (raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw).replace(/^"|"$/g, "");
    if (file) files.push(file);
  }
  return [...new Set(files)];
}
