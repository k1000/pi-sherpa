import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TaskOutcome = "completed" | "partial" | "blocked" | "failed" | "reverted" | "unknown";

export type VerificationAdvice = {
  commands: Array<{ command: string; reason: string }>;
  docsReview: boolean;
  catalogReview: boolean;
};

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|sql|json|md|yml|yaml)$/i;

export function classifyTaskOutcome(text: string): { outcome: TaskOutcome; reason: string } {
  const lower = text.toLowerCase();
  if (/\b(revert(ed)?|rolled back|rollback|discarded changes)\b/.test(lower)) return { outcome: "reverted", reason: "revert/rollback signal detected" };
  if (/\b(blocked|cannot proceed|waiting on|needs approval|missing credentials|permission denied)\b/.test(lower)) return { outcome: "blocked", reason: "blocked/waiting signal detected" };
  const normalized = lower.replace(/\b0\s+(failed|failures?|errors?)\b/g, "zero test issues");
  if (/\b(failed|error|exception|crash|typecheck failed|tests failed|exit code [1-9])\b/.test(normalized)) return { outcome: "failed", reason: "failure/error signal detected" };
  if (/\b(partial|in progress|remaining|todo|follow[- ]?up|next steps?)\b/.test(lower)) return { outcome: "partial", reason: "partial/follow-up signal detected" };
  if (/\b(done|completed|implemented|fixed|passed|verified|successfully)\b/.test(lower)) return { outcome: "completed", reason: "completion/verification signal detected" };
  return { outcome: "unknown", reason: "no strong lifecycle signal detected" };
}

export function suggestVerificationCommands(changedFiles: string[]): VerificationAdvice {
  const commands: VerificationAdvice["commands"] = [];
  const hasTs = changedFiles.some((file) => /\.(ts|tsx)$/.test(file));
  const hasPy = changedFiles.some((file) => /\.py$/.test(file));
  const hasWorker = changedFiles.some((file) => file.includes("apps/workers") || file.includes("packages/domains/workers") || file.includes("worker"));
  const hasSchema = changedFiles.some((file) => file.includes("db/drizzle") || /migration|schema/i.test(file));
  const hasSherpa = changedFiles.some((file) => file.includes("pi-sherpa") || file.includes(".pi/sherpa"));
  const hasDocs = changedFiles.some((file) => /(^|\/)docs\/|README|AGENTS\.md|catalog\.csv/.test(file));

  if (hasTs) commands.push({ command: "pnpm typecheck", reason: "TypeScript files changed" });
  if (hasWorker) commands.push({ command: "pnpm --filter workers typecheck", reason: "worker-related files changed" });
  if (hasPy) commands.push({ command: "pytest", reason: "Python files changed" });
  if (hasSchema) commands.push({ command: "pnpm db:generate", reason: "schema/migration files changed; inspect generated SQL before applying" });
  if (hasSherpa) commands.push({ command: "pnpm exec esbuild /Users/kamil/.pi/agent/extensions/pi-sherpa/index.ts --bundle --platform=node --format=esm --external:@mariozechner/pi-ai --external:@mariozechner/pi-coding-agent --external:typebox --outfile=/tmp/pi-sherpa-check.mjs", reason: "Sherpa extension changed" });

  const unique = new Map(commands.map((item) => [item.command, item]));
  return { commands: [...unique.values()].slice(0, 8), docsReview: !hasDocs && changedFiles.some((file) => SOURCE_EXT.test(file)), catalogReview: changedFiles.some((file) => file === "catalog.csv" || file.startsWith("scripts/") || file.includes("docs/") || file.includes("package.json")) };
}

export function compactScratchpad(root: string, options: { maxBytes?: number; archiveDir?: string } = {}) {
  const sectionsDir = path.join(root, "sections");
  if (!existsSync(sectionsDir)) return { compacted: [] as string[] };
  const maxBytes = options.maxBytes ?? 80_000;
  const archiveDir = options.archiveDir ?? path.join(root, "archive");
  const compacted: string[] = [];

  for (const file of readdirSync(sectionsDir)) {
    if (!file.endsWith(".md")) continue;
    const target = path.join(sectionsDir, file);
    const stat = statSync(target);
    if (!stat.isFile() || stat.size <= maxBytes) continue;
    const raw = readFileSync(target, "utf8");
    const keep = raw.slice(-Math.floor(maxBytes * 0.75));
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${new Date().toISOString().slice(0, 10)}-${file}`);
    writeFileSync(archivePath, raw.slice(0, raw.length - keep.length));
    writeFileSync(target, [`# ${file.replace(/\.md$/, "")} — compacted`, "", `Older entries archived to ${path.relative(root, archivePath)}.`, "", keep.trim(), ""].join("\n"));
    compacted.push(file);
  }

  return { compacted };
}
