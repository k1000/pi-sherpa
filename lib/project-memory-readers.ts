import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import { catalogMatches, readGlobalTaxonomy } from "./catalog";
import { score } from "./text-utils";

/**
 * Project / research / taxonomy memory readers.
 *
 * Extracted from index.ts. These read durable Obsidian knowledge (current
 * project catalog, research areas, other projects, global taxonomy, ontology
 * fallback dirs) and push matched snippets as candidates via `add`.
 *
 * The orchestrator addProjectMemoryCandidates (which resolves the vault paths
 * from State and fans these out) stays in index.ts.
 */

export type AddMemoryItem = (type: string, source: string, raw: string, relBoost?: number) => void;

export function addCurrentProjectMemory(root: string, indicatorText: string, add: AddMemoryItem) {
  const matches = catalogMatches(root, indicatorText, { limit: 8 });
  for (const { row, relevance } of matches) {
    const target = path.join(root, row.path);
    if (!existsSync(target)) continue;
    const raw = readFileSync(target, "utf8").slice(0, 3000);
    add("project_memory", `kb://current-project/${row.path}`, [`Scope: current project`, `Catalog: ${path.join(root, "catalog.csv")}`, "", raw].join("\n"), Math.max(0.25, relevance));
  }
  return matches;
}

export function addResearchMemory(vault: string, indicatorText: string, add: AddMemoryItem) {
  const researchBase = path.join(vault, "research");
  if (!existsSync(researchBase)) return;
  for (const area of readdirSync(researchBase).slice(0, 80)) {
    const areaRoot = path.join(researchBase, area);
    try {
      if (!statSync(areaRoot).isDirectory()) continue;
      for (const { row, relevance } of catalogMatches(areaRoot, indicatorText, { limit: 5 })) {
        const target = path.join(areaRoot, row.path);
        if (!existsSync(target)) continue;
        const raw = readFileSync(target, "utf8").slice(0, 2600);
        add("research_memory", `kb://research/${area}/${row.path}`, [`Scope: research`, `Area: ${area}`, `Catalog: ${path.join(areaRoot, "catalog.csv")}`, "", raw].join("\n"), Math.max(0.22, relevance));
      }
    } catch { /* ignore research area */ }
  }
}

export function addOtherProjectMemory(vault: string, currentRoot: string, indicatorText: string, add: AddMemoryItem) {
  const projectsBase = path.join(vault, "projects");
  if (!existsSync(projectsBase)) return;
  for (const project of readdirSync(projectsBase).slice(0, 120)) {
    const projectRoot = path.join(projectsBase, project);
    try {
      if (!statSync(projectRoot).isDirectory() || path.resolve(projectRoot) === currentRoot) continue;
      for (const { row, relevance } of catalogMatches(projectRoot, indicatorText, { limit: 4 })) {
        const target = path.join(projectRoot, row.path);
        if (!existsSync(target)) continue;
        const raw = readFileSync(target, "utf8").slice(0, 2200);
        add("other_project_memory", `kb://project/${project}/${row.path}`, [`Scope: other project`, `Project: ${project}`, `Catalog: ${path.join(projectRoot, "catalog.csv")}`, "", raw].join("\n"), Math.max(0.18, relevance));
      }
    } catch { /* ignore project */ }
  }
}

export function addTaxonomyMemory(focus: string, add: AddMemoryItem) {
  const taxonomyMatches = readGlobalTaxonomy()
    .map((row) => ({ row, relevance: score([
      row.kind, row.id, row.label, row.description, row.aliases, row.parent,
      row.examples, row.notes,
    ].filter(Boolean).join("\n"), focus) }))
    .filter((item) => item.relevance > 0.08)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10);
  if (!taxonomyMatches.length) return;
  add("taxonomy", "taxonomy:///Users/kamil/Documents/articles/taxonomy.csv", [
    "# Global Knowledge Taxonomy Matches",
    "Source: /Users/kamil/Documents/articles/taxonomy.csv",
    "",
    ...taxonomyMatches.map(({ row }) => [
      `## ${row.kind}:${row.id} — ${row.label ?? ""}`,
      row.description ? `Description: ${row.description}` : "",
      row.aliases ? `Aliases: ${row.aliases}` : "",
      row.examples ? `Examples: ${row.examples}` : "",
      row.notes ? `Notes: ${row.notes}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n"), 0.16);
}

export function addOntologyFallbackMemory(root: string, focus: string, add: AddMemoryItem) {
  const roots = ["systems", "procedures", "decisions", "concepts", "evidence"].map((name) => path.join(root, "wiki", name));
  roots.push(path.join(root, "journal"), path.join(root, "inbox"));
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir).filter((n: string) => n.endsWith(".md")).slice(0, 8)) {
        const raw = readFileSync(path.join(dir, f), "utf8").slice(0, 2000);
        if (score(raw, focus) > 0.1) add("project_memory", `kb://${path.relative(root, path.join(dir, f))}`, raw, 0.2);
      }
    } catch { /* ignore */ }
  }
}
