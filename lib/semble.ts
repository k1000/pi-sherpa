import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SembleConfig = {
  enabled: boolean;
  command: string;
  topK: number;
  timeoutMs: number;
};

export type SembleResult = {
  filePath: string;
  startLine: number;
  endLine: number;
  score?: number;
  content: string;
};

export type SembleState = {
  lastHead?: string;
  lastCheckedAt?: string;
  lastResultCount?: number;
  lastError?: string;
};

export function parseSembleSearchOutput(output: string): SembleResult[] {
  const results: SembleResult[] = [];
  const pattern = /^##\s+\d+\.\s+(.+?):(\d+)-(\d+)\s+(?:\[score=([^\]]+)\])?\s*\n```[^\n]*\n([\s\S]*?)\n```/gm;
  for (const match of output.matchAll(pattern)) {
    const filePath = match[1]?.trim();
    const startLine = Number(match[2]);
    const endLine = Number(match[3]);
    const score = match[4] === undefined ? undefined : Number(match[4]);
    const content = match[5]?.trimEnd() ?? "";
    if (!filePath || !Number.isFinite(startLine) || !Number.isFinite(endLine) || !content.trim()) continue;
    results.push({
      filePath,
      startLine,
      endLine,
      score: Number.isFinite(score) ? score : undefined,
      content,
    });
  }
  return results;
}

function sembleStatePath(cwd: string): string {
  return path.join(cwd, ".pi", "sherpa", "semble-state.json");
}

export function readSembleState(cwd: string): SembleState {
  const target = sembleStatePath(cwd);
  if (!existsSync(target)) return {};
  try {
    return JSON.parse(readFileSync(target, "utf8")) as SembleState;
  } catch {
    return {};
  }
}

export function writeSembleState(cwd: string, state: SembleState): void {
  const target = sembleStatePath(cwd);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(state, null, 2) + "\n");
}

async function currentGitHead(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 1000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isUnsafeBroadSembleRoot(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  return resolved === path.parse(resolved).root || resolved === os.homedir();
}

/**
 * Same home-root blind spot as rg: a broad home root is refused, so semantic
 * search is silently disabled for home-cwd workspaces. Scope it to the bounded
 * Pi agent tree instead.
 */
export function scopedBroadSembleRoot(cwd: string): string {
  if (path.resolve(cwd) !== os.homedir()) return cwd;
  const piAgentRoot = path.join(os.homedir(), ".pi", "agent");
  return existsSync(piAgentRoot) ? piAgentRoot : cwd;
}

export async function searchSemble(
  cwd: string,
  query: string,
  config: SembleConfig,
): Promise<SembleResult[]> {
  if (!config.enabled || !query.trim()) return [];
  const topK = String(Math.max(1, Math.min(20, Math.floor(config.topK || 8))));
  const timeout = Math.max(500, Math.min(15000, Math.floor(config.timeoutMs || 3000)));
  const head = await currentGitHead(cwd);
  const searchRoot = scopedBroadSembleRoot(cwd);
  if (isUnsafeBroadSembleRoot(searchRoot)) {
    writeSembleState(cwd, {
      lastHead: head,
      lastCheckedAt: new Date().toISOString(),
      lastResultCount: 0,
      lastError: `skipped unsafe broad Semble root: ${path.resolve(cwd)}`,
    });
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      config.command || "semble",
      ["search", query, searchRoot, "--top-k", topK],
      { cwd, timeout, maxBuffer: 600_000 },
    );
    const parsed = parseSembleSearchOutput(stdout);
    // Semble returns paths relative to the search root; rewrite them relative to
    // the real cwd so candidate sources resolve correctly when the root is scoped.
    const results = searchRoot === cwd
      ? parsed
      : parsed.map((r) => ({ ...r, filePath: path.relative(cwd, path.join(searchRoot, r.filePath)) }));
    writeSembleState(cwd, { lastHead: head, lastCheckedAt: new Date().toISOString(), lastResultCount: results.length });
    return results;
  } catch (error) {
    writeSembleState(cwd, {
      lastHead: head,
      lastCheckedAt: new Date().toISOString(),
      lastResultCount: 0,
      lastError: error instanceof Error ? error.message.slice(0, 240) : "semble search failed",
    });
    return [];
  }
}
