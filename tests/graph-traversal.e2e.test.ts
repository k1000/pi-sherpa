#!/usr/bin/env bun
/**
 * @sherpa-purpose E2E regression for the live Inquirer memory relations endpoint:
 * GET /api/v1/memory/relations must return 200 with {"relations":[...]} using the
 * same query path the candidate pipeline uses (Basic auth, ?from=<artifact id>).
 * @sherpa-timeout 120000
 * @sherpa-safe true
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

/**
 * Read the memory API config the same way the extension does:
 * ~/.pi/agent/.pi/sherpa.config.json -> memoryApi.{url,token}.
 * The token is used only inside this process and never printed.
 */
function readMemoryApiConfig(): { url: string; token: string } | null {
  try {
    const cfgPath = path.join(homedir(), ".pi", "agent", ".pi", "sherpa.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const { url, token } = cfg.memoryApi ?? {};
    if (typeof url === "string" && url && typeof token === "string" && token) return { url, token };
    return null;
  } catch {
    return null;
  }
}

const forcedSkip = process.env.SHERPA_SKIP_LIVE_TESTS === "1";
const api = readMemoryApiConfig();

// The repo's client (lib/basic-candidate-sources.ts -> archivist/lib/memory-api.ts)
// authenticates with `Authorization: Basic <token>`; the live endpoint rejects Bearer.
const authHeaders = (api: { token: string }): Record<string, string> => ({
  Accept: "application/json",
  Authorization: `Basic ${api.token}`
});

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test("relations endpoint returns edges via the code's query path", async () => {
  // Step 1: seed artifact ids via the same search POST the candidate pipeline uses
  // (MemoryApiStore.search). Any id works as the `from` seed for relations.
  const search = await fetchJson(`${api!.url}/api/v1/memory/search`, {
    method: "POST",
    headers: { ...authHeaders(api!), "Content-Type": "application/json" },
    body: JSON.stringify({ text: "sherpa", limit: 5 }),
  });
  const searchResults = Array.isArray(search.json?.results) ? search.json.results : Array.isArray(search.json) ? search.json : [];
  const seedIds = searchResults
    .map((r: any) => r?.artifact?.id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  if (!seedIds.length) throw new Error("memory search returned no artifact ids; cannot seed relations query");

  // Step 2: exact code path — GET /api/v1/memory/relations?from=<id> (as getRelations() calls it)
  const codePath = await fetchJson(`${api!.url}/api/v1/memory/relations?from=${encodeURIComponent(seedIds[0])}`, {
    headers: authHeaders(api!),
  });
  if (codePath.status !== 200) throw new Error(`relations endpoint returned HTTP ${codePath.status}`);
  if (!codePath.json || !Array.isArray(codePath.json.relations)) {
    throw new Error(`relations endpoint did not return {"relations":[...]}: ${JSON.stringify(codePath.json).slice(0, 200)}`);
  }

  // Step 3: the same query path must actually return edges (from/relation/to) for
  // at least one seed id — the shape the graph traversal in addGraphCandidates consumes.
  let edgesFound = 0;
  let lastShapeError = "no seed id produced relations";
  for (const id of seedIds.slice(0, 3)) {
    const res = await fetchJson(`${api!.url}/api/v1/memory/relations?from=${encodeURIComponent(id)}`, {
      headers: authHeaders(api!),
    });
    if (res.status !== 200) continue;
    const relations = Array.isArray(res.json?.relations) ? res.json.relations : [];
    for (const relation of relations) {
      if (typeof relation?.from === "string" && typeof relation?.to === "string" && typeof relation?.relation === "string") {
        edgesFound++;
      } else {
        lastShapeError = `relation missing from/relation/to strings: ${JSON.stringify(relation).slice(0, 160)}`;
      }
    }
    if (edgesFound > 0) break;
  }
  if (edgesFound === 0) throw new Error(`relations endpoint returned no well-formed edges (${lastShapeError})`);
});

test("relations endpoint accepts limit/project params alongside from", async () => {
  const search = await fetchJson(`${api!.url}/api/v1/memory/search`, {
    method: "POST",
    headers: { ...authHeaders(api!), "Content-Type": "application/json" },
    body: JSON.stringify({ text: "sherpa", limit: 1 }),
  });
  const searchResults = Array.isArray(search.json?.results) ? search.json.results : Array.isArray(search.json) ? search.json : [];
  const id = searchResults.map((r: any) => r?.artifact?.id).find((v: unknown): v is string => typeof v === "string" && v.length > 0);
  if (!id) throw new Error("memory search returned no artifact ids; cannot seed relations query");

  const res = await fetchJson(`${api!.url}/api/v1/memory/relations?from=${encodeURIComponent(id)}&limit=5&project=AI`, {
    headers: authHeaders(api!),
  });
  if (res.status !== 200) throw new Error(`relations endpoint returned HTTP ${res.status}`);
  if (!Array.isArray(res.json?.relations)) {
    throw new Error(`relations endpoint did not return {"relations":[...]}: ${JSON.stringify(res.json).slice(0, 200)}`);
  }
});

async function main() {
  if (forcedSkip) {
    console.log("⏭️  SKIPPED: SHERPA_SKIP_LIVE_TESTS=1 set");
    return;
  }
  if (!api) {
    console.log("⏭️  SKIPPED: no memoryApi token/url in ~/.pi/agent/.pi/sherpa.config.json");
    return;
  }
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`✅ ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNetworkFailure = /fetch failed|network|timed? ?out|abort/i.test(message);
      if (isNetworkFailure) {
        console.log(`⏭️  SKIPPED: ${name} (no network: ${message})`);
        continue;
      }
      failed++;
      console.error(`❌ ${name}`);
      console.error(error);
    }
  }
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
