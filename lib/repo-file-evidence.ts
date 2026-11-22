import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Helpers for classifying repo paths and extracting file evidence from tool calls. */

export function isDocumentationPath(file: string) {
  const p = file.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(readme|changelog|contributing|architecture|design|adr|prd)(\.|$)/.test(p)
    || /(^|\/)(docs?|documentation|adr|adrs)\//.test(p)
    || /\.(md|mdx|rst|adoc|txt)$/.test(p);
}

export function isSourcePath(file: string) {
  const p = file.replace(/\\/g, "/").toLowerCase();
  if (isDocumentationPath(p)) return false;
  if (/(^|\/)(node_modules|dist|build|coverage|\.git|\.pi-memory|extensions\/pi-sherpa\/memory)\//.test(p)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|php|rb|sql|json|ya?ml|toml)$/.test(p);
}

export function parseToolArguments(args: unknown): any {
  if (!args) return {};
  if (typeof args === "string") {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return typeof args === "object" ? args : {};
}

export function normalizeRepoToolPath(rawPath: unknown, cwd: string): string | undefined {
  if (typeof rawPath !== "string" || !rawPath) return undefined;
  const cleaned = rawPath.replace(/^@/, "");
  const absolute = path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned);
  const relative = path.relative(cwd, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}

export function commandLooksWriteLike(command: string): boolean {
  return /\b(apply_patch|tee\s+|perl\s+-pi|sed\s+-i|mv\s+|cp\s+)\b|>|>>/.test(command);
}

export function collectRecentTaskFileEvidence(messages: any[] | undefined, cwd: string) {
  const readFiles = new Set<string>();
  const writtenFiles = new Set<string>();
  for (const msg of messages ?? []) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall") continue;
      const args = parseToolArguments(block.arguments);
      const rel = normalizeRepoToolPath(args?.path, cwd);
      if (rel) {
        if (["write", "edit"].includes(block.name)) writtenFiles.add(rel);
        if (block.name === "read") readFiles.add(rel);
      }
      if (block.name === "bash" && typeof args?.command === "string") {
        const mentioned = extractMentionedRepoFiles(args.command, cwd);
        for (const file of mentioned) {
          if (commandLooksWriteLike(args.command)) writtenFiles.add(file);
          else readFiles.add(file);
        }
      }
    }
  }
  return { readFiles: [...readFiles], writtenFiles: [...writtenFiles] };
}

export function extractMentionedRepoFiles(text: string, cwd: string) {
  const files = new Set<string>();
  const candidates = text.match(/(?:^|[\s`'"(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?=$|[\s`'"),.:;])/g) ?? [];
  for (const raw of candidates) {
    const rel = raw.trim().replace(/^[`'"(]+|[`'"),.:;]+$/g, "");
    if (!rel || rel.includes("://") || rel.startsWith("..")) continue;
    const p = path.join(cwd, rel);
    if (existsSync(p)) files.add(rel.replace(/\\/g, "/"));
  }
  return [...files];
}

export function recentTurnWrittenFiles(messages: any[] | undefined, cwd: string) {
  return collectRecentTaskFileEvidence(messages, cwd).writtenFiles;
}

export function docSearchTerms(files: string[]) {
  const terms = new Set<string>();
  for (const file of files) {
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    const parent = path.basename(path.dirname(file));
    for (const t of [base, parent]) {
      const cleaned = t.replace(/[^A-Za-z0-9_-]/g, "");
      if (cleaned.length >= 4) terms.add(cleaned);
    }
  }
  return [...terms].slice(0, 8);
}

export function findDocumentationCandidates(cwd: string, changedSourceFiles: string[]) {
  const terms = docSearchTerms(changedSourceFiles);
  const candidates: string[] = [];
  const roots = ["README.md", "docs"];
  const visit = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).slice(0, 80)) visit(path.join(p, name));
      return;
    }
    const rel = path.relative(cwd, p);
    if (!isDocumentationPath(rel)) return;
    try {
      const raw = readFileSync(p, "utf8").toLowerCase();
      if (!terms.length || terms.some(t => raw.includes(t.toLowerCase()))) candidates.push(rel);
    } catch { /* ignore unreadable docs */ }
  };
  for (const root of roots) visit(path.join(cwd, root));
  return [...new Set(candidates)].slice(0, 8);
}
