import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RoutePlan = {
  name: string;
  triggers: string[];
  read: string[];
  docs: string[];
  skip: string[];
  score: number;
};

export type RouteMapConfig = {
  enabled?: boolean;
  path?: string;
};

const DEFAULT_ROUTE_MAP_PATH = "routes.csv";

function pathExists(cwd: string, rel: string) {
  return existsSync(path.join(cwd, rel));
}

function listDirs(cwd: string, rel: string) {
  const dir = path.join(cwd, rel);
  try {
    return existsSync(dir)
      ? readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory()).sort()
      : [];
  } catch {
    return [];
  }
}

function listFiles(cwd: string, rel: string, matcher: RegExp, limit = 80) {
  const dir = path.join(cwd, rel);
  try {
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => matcher.test(name))
          .sort()
          .slice(0, limit)
          .map((name) => path.join(rel, name).replace(/\\/g, "/"))
      : [];
  } catch {
    return [];
  }
}

function displayNameForRouteItem(item: string): string {
  try {
    const withoutTrailingSlash = item.replace(/\/+$/, "");
    const base = withoutTrailingSlash.split(/[\\/]/).pop() || item;
    return base.replace(/\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|py|sh)$/i, "").replace(/[-_]+/g, " ");
  } catch {
    return item;
  }
}

