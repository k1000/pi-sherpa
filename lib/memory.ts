import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProjectKBBasedir } from "./project-kb";
import { upsertCatalogRow } from "./catalog";

export type MemoryPaths = {
  cwd: string;
  extensionMemoryDir: string;
  obsidianVault: string;
  obsidianMemoryPath: string;
};

type ReflectEntry = {
  id: string;
  type?: string;
  title?: string;
  summary?: string;
  importance?: string;
  tags?: string[];
  file?: string;
  createdAt?: string;
  materialized?: boolean;
};

const MAX_RECALL_FILE_CHARS = 1000;
const MAX_RECALL_RESULTS = 8;

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `memory-${Date.now()}`;
}

function words(value: string) {
  return new Set((value.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).map((w) => w.replace(/^-+|-+$/g, "")));
}

function scoreText(query: string, text: string) {
  const queryWords = words(query);
  const haystack = text.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (!word) continue;
    if (haystack.includes(word)) score += haystack.includes(`# ${word}`) ? 3 : 1;
  }
  return score;
}

function readMdFiles(dir: string, limit = 200) {
  if (!existsSync(dir)) return [] as Array<{ path: string; content: string; mtime: number }>;
  const out: Array<{ path: string; content: string; mtime: number }> = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const current = stack.pop()!;
    for (const name of readdirSync(current).slice(0, 120)) {
      const p = path.join(current, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) stack.push(p);
        else if (name.endsWith(".md")) out.push({ path: p, content: readFileSync(p, "utf8"), mtime: st.mtimeMs });
      } catch {
        // ignore unreadable files
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

function reflectRoots(cwd: string) {
  return [path.join(cwd, ".pi", "reflect"), path.join(os.homedir(), ".pi", "reflect")]
    .filter((item, index, all) => all.indexOf(item) === index);
}

function readReflectEntries(cwd: string) {
  const entries: ReflectEntry[] = [];
  for (const root of reflectRoots(cwd)) {
    const indexPath = path.join(root, "index.jsonl");
    if (!existsSync(indexPath)) continue;
    for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // ignore malformed reflect rows
      }
    }
  }
  return entries;
}

function findReflectEntry(cwd: string, refId: string) {
  return readReflectEntries(cwd).find((entry) => entry.id === refId);
}

function formatFrontmatter(frontmatter: Record<string, unknown>, body: string) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.join(", ")}]`);
    else lines.push(`${key}: ${String(value ?? "")}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function reflectBody(entry: ReflectEntry) {
  return [
    `# ${entry.title ?? entry.id}`,
    "",
    entry.summary ?? "",
    "",
    `Reflect ID: ${entry.id}`,
    entry.createdAt ? `Created: ${entry.createdAt}` : "",
  ].filter(Boolean).join("\n");
}

function destinationFor(entry: ReflectEntry, forced?: string) {
  if (forced && forced !== "auto") return forced;
  const type = entry.type ?? "knowledge";
  const importance = entry.importance ?? "medium";
  if (type === "process") return "journal";
  // Durable memory defaults to Obsidian project memory using the semantic ontology.
  return "obsidian";
}

function semanticWikiType(entry: ReflectEntry) {
  const type = entry.type ?? "knowledge";
  if (type === "pattern" || type === "automation") return { folder: "procedures", pageType: "procedure" };
  if (type === "process") return { folder: "decisions", pageType: "decision" };
  return { folder: "concepts", pageType: "concept" };
}

function obsidianDir(paths: MemoryPaths, entry: ReflectEntry) {
  const semantic = semanticWikiType(entry);
  return path.join(paths.obsidianMemoryPath, "wiki", semantic.folder);
}

