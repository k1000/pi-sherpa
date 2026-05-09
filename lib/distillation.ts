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
  destination: "obsidian" | "explicit";
  content: string;
};

export function distillSlug(task: string) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "distilled-sherpa-lesson";
}

function yamlString(value: string) {
  return JSON.stringify(value.replace(/\n/g, " "));
}

export function buildDistilledSkill(input: DistillInput, cwd: string, obsidianMemoryPath: string): DistillResult {
  const slug = distillSlug(input.task);
  const explicitTarget = input.targetPath?.trim();
  const skillPath = explicitTarget
    ? (path.isAbsolute(explicitTarget) ? explicitTarget : path.join(cwd, explicitTarget))
    : path.join(obsidianMemoryPath, "wiki", "procedures", `${slug}.md`);

  const today = new Date().toISOString().slice(0, 10);
  const content = [
    "---",
    `id: procedure.${slug}`,
    "type: procedure",
    `title: ${yamlString(input.task.slice(0, 100))}`,
    `summary: ${yamlString(input.outcome.slice(0, 180))}`,
    `aliases: [${slug}]`,
    `tags: [sherpa, distillation, ${input.domain ?? "general"}]`,
    "status: active",
    "confidence: medium",
    `last_updated: ${today}`,
    "related: []",
    "---",
    "",
    "# Procedure: " + slug,
    "",
    `Aliases: ${slug}`,
    `Use when: ${input.task}`,
    "Related: none yet",
    "",
    "## Current truth",
    input.outcome,
    input.context ? "\n## Evidence / context\n" + input.context : "",
    "",
    "## Maintenance notes",
    `- **Domain:** ${input.domain ?? "general"}`,
    `- **Trigger:** ${input.trigger}`,
    `- **Created:** ${today}`,
    "- Distilled by Sherpa into the semantic wiki ontology.",
  ].join("\n");

  return { slug, skillPath, destination: explicitTarget ? "explicit" : "obsidian", content };
}

export function writeDistilledSkill(input: DistillInput, cwd: string, obsidianMemoryPath: string): DistillResult {
  const result = buildDistilledSkill(input, cwd, obsidianMemoryPath);
  mkdirSync(path.dirname(result.skillPath), { recursive: true });
  writeFileSync(result.skillPath, result.content);
  return result;
}