function reachabilityForRouteItem(item: string): string {
  if (/^https?:\/\//i.test(item)) return item;
  return item.startsWith("repo://") ? item : `repo://${item}`;
}

function purposeForRouteItem(item: string): string {
  const explicit: Record<string, string> = {
    "AGENTS.md": "Repo rules / critical agent conventions",
    "package.json": "Scripts and workspace commands",
    "pnpm-workspace.yaml": "Workspace package layout",
    "README.md": "Repo overview",
    "DEPLOYMENT.md": "Deployment model",
  };
  return explicit[item] ?? "—";
}

function routeTable(items: string[]): string[] {
  if (!items.length) return [];
  return [
    "| Purpose | Source |",
    "|---|---|",
    ...items.map((item) => `| ${purposeForRouteItem(item)} | ${reachabilityForRouteItem(item)} |`),
  ];
}

function routeSection(
  name: string,
  triggers: string[],
  read: string[],
  docs: string[],
  skip: string[] = [],
) {
  const block = [
    `## ${name}`,
    "",
    "Trigger:",
    ...triggers.map((trigger) => `- ${trigger}`),
    "",
    "Read:",
    ...routeTable(read),
    "",
    "Docs:",
    ...routeTable(docs),
  ];
  if (skip.length) block.push("", "Skip:", ...routeTable(skip));
  return block.join("\n");
}

export function buildRouteMap(cwd: string): string {
  const docs = listFiles(cwd, "docs", /\.md$/i, 120);
  const rootDocs = ["README.md", "AGENTS.md", "DEPLOYMENT.md"].filter((item) => pathExists(cwd, item));
  const domainAreas = listDirs(cwd, "packages/domains");
  const sharedSchemaDocs = [
    "packages/shared/src/db/drizzle/schema/index.ts",
    "packages/shared/src/db/drizzle/migrations",
  ].filter((item) => pathExists(cwd, item));
  const scriptFiles = listFiles(cwd, "scripts", /\.(sh|js|mjs|cjs|ts|tsx|py)$/i, 60);

  const sections = [
    routeSection(
      "Project orientation and agent rules",
      ["architecture", "agent", "rules", "conventions", "project", "overview", "where is", "how do"],
      ["AGENTS.md", ".claude/rules", ".claude/skills", "package.json", "pnpm-workspace.yaml"].filter((item) => pathExists(cwd, item)),
      [...rootDocs, ...docs.filter((doc) => /overview|architecture|readme|implementation|plan|report/i.test(doc)).slice(0, 20)],
      ["node_modules", ".next", "dist", "coverage"],
    ),
    routeSection(
      "ClearView customer app",
      ["clearview", "customer", "account", "onboarding", "client", "wizard", "broker agreement", "settings"],
      ["apps/clearview/app", "apps/clearview/features", "apps/clearview/shared"].filter((item) => pathExists(cwd, item)),
      docs.filter((doc) => /clearview|onboarding|account|broker|service-agreement|client/i.test(doc)).slice(0, 20),
      ["apps/clearview/.next", "apps/clearview/node_modules"],
    ),
    routeSection(
      "ClearOps staff app",
      ["clearops", "staff", "admin", "operations", "dashboard", "worker ui", "monitoring"],
      ["apps/clearops/app", "apps/clearops/features", "apps/clearops/shared"].filter((item) => pathExists(cwd, item)),
      docs.filter((doc) => /clearops|operations|admin|worker|monitoring/i.test(doc)).slice(0, 20),
      ["apps/clearops/.next", "apps/clearops/node_modules"],
    ),
    routeSection(
      "Workers and scheduler",
      ["worker", "workers", "scheduler", "queue", "pgboss", "cron", "orchestration", "clearworkers", "mpg worker"],
      ["apps/workers/src", "apps/workers/tests", "packages/domains/workers", "packages/domains/prime-broker", "packages/domains/trading/post-trade", "packages/domains/settlement"].filter((item) => pathExists(cwd, item)),
      docs.filter((doc) => /worker|clearworkers|mpg|scheduler|queue|orchestration/i.test(doc)).slice(0, 30),
      ["apps/workers/dist", "apps/workers/node_modules"],
    ),
    routeSection(
      "Domain packages",
      ["domain", "service", "validator", "business logic", "package", ...domainAreas.slice(0, 20)],
      ["packages/domains", "packages/domains/package.json"].filter((item) => pathExists(cwd, item)),
      docs.filter((doc) => /domain|service|business|implementation|contract/i.test(doc)).slice(0, 20),
      ["packages/domains/**/node_modules"],
    ),
    routeSection(
      "Database schema and migrations",
      ["database", "db", "schema", "drizzle", "migration", "sql", "table", "column", "caps.id", "zoho"],
      ["packages/shared/src/db", ...sharedSchemaDocs].filter(Boolean),
      [...docs.filter((doc) => /schema|migration|database|drizzle|zoho/i.test(doc)).slice(0, 20), "AGENTS.md"].filter((item, index, all) => all.indexOf(item) === index),
      ["packages/shared/src/db/drizzle/migrations/meta"],
    ),
    routeSection(
      "Legacy MPG reference only",
      ["mpg", "legacy", "reference", "port", "parity", "prototype"],
      ["mpg/apps", "mpg/packages"].filter((item) => pathExists(cwd, item)),
      docs.filter((doc) => /mpg|gap|parity|port|migration/i.test(doc)).slice(0, 30),
      ["mpg/node_modules", "mpg/.next"],
    ),
    routeSection(
      "Testing and quality gates",
      ["test", "vitest", "coverage", "typecheck", "lint", "quality", "failing"],
      ["apps", "packages", "scripts", "vitest.config.ts", "package.json"].filter((item) => pathExists(cwd, item)),
      docs.filter((doc) => /test|quality|coverage|audit|verification/i.test(doc)).slice(0, 20),
      ["coverage", "node_modules", ".next"],
    ),
    routeSection(
      "Automation scripts and reusable commands",
      ["automation", "script", "scripts", "repeat", "repeated", "command", "automate", "helper", "check", "audit"],
      ["scripts", "package.json", "pnpm-workspace.yaml", "pyproject.toml", "requirements.txt", ...scriptFiles].filter((item, index, all) => pathExists(cwd, item) && all.indexOf(item) === index),
      docs.filter((doc) => /automation|script|command|workflow|audit|check|quality/i.test(doc)).slice(0, 20),
      ["node_modules", ".next", "dist", "coverage"],
    ),
  ];

  const markdownRouteMap = [
    "# Sherpa Route Map",
    "",
    "Root-level router for Sherpa context retrieval.",
    "",
    "Sherpa creates this file on project initialization when missing. Edit it to teach Sherpa where important project knowledge lives.",
    "",
    "Memory policy:",
    "- Long-term durable memory lives in Obsidian.",
    "- Project scratchpad remains repo-local under `.pi-memory/scratchpad/`.",
    "- This file is the project-owned routing map, not long-term memory.",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Important discovered roots",
    "",
    "Trigger:",
    "- route map",
    "- routes",
    "- project structure",
    "",
    "Read:",
    ...routeTable(["apps", "packages", "docs", "scripts", ".claude/skills", "AGENTS.md"].filter((item) => pathExists(cwd, item))),
    "",
    "Docs:",
    ...routeTable([...rootDocs, ...docs.slice(0, 40)]),
    "",
    "Skip:",
    ...routeTable(["node_modules", ".next", "dist", "coverage"]),
    "",
    ...sections,
    "",
  ].join("\n");

  return routePlansToCsv(parseRouteMarkdown(markdownRouteMap));
}

export function ensureRouteMap(config: RouteMapConfig | undefined, cwd: string) {
  if (!config?.enabled) return;
  const configured = config.path || DEFAULT_ROUTE_MAP_PATH;
  const routePath = path.isAbsolute(configured) ? configured : path.join(cwd, configured);
  if (existsSync(routePath)) return;
  mkdirSync(path.dirname(routePath), { recursive: true });
  writeFileSync(routePath, buildRouteMap(cwd));
}

function parseListLine(line: string) {
  return line.replace(/^[-*]\s*/, "").trim();
}

function normalizeRouteSource(value: string): string {
  return value.replace(/^(repo|skip):\/\//, "").replace(/^skip:/, "").trim();
}

function parseTablePath(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  if (/^\|\s*-+\s*\|/.test(trimmed)) return null;

  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
  const firstCell = cells[0];
  const secondCell = cells[1];
  if (!firstCell || /^path$/i.test(firstCell) || /^source$/i.test(firstCell) || /^name( and\/or purpose)?$/i.test(firstCell) || /^purpose\b/i.test(firstCell)) return null;

  // Preferred table format: Purpose | Source. Source normally is repo://path.
  if (secondCell) {
    return normalizeRouteSource(secondCell);
  }

  // Compatibility with older path-first single-value rows.
  return normalizeRouteSource(firstCell);
}

function csvEscape(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function routePlansToCsv(routes: RoutePlan[]) {
  const header = ["name", "triggers", "read", "docs", "skip"];
  const rows = routes.map((route) => [
    route.name,
    route.triggers.join("|"),
    route.read.join("|"),
    route.docs.join("|"),
    route.skip.join("|"),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ",") { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function splitListCell(value: string) {
  return value.split("|").map((item) => item.trim()).filter(Boolean);
}

function parseRouteCsv(raw: string): RoutePlan[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const required = ["name", "triggers", "read", "docs", "skip"];
  if (required.some((name) => idx(name) === -1)) return [];
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return {
      name: cells[idx("name")]?.trim() || "Untitled route",
      triggers: splitListCell(cells[idx("triggers")] || ""),
      read: splitListCell(cells[idx("read")] || ""),
      docs: splitListCell(cells[idx("docs")] || ""),
      skip: splitListCell(cells[idx("skip")] || ""),
      score: 0,
    };
  }).filter((route) => route.triggers.length || route.read.length || route.docs.length);
}

function parseRouteMarkdown(raw: string): RoutePlan[] {
  const routes: RoutePlan[] = [];
  let current: RoutePlan | null = null;
  let field: "trigger" | "read" | "docs" | "skip" | "" = "";

  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (current) routes.push(current);
      current = { name: heading[1]!.trim(), triggers: [], read: [], docs: [], skip: [], score: 0 };
      field = "";
      continue;
    }
    if (!current) continue;

    const label = line.match(/^(Trigger|Read|Docs|Skip):\s*$/i);
    if (label) {
      field = label[1]!.toLowerCase() as typeof field;
      continue;
    }

    if (!field) continue;

    const tableValue = parseTablePath(line);
    const value = tableValue ?? (/^[-*]\s+/.test(line) ? parseListLine(line) : null);
    if (!value) continue;

    if (field === "trigger") current.triggers.push(value);
    if (field === "read") current.read.push(value);
    if (field === "docs") current.docs.push(value);
    if (field === "skip") current.skip.push(value);
  }
  if (current) routes.push(current);
  return routes;
}

export function parseRouteMap(raw: string): RoutePlan[] {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim())?.trim().toLowerCase() || "";
  if (firstLine.startsWith("name,") || firstLine.includes(",triggers,")) return parseRouteCsv(raw);
  return parseRouteMarkdown(raw);
}
