/** Shared small utilities used by Sherpa and Archivist. */

export type ReflectSyncArgs = {
  refId?: string;
  destination?: string;
  dryRun?: boolean;
  since?: string;
};

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
