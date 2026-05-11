import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type DistillInput = {
  trigger: string;
  task: string;
  outcome: string;
  context?: string;
  domain?: string;
  targetPath?: string;
};

export type DistillResult = {
  slug: string;
  skillPath: string;
  destination: "obsidian" | "research" | "explicit";
  content: string;
};

// ── Slug ────────────────────────────────────────────────────────────────────

export function distillSlug(task: string) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "distilled-sherpa-lesson";
}

// ── YAML helpers ─────────────────────────────────────────────────────────────

function yamlString(value: string) {
  return JSON.stringify(value.replace(/\n/g, " "));
}

function frontmatter(lines: Array<[string, string]>): string {
  return ["---", ...lines.map(([k, v]) => `${k}: ${v}`), "---"].join("\n");
}

// ── Routing ─────────────────────────────────────────────────────────────────

/**
 * Routing rules per OPERATING_DOCTRINE.md:
 * - Explicit targetPath wins.
 * - Research domains (ai, trading, python, git, etc.) → research/<domain>/.
 * - Everything else → wiki/procedures/.
 */
const RESEARCH_DOMAINS = new Set([
  "ai", "llm", "ml", "agent", "agents", "software-engineering", "engineering",
  "trading", "finance", "backtesting", "strategy", "risk", "execution",
  "python", "typescript", "javascript", "git", "devops", "infrastructure",
  "documentation", "writing", "operations", "security", "testing", "tdd",
  "refactoring", "architecture", "design", "product", "ux",
]);

function isResearchDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  const normalized = domain.toLowerCase().replace(/[\s_-]+/g, "-");
  return RESEARCH_DOMAINS.has(normalized) || normalized.startsWith("ai/") || normalized.startsWith("trading/");
}

// ── Content builder ───────────────────────────────────────────────────────────

function buildContent(slug: string, input: DistillInput, today: string, isResearch: boolean): string {
  const domain = input.domain ?? "general";
  const yaml = (key: string, value: string) => yamlString(value);

  const fm = frontmatter([
    ["id", `procedure.${slug}`],
    ["type", "procedure"],
    ...(isResearch ? [["area", domain], ["category", "distillation"]] : []),
    ["title", yamlString(input.task.slice(0, 100))],
    ["summary", yamlString(input.outcome.slice(0, 180))],
    ["aliases", `[${slug}]`],
    ["tags", `[sherpa, distillation, ${domain}]`],
    ["status", "active"],
    ["confidence", "medium"],
    ["last_updated", today],
    ["related", "[]"],
  ]);

  const researchExtra = [
    "**Research area:** " + domain,
    "**Use when:** " + input.task,
  ];

  const projectExtra = [
    "Related: none yet",
  ];

  const maintenance = [
    "## Maintenance notes",
    `- **Domain:** ${domain}`,
    `- **Trigger:** ${input.trigger}`,
    `- **Created:** ${today}`,
    "- Distilled by Sherpa into " + (isResearch
      ? "research knowledge (cross-project reusable)."
      : "the semantic wiki ontology."),
  ];

  const sections = [
    fm,
    "",
    "# Procedure: " + slug,
    "",
    ...(isResearch ? researchExtra : ["Aliases: " + slug, "Use when: " + input.task, ...projectExtra]),
    "",
    "## Current truth",
    input.outcome,
    input.context ? "\n## Evidence / context\n" + input.context : "",
    "",
    ...maintenance,
    "",
  ];

  return sections.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────────────

export function buildDistilledSkill(
  input: DistillInput,
  cwd: string,
  obsidianMemoryPath: string,
): DistillResult {
  const slug = distillSlug(input.task);
  const explicitTarget = input.targetPath?.trim();
  const today = new Date().toISOString().slice(0, 10);

  let skillPath: string;
  let destination: DistillResult["destination"];

  if (explicitTarget) {
    skillPath = path.isAbsolute(explicitTarget) ? explicitTarget : path.join(cwd, explicitTarget);
    destination = "explicit";
  } else if (isResearchDomain(input.domain)) {
    const area = (input.domain ?? "general").toLowerCase().replace(/[\s_-]+/g, "-");
    skillPath = path.join(obsidianMemoryPath, "..", "research", area, slug + ".md");
    destination = "research";
  } else {
    skillPath = path.join(obsidianMemoryPath, "wiki", "procedures", slug + ".md");
    destination = "obsidian";
  }

  const isResearch = destination === "research";
  const content = buildContent(slug, input, today, isResearch);

  return { slug, skillPath, destination, content };
}

export function writeDistilledSkill(
  input: DistillInput,
  cwd: string,
  obsidianMemoryPath: string,
): DistillResult {
  const result = buildDistilledSkill(input, cwd, obsidianMemoryPath);
  mkdirSync(path.dirname(result.skillPath), { recursive: true });
  writeFileSync(result.skillPath, result.content);
  return result;
}
