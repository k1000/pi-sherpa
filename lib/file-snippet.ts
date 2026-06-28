import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathSourceLabel } from "./exact-source";

/** File-source labeling and snippet extraction helpers used by candidate collectors. */

export function labelRgSource(fileAndLine: string, cwd: string): string {
  const match = fileAndLine.match(/^(.*):(\d+)$/);
  if (!match) return `repo://${fileAndLine}`;
  const [, file, line] = match;
  const source = path.isAbsolute(file) ? pathSourceLabel(file, cwd) : `repo://${file}`;
  return `${source}:${line}`;
}

export function readSnippetAround(abs: string, needles: string[], max = 3600): string | undefined {
  try {
    const raw = readFileSync(abs, "utf8");
    const lower = raw.toLowerCase();
    const idx = needles.map((needle) => lower.indexOf(needle.toLowerCase())).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, idx - Math.floor(max / 3));
    const end = Math.min(raw.length, start + max);
    const prefix = start > 0 ? `... excerpt from ${path.basename(abs)} ...\n` : "";
    const suffix = end < raw.length ? "\n..." : "";
    return `${prefix}${raw.slice(start, end)}${suffix}`;
  } catch { return undefined; }
}

export function latestTraceFiles(traceDir: string): string[] {
  try {
    return readdirSync(traceDir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, 5);
  } catch { return []; }
}

export function traceFileStats(traceDir: string, file: string): string {
  const p = path.join(traceDir, file);
  try {
    const raw = readFileSync(p, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) as { at?: string; bundleId?: string; focus?: string } : undefined;
    return [
      `- ${file}: ${lines.length} traces`,
      last?.at ? `last=${last.at}` : "",
      last?.bundleId ? `bundle=${last.bundleId}` : "",
      last?.focus ? `focus=${String(last.focus).slice(0, 120)}` : "",
    ].filter(Boolean).join("; ");
  } catch {
    return `- ${file}`;
  }
}
