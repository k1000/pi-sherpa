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
  const tail = lower.slice(-2500);
  const normalized = tail.replace(/\b0\s+(failed|failures?|errors?)\b/g, "zero test issues");

  if (/\b(revert(ed)?|rolled back|rollback|discarded changes)\b/.test(tail)) return { outcome: "reverted", reason: "revert/rollback signal detected" };
  if (/\b(blocked|cannot proceed|waiting on|needs approval|missing credentials|permission denied)\b/.test(tail)) return { outcome: "blocked", reason: "blocked/waiting signal detected" };

  // Prefer final-task intent over historical logs in the transcript. Error text is
  // often the bug being fixed, not evidence that the task failed.
  const completionSignal = /\b(done|completed|implemented|fixed|resolved|verified|successfully|tests? pass(?:ed)?|all tests pass|bun test[^\n]*(?:pass|passed)|\d+\s+pass(?:ed)?)\b/.test(normalized);
  const explicitFailure = /\b(typecheck failed|tests failed|test failed|exit code [1-9]|could not|not fixed|still failing|failed to fix|unable to|crash(?:ed)?|fatal)\b/.test(normalized);

  if (explicitFailure && !completionSignal) return { outcome: "failed", reason: "explicit final failure signal detected" };
  if (/\b(partial|in progress|remaining|todo|follow[- ]?up|next steps?)\b/.test(tail) && !completionSignal) return { outcome: "partial", reason: "partial/follow-up signal detected" };
  if (completionSignal) return { outcome: "completed", reason: "completion/verification signal detected" };
  if (/\b(error|exception)\b/.test(normalized)) return { outcome: "partial", reason: "error/debug signal without final failure" };
  return { outcome: "unknown", reason: "no strong lifecycle signal detected" };
}

export function suggestVerificationCommands(changedFiles: string[]): VerificationAdvice {
  const commands: VerificationAdvice["commands"] = [];
  const hasTs = changedFiles.some((file) => /\.(ts|tsx)$/.test(file));
  const hasJs = changedFiles.some((file) => /\.(js|jsx|mjs|cjs)$/.test(file));
  const hasPy = changedFiles.some((file) => /\.py$/.test(file));
  const hasWorker = changedFiles.some((file) => file.includes("apps/workers") || file.includes("packages/domains/workers") || file.includes("worker"));
  const hasSchema = changedFiles.some((file) => file.includes("db/drizzle") || /migration|schema/i.test(file));
  const hasSherpa = changedFiles.some((file) => file.includes("pi-sherpa") || file.includes(".pi/sherpa"));
  const hasHyperPodFrontend = changedFiles.some((file) => file === "src/server/public/client.js" || file === "src/server/public/index.html" || file === "src/server/public/styles.css");
  const hasPiExtension = changedFiles.some((file) => file.includes(".pi/extensions/") || (file.includes("/extensions/") && file.endsWith(".ts")));
  const hasDocs = changedFiles.some((file) => /(^|\/)docs\/|README|AGENTS\.md|catalog\.csv/.test(file));

  if (hasHyperPodFrontend) commands.push({ command: "bun test src/server/frontend.test.ts", reason: "HyperPod frontend assets changed" });
  if (hasTs) commands.push({ command: "pnpm typecheck", reason: "TypeScript files changed" });
  if (hasWorker) commands.push({ command: "pnpm --filter workers typecheck", reason: "worker-related files changed" });
  if (hasPy) commands.push({ command: "pytest", reason: "Python files changed" });
  if (hasSchema) commands.push({ command: "pnpm db:generate", reason: "schema/migration files changed; inspect generated SQL before applying" });
  if (hasSherpa) commands.push({ command: "pnpm exec esbuild /Users/kamil/.pi/agent/extensions/pi-sherpa/index.ts --bundle --platform=node --format=esm --external:@mariozechner/pi-ai --external:@mariozechner/pi-coding-agent --external:typebox --outfile=/tmp/pi-sherpa-check.mjs", reason: "Sherpa extension changed" });
  if (hasPiExtension) commands.push({ command: "pi /reload", reason: "Pi extension changed; reload or restart Pi and smoke-test the hook" });
  if (hasJs && !hasHyperPodFrontend) commands.push({ command: "bun test", reason: "JavaScript files changed" });

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
