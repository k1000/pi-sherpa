import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseRouteMap, type RoutePlan } from "./route-map";

type RouteMapConfigLike = {
  enabled?: boolean;
  path: string;
  applyTo?: "all" | "front-door" | "explicit" | "proactive";
};

type RouteStateLike = {
  config: { routeMap: RouteMapConfigLike };
};

/** Route-map matching helpers for source planning. */

export function routeMapApplies(state: RouteStateLike, mode: string) {
  const applyTo = state.config.routeMap?.applyTo ?? "all";
  return Boolean(state.config.routeMap?.enabled) && (applyTo === "all" || applyTo === mode);
}

export function matchRoutePlan(state: RouteStateLike, cwd: string, focus: string, mode: string): RoutePlan | undefined {
  if (!routeMapApplies(state, mode)) return undefined;
  try {
    const routePath = path.isAbsolute(state.config.routeMap.path) ? state.config.routeMap.path : path.join(cwd, state.config.routeMap.path);
    if (!existsSync(routePath)) return undefined;
    const routes = parseRouteMap(readFileSync(routePath, "utf8"));
    const f = focus.toLowerCase();
    const scored = routes.map(r => ({ ...r, score: r.triggers.reduce((n, t) => n + (t && f.includes(t.toLowerCase()) ? 1 : 0), 0) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0];
  } catch { return undefined; }
}
