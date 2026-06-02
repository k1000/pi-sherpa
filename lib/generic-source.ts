export type GenericSourceClass = "mission" | "archivist" | "readme" | "skill";

export function genericSourceClass(source: string): GenericSourceClass | undefined {
  const normalized = source.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("docs/mission_prompt.md") || normalized.includes("docs/missions.md")) return "mission";
  if (normalized.includes("documentation-drift") || normalized.includes("archivist_actionable_solutions.md") || normalized.includes("archivist-sherpa-gap-analysis")) return "archivist";
  if (normalized.includes("/.pi/agent/skills/")) return "skill";
  if (normalized === "repo://readme.md" || normalized.endsWith("/readme.md") || normalized.includes("/readme.md:")) return "readme";
  return undefined;
}

export function focusAllowsGenericSource(source: string, focus = ""): boolean {
  const f = focus.toLowerCase();
  switch (genericSourceClass(source)) {
    case "mission": return /\b(mission|missions|orchestrator|worker|validator|validation contract)\b/.test(f);
    case "archivist": return /\b(archivist|preserve|distill|documentation drift|obsidian|memory routing)\b/.test(f);
    case "skill": return /\b(skill|skills|agent skill|load skill)\b/.test(f);
    case "readme": return /\b(readme|overview|onboard|onboarding|project summary)\b/.test(f);
    default: return false;
  }
}
