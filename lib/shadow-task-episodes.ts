import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ContextBundleRecord, ContextEvaluation } from "./evaluation";
import type { TaskFileEvidence } from "./post-task-evaluation";
import { parseToolArguments } from "./repo-file-evidence";

const SCHEMA = "sherpa-shadow-task-episode-v1";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CARDS = 500;

export function shadowTaskEpisodeDir(): string {
  return path.join(os.homedir(), ".pi-memory", "reflection-triage", "shadow-episodes");
}

function scrub(value: string, max = 240): string {
  return value.replace(/\s+/g, " ").slice(0, max)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*$/gi, "[REDACTED-PRIVATE-KEY]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:[A-Z0-9_]*API[_-]?KEY|[A-Z0-9_]*TOKEN|PASSWORD|SECRET|AUTHORIZATION)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})\b/g, "[TOKEN]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[UUID]")
    .replace(/\b\d{9,}\b/g, "[ID]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[HOME]");
}

function paths(values: string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === "string" && !!value && !value.includes("\0"))
    .slice(0, 16).map((value) => scrub(value, 160)))].slice(0, 12);
}

function observedChecks(messages: unknown[]): Array<{ kind: string; status: "passed" | "failed" | "unknown" }> {
  const calls = new Map<string, string>();
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const item of messages.slice(-50)) {
    if (!item || typeof item !== "object") continue;
    const message = item as { role?: string; toolCallId?: string; isError?: boolean; content?: unknown[] };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const entry of message.content) {
        if (!entry || typeof entry !== "object") continue;
        const block = entry as { type?: string; id?: string; name?: string; arguments?: unknown };
        if (block.type !== "toolCall" || block.name !== "bash" || !block.id) continue;
        const command: unknown = parseToolArguments(block.arguments).command;
        if (typeof command !== "string" || /[;&|`$\n\r]/.test(command)) continue;
        const clean = command.trim();
        const kind = /^bun\s+test\b/.test(clean) ? "bun-test"
          : /^bun\s+(?:run\s+)?scripts\/check-extension\.ts\b/.test(clean) ? "bun-check"
          : /^(?:npm|pnpm)\s+test\b/.test(clean) ? "package-test"
          : /^(?:pytest|python3?\s+-m\s+pytest)\b/.test(clean) ? "pytest"
          : /^cargo\s+test\b/.test(clean) ? "cargo-test"
          : /^go\s+test\b/.test(clean) ? "go-test" : "";
        if (kind) calls.set(block.id, kind);
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const text = Array.isArray(message.content)
        ? message.content.filter((part): part is { type: string; text: string } =>
          !!part && typeof part === "object" && (part as { type?: string }).type === "text"
            && typeof (part as { text?: unknown }).text === "string")
          .map((part) => part.text).join(" ").slice(-120)
        : "";
      results.set(message.toolCallId, { text, isError: message.isError === true });
    }
  }
  return [...calls].slice(-6).map(([id, kind]) => {
    const result = results.get(id);
    const exit = result?.text.match(/\[Exit code: (\d+)\]/);
    return { kind, status: result?.isError || (exit && exit[1] !== "0") ? "failed"
      : exit?.[1] === "0" ? "passed" : "unknown" };
  });
}

function privateRoot(root: string): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("shadow episode directory must be a private owned directory, not a symlink");
  }
}

export function pruneShadowTaskEpisodes(root = shadowTaskEpisodeDir(), now = new Date()): number {
  if (!existsSync(root)) return 0;
  privateRoot(root);
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!/^episode-[a-z0-9-]+\.json$/.test(name)) continue;
    const file = path.join(root, name);
    if (!lstatSync(file).isFile()) continue;
    let card: { schema?: string; capturedAt?: string };
    try { card = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (card.schema !== SCHEMA || typeof card.capturedAt !== "string") continue;
    const at = Date.parse(card.capturedAt);
    if (Number.isFinite(at) && now.getTime() - at >= RETENTION_MS) {
      unlinkSync(file);
      removed++;
    }
  }
  return removed;
}

export function writeShadowTaskEpisode(input: {
  bundle: ContextBundleRecord;
  evaluation: ContextEvaluation;
  files: TaskFileEvidence;
  cwd: string;
  messages?: unknown[];
  now?: Date;
  root?: string;
}): boolean {
  try {
    const root = input.root ?? shadowTaskEpisodeDir();
    const now = input.now ?? new Date();
    privateRoot(root);
    pruneShadowTaskEpisodes(root, now);
    if (readdirSync(root).filter((name) => /^episode-[a-z0-9-]+\.json$/.test(name)).length >= MAX_CARDS) return false;
    const id = /^bundle-[a-z0-9-]{1,80}$/.test(input.bundle.bundleId)
      ? input.bundle.bundleId : createHash("sha256").update(input.bundle.bundleId).digest("hex").slice(0, 32);
    const file = path.join(root, `episode-${id}.json`);
    const card = {
      schema: SCHEMA,
      bundleId: id,
      capturedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
      project: scrub(path.basename(input.cwd), 80),
      task: { focus: scrub(input.bundle.focus), outcome: input.evaluation.taskOutcome, outcomeSource: "automatic-unverified" },
      context: { selectedCount: input.bundle.items.length, sources: paths(input.bundle.items.map((item) => item.source)) },
      evidence: {
        readFiles: paths(input.files.readFiles), writtenFiles: paths(input.files.writtenFiles),
        referencedFiles: paths(input.files.referencedFiles), gitDirtySnapshot: paths(input.files.changedFiles),
        observedChecks: observedChecks(input.messages ?? []),
        verification: "tool-exit-only; not-independently-verified",
      },
      selfEvaluation: {
        status: "automatic-unverified",
        scores: input.evaluation.scores,
        missedFiles: paths(input.evaluation.missed), noisySources: paths(input.evaluation.noise),
      },
      review: { decision: null, reason: null, protected: null },
    };
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(card, null, 2) + "\n");
    } catch {
      unlinkSync(file);
      return false;
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    // The diagnostic shadow collector must not alter Sherpa task completion.
    return false;
  }
}
