import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const EXACT_SOURCE_LIMIT = 8;
const PATH_TOKEN_RE = /(?:~\/[^\s`'"),;]+|\/[^\s`'"),;]+|\.{1,2}\/[A-Za-z0-9_.@/-]+|[A-Za-z0-9_.@-][A-Za-z0-9_./@-]*\.[A-Za-z0-9_-]{1,8})/g;
const BARE_FILENAME_RE = /\b[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|mjs|cjs|py|md|json|jsonl|yaml|yml|toml|rs|go|java|cs|cpp|hpp|swift|sh)\b/g;

function trimPathToken(token: string): string {
  return token.replace(/[),.;:'"`\]>}]+$/g, "");
}

function isAllowedExplicitPath(abs: string, cwd: string): boolean {
  const roots = [cwd, process.env.HOME].filter((root): root is string => Boolean(root)).map((root) => path.resolve(root));
  const resolved = path.resolve(abs);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

function resolveExistingPath(raw: string, cwd: string): string | undefined {
  const token = trimPathToken(raw);
  if (!token || token === "." || token === "..") return undefined;
  const expanded = token.startsWith("~/") ? path.join(process.env.HOME ?? "", token.slice(2)) : token;
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  try { return existsSync(absolute) && isAllowedExplicitPath(absolute, cwd) ? absolute : undefined; }
  catch { return undefined; }
}

function exactFilenameRoots(cwd: string): string[] {
  const roots = [cwd];
  if (process.env.HOME) roots.push(path.join(process.env.HOME, ".pi", "agent", "extensions"));
  return roots;
}

export function explicitPathCandidates(focus: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const match of focus.matchAll(PATH_TOKEN_RE)) {
    const resolved = resolveExistingPath(match[0], cwd);
    if (resolved) out.add(resolved);
  }

  // Bare filenames are exact hints only when they exist in the current project root or Pi extensions root.
  for (const match of focus.matchAll(BARE_FILENAME_RE)) {
    const name = trimPathToken(match[0]);
    for (const root of exactFilenameRoots(cwd)) {
      const resolved = resolveExistingPath(path.join(root, name), cwd);
      if (resolved) out.add(resolved);
    }
  }

  return [...out].slice(0, EXACT_SOURCE_LIMIT);
}

export function pathSourceLabel(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return `repo://${rel}`;
  const home = process.env.HOME;
  if (home && abs.startsWith(home + path.sep)) return `file://~/${path.relative(home, abs)}`;
  return `file://${abs}`;
}

export function readExplicitSource(abs: string): { raw: string; boost: number } | undefined {
  try {
    const st = statSync(abs);
    if (st.isFile()) {
      const bytes = readFileSync(abs);
      const head = bytes.subarray(0, Math.min(bytes.length, 4096));
      if (head.includes(0)) return undefined;
      return { raw: bytes.toString("utf8", 0, Math.min(bytes.length, 5000)), boost: 0.9 };
    }
    if (st.isDirectory()) return {
      raw: `Directory explicitly requested: ${abs}\n\nEntries:\n${readdirSync(abs).slice(0, 80).join("\n")}`,
      boost: 0.75,
    };
  } catch { /* ignore explicit source read errors */ }
  return undefined;
}
