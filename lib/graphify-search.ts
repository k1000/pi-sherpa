import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const DEFAULT_GRAPHIFY_GRAPH_PATH = "graphify-out/graph.json";

type GraphifyConfigLike = {
  enabled?: boolean;
  command?: string;
  graphPath?: string;
  timeoutMs?: number;
  budgetTokens?: number;
  maxLines?: number;
};

export function graphifyGraphPath(cwd: string, cfg: GraphifyConfigLike) {
  const configured = cfg.graphPath || DEFAULT_GRAPHIFY_GRAPH_PATH;
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

export function graphifyAllowedForQuery(focus: string) {
  return /\b(architecture|architectural|topology|graph|call path|calls?|dependencies|dependency|relationship|relationships|connects?|connected|subsystem|boundary|boundaries|community|communities|flow|pipeline|how\s+.+\s+fits|how\s+.+\s+connects)\b/i.test(focus);
}

export async function searchGraphify(cwd: string, focus: string, cfg: GraphifyConfigLike): Promise<string> {
  if (!cfg?.enabled || !focus.trim()) return "";
  const graph = graphifyGraphPath(cwd, cfg);
  if (!existsSync(graph)) return "";
  const timeout = Math.max(300, Math.min(10_000, Math.floor(cfg.timeoutMs || 1200)));
  const budget = String(Math.max(300, Math.min(5000, Math.floor(cfg.budgetTokens || 1200))));
  try {
    const { stdout } = await execFileAsync(
      cfg.command || "graphify",
      ["query", focus, "--graph", graph, "--budget", budget],
      { cwd, timeout, maxBuffer: 300_000 },
    );
    const lines = stdout.split("\n").map(line => line.trim()).filter(Boolean).slice(0, Math.max(3, Math.min(80, cfg.maxLines || 24)));
    if (!lines.length) return "";
    return [
      "Graphify topology/routing hints. Use these as candidate nodes/files/functions; retrieve concrete code snippets with Semble or exact file reads before editing.",
      `Graph: ${path.relative(cwd, graph) || graph}`,
      "",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}
