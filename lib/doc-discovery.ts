import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { score } from "./text-utils";

const FRONT_DOOR_MAX_DOCS = 2;

type RoutePlanLike = { docs?: string[]; skip: string[] };

/** Front-door documentation discovery and route skip helpers. */

export function isPreloadedContextFile(rel: string) {
  const normalized = rel.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(agents|claude)\.md$/.test(normalized);
}

export function isNoisyFrontDoorDoc(rel: string) {
  const normalized = rel.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(changelog|roadmap|ideas|notes|meeting-notes|scratch|draft|archive)(\/|\.|-|_)/.test(normalized)
    || /(^|\/)(archive|archives|drafts|scratch|notes)\//.test(normalized);
}

export function docMatchesFocus(rel: string, focus: string, mode: string) {
  if (isPreloadedContextFile(rel)) return false;

  // Explicit /sherpa requests may browse broadly. Front-door injection should be
  // selective because it competes with the main prompt/context budget.
  if (mode !== "front-door") return true;
  if (isNoisyFrontDoorDoc(rel)) return false;
  if (rel === "README.md" || rel === "docs/README.md") return true;

  const f = focus.toLowerCase();
  const r = rel.toLowerCase();
  const has = (re: RegExp) => re.test(f);

  const deploymentDoc = /quick-start|workflow|deploy|deployment|docker|cloudflare|opencode|server|production|prod|dev/.test(r);
  if (deploymentDoc) return has(/\b(deploy|deployment|docker|cloudflare|server|prod|production|dev\s*server|ci|cd|build|release|hot\s*reload)\b/);

  const agentDoc = /agent|cron|schedule|handoff|analysis|signal|alphabot/.test(r);
  if (agentDoc) return has(/\b(agent|agents|cron|schedule|scheduler|handoff|analysis|analyst|signal|signals|alphabot|prompt)\b/);

  const tradingDoc = /broker|trading|trade|risk|strategy|backtest|execution|portfolio|market/.test(r);
  if (tradingDoc) return has(/\b(broker|trading|trade|risk|strategy|backtest|execution|portfolio|market|order|position)\b/);

  return score(rel, focus) >= 0.34;
}

export function routeSkipsPath(routePlan: RoutePlanLike | undefined, p: string) {
  if (!routePlan) return false;
  const normalized = p.replace(/\\/g, "/").toLowerCase();
  return routePlan.skip.some(s => s && normalized.includes(s.replace(/\\/g, "/").toLowerCase()));
}

export function getDocFilesForFocus(cwd: string, focus: string, mode: string, routePlan?: RoutePlanLike) {
  const routedDocs = routePlan?.docs ?? [];
  const docFiles = [...routedDocs, "README.md", "docs/README.md"];
  const docsDir = path.join(cwd, "docs");
  if (existsSync(docsDir)) {
    try {
      for (const f of readdirSync(docsDir).filter(n => n.endsWith(".md")).slice(0, 50)) {
        const rel = path.join("docs", f);
        if (!docFiles.includes(rel) && docMatchesFocus(rel, focus, mode)) docFiles.push(rel);
      }
    } catch { /* ignore */ }
  }
  const matched = docFiles.filter(rel => docMatchesFocus(rel, focus, mode) && !routeSkipsPath(routePlan, rel));
  if (mode !== "front-door") return matched;
  const generic = matched.filter(rel => rel === "README.md" || rel === "docs/README.md");
  const specific = matched.filter(rel => rel !== "README.md" && rel !== "docs/README.md");
  return (specific.length ? [...specific.slice(0, 1), ...generic] : generic).slice(0, FRONT_DOOR_MAX_DOCS);
}
