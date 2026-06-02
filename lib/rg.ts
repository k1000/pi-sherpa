import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RgMatch = { fileAndLine: string; content: string };

/**
 * Parse ripgrep `-n` output in `file:line:content` form.
 * Splits only on the first two colons so URLs, JSON, and other colon-rich
 * content remain intact.
 */
export function parseRgOutput(output: string, limit = 30): RgMatch[] {
  const results: RgMatch[] = [];
  for (const block of output.split("\n").slice(0, limit)) {
    if (!block.trim()) continue;
    const firstColon = block.indexOf(":");
    const secondColon = firstColon >= 0 ? block.indexOf(":", firstColon + 1) : -1;
    if (firstColon === -1 || secondColon === -1) continue;
    const fileAndLine = block.slice(0, secondColon);
    const content = block.slice(secondColon + 1).trim();
    results.push({ fileAndLine, content });
  }
  return results;
}

export async function rg(cwd: string, query: string | string[], searchPath = cwd): Promise<string> {
  const queryText = Array.isArray(query) ? query.join(" ") : query;
  const terms = queryText.match(/[A-Za-z0-9_./-]{4,}/g)?.slice(0, 6) ?? [];
  if (!terms.length) return "";
  const bundledRg = path.join(cwd, "bin", "rg");
  const rgBin = existsSync(bundledRg) ? bundledRg : "rg";
  try {
    const { stdout } = await execFileAsync(rgBin, ["-n", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--glob", "!.next", "--glob", "!dist", terms.join("|"), searchPath], { timeout: 3000, maxBuffer: 500_000 });
    return stdout;
  } catch (e: any) { return e.stdout ?? ""; }
}