export async function syncReflectMemory(paths: MemoryPaths, options: { refId?: string; destination?: string; dryRun?: boolean; since?: string } = {}) {
  const entries = options.refId
    ? [findReflectEntry(paths.cwd, options.refId)].filter(Boolean) as ReflectEntry[]
    : readReflectEntries(paths.cwd);

  const sinceTime = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
  const synced: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry?.id) continue;
    if (entry.createdAt && Date.parse(entry.createdAt) < sinceTime) {
      skipped.push(`${entry.id}: before --since`);
      continue;
    }

    const destination = destinationFor(entry, options.destination);
    const slug = slugify(entry.title || entry.id);
    const body = reflectBody(entry);
    const note = formatFrontmatter({
      id: entry.id,
      type: semanticWikiType(entry).pageType,
      importance: entry.importance ?? "medium",
      tags: entry.tags ?? [],
      source: "reflect",
      created: new Date().toISOString(),
    }, body);

    if (options.dryRun) {
      synced.push(`${entry.id} -> ${destination}/${slug}.md (dry-run)`);
      continue;
    }

    if (destination === "scratchpad") {
      const target = path.join(getProjectKBBasedir(paths.cwd), "scratchpad", "sessions", "daily", `${new Date().toISOString().slice(0, 10)}.md`);
      mkdirSync(path.dirname(target), { recursive: true });
      appendFileSync(target, `\n## Reflect ${entry.id}\n\n${body}\n`);
      synced.push(`${entry.id} -> project scratchpad`);
      continue;
    }

    if (destination === "journal") {
      const target = path.join(paths.obsidianMemoryPath, "journal", `${new Date().toISOString().slice(0, 10)}.md`);
      mkdirSync(path.dirname(target), { recursive: true });
      appendFileSync(target, `\n## Reflect ${entry.id} — ${entry.title ?? entry.id}\n\n${body}\n`);
      synced.push(`${entry.id} -> ${path.relative(paths.cwd, target)}`);
      continue;
    }

    if (destination !== "obsidian") {
      skipped.push(`${entry.id}: unsupported destination ${destination}`);
      continue;
    }

    const dir = obsidianDir(paths, entry);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${slug}.md`);
    writeFileSync(target, note);
    upsertCatalogRow(paths.cwd, {
      id: `reflect.${entry.id}`,
      scope: "project",
      project: path.basename(paths.cwd),
      type: semanticWikiType(entry).pageType,
      path: path.relative(paths.cwd, target).replace(/\\/g, "/"),
      title: entry.title ?? entry.id,
      summary: entry.summary ?? body.slice(0, 180),
      aliases: entry.id,
      tags: Array.isArray(entry.tags) ? entry.tags.join("|") : "reflect",
      status: "active",
      confidence: entry.importance ?? "medium",
      updated: new Date().toISOString().slice(0, 10),
      based_on: entry.id,
      routes: [entry.title ?? "", ...(entry.tags ?? [])].filter(Boolean).join("|"),
      keywords: [entry.id, entry.type ?? "", entry.importance ?? ""].filter(Boolean).join("|"),
    });
    synced.push(`${entry.id} -> ${path.relative(paths.cwd, target)}`);
  }

  return [
    `Sherpa reflect sync complete: ${synced.length} synced, ${skipped.length} skipped`,
    ...synced.slice(0, 20).map((line) => `- ${line}`),
    ...skipped.slice(0, 10).map((line) => `- skipped ${line}`),
  ].join("\n");
}

export function recallMemory(paths: MemoryPaths, query: string) {
  const roots = [
    path.join(paths.obsidianMemoryPath, "wiki", "systems"),
    path.join(paths.obsidianMemoryPath, "wiki", "procedures"),
    path.join(paths.obsidianMemoryPath, "wiki", "decisions"),
    path.join(paths.obsidianMemoryPath, "wiki", "concepts"),
    path.join(paths.obsidianMemoryPath, "wiki", "evidence"),
    path.join(paths.obsidianMemoryPath, "journal"),
    path.join(paths.obsidianMemoryPath, "inbox"),
    path.join(paths.extensionMemoryDir, ".l2_facts"),
    path.join(paths.extensionMemoryDir, ".l3_skills"),
  ];

  const scored = roots.flatMap((root) =>
    readMdFiles(root).map((file) => ({
      ...file,
      root,
      score: scoreText(query, path.basename(file.path) + "\n" + file.content),
    })),
  ).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime)
    .slice(0, MAX_RECALL_RESULTS);

  if (!scored.length) return `No Sherpa memory matched: ${query}`;

  return [
    `# Sherpa Recall: ${query}`,
    "",
    ...scored.map((item, index) => [
      `## ${index + 1}. ${path.basename(item.path)} (score ${item.score})`,
      `Path: ${item.path}`,
      "",
      item.content.slice(0, MAX_RECALL_FILE_CHARS),
      "",
    ].join("\n")),
  ].join("\n");
}
