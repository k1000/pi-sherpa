/**
 * Sherpa route-map tests.
 * Run with: tsx tests/route-map.test.ts
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRouteMap, ensureRouteMap, parseRouteMap } from "../lib/route-map";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function withRepo(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-route-map-"));
  try {
    mkdirSync(path.join(dir, "apps/clearview/app"), { recursive: true });
    mkdirSync(path.join(dir, "apps/workers/src"), { recursive: true });
    mkdirSync(path.join(dir, "packages/domains/prime-broker"), { recursive: true });
    mkdirSync(path.join(dir, "packages/shared/src/db/drizzle/schema"), { recursive: true });
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "AGENTS.md"), "# Agents");
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "docs/clearworkers-services-report.md"), "# Workers");
    writeFileSync(path.join(dir, "docs/schema-guide.md"), "# Schema");
    writeFileSync(path.join(dir, "scripts/check-workers.ts"), "console.log('ok')");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("buildRouteMap discovers important roots and docs", () => withRepo((dir) => {
  const map = buildRouteMap(dir);
  assert(map.startsWith("name,triggers,read,docs,skip"), "missing csv header");
  assert(map.includes("apps/clearview/app"), "missing clearview app route");
  assert(map.includes("apps/workers/src"), "missing workers route");
  assert(map.includes("docs/clearworkers-services-report.md"), "missing docs route");
  assert(map.includes("Automation scripts and reusable commands"), "missing automation route");
  assert(map.includes("scripts/check-workers.ts"), "missing automation script route");
}));

test("parseRouteMap parses sections and lists", () => {
  const routes = parseRouteMap(`## Workers\n\nTrigger:\n- worker\n\nRead:\n- apps/workers/src\n\nDocs:\n- docs/workers.md\n\nSkip:\n- node_modules\n`);
  assert(routes.length === 1, "expected one route");
  assert(routes[0]!.name === "Workers", "wrong name");
  assert(routes[0]!.triggers[0] === "worker", "wrong trigger");
  assert(routes[0]!.read[0] === "apps/workers/src", "wrong read");
  assert(routes[0]!.docs[0] === "docs/workers.md", "wrong docs");
  assert(routes[0]!.skip[0] === "node_modules", "wrong skip");
});

test("parseRouteMap parses table-formatted route entries", () => {
  const routes = parseRouteMap(`## Workers\n\nTrigger:\n- worker\n\nRead:\n| Purpose | Source |\n|---|---|\n| Workers source | repo://apps/workers/src |\n\nDocs:\n| Purpose | Source |\n|---|---|\n| Workers docs | repo://docs/workers.md |\n\nSkip:\n| Purpose | Source |\n|---|---|\n| dependencies | repo://node_modules |\n`);
  assert(routes.length === 1, "expected one route");
  assert(routes[0]!.read[0] === "apps/workers/src", "wrong table read");
  assert(routes[0]!.docs[0] === "docs/workers.md", "wrong table docs");
  assert(routes[0]!.skip[0] === "node_modules", "wrong table skip");
});

test("parseRouteMap parses csv route entries", () => {
  const routes = parseRouteMap(`name,triggers,read,docs,skip\nWorkers,worker|queue,apps/workers/src|packages/domains/workers,docs/workers.md,node_modules|.next\n`);
  assert(routes.length === 1, "expected one csv route");
  assert(routes[0]!.name === "Workers", "wrong csv name");
  assert(routes[0]!.triggers[1] === "queue", "wrong csv trigger");
  assert(routes[0]!.read[1] === "packages/domains/workers", "wrong csv read list");
  assert(routes[0]!.docs[0] === "docs/workers.md", "wrong csv docs");
  assert(routes[0]!.skip[1] === ".next", "wrong csv skip");
});

test("ensureRouteMap creates routes.csv once", () => withRepo((dir) => {
  ensureRouteMap({ enabled: true, path: "routes.csv" }, dir);
  const routePath = path.join(dir, "routes.csv");
  const first = readFileSync(routePath, "utf8");
  writeFileSync(routePath, "custom");
  ensureRouteMap({ enabled: true, path: "routes.csv" }, dir);
  assert(readFileSync(routePath, "utf8") === "custom", "should not overwrite user route map");
  assert(first.startsWith("name,triggers,read,docs,skip"), "initial csv map not generated");
}));

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
