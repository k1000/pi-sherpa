#!/usr/bin/env bun
/** Offline, shadow-only source routing comparison; does not change live Sherpa routing. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { routedFallbackPlan, type Source } from "../lib/source-planning";

export const SOURCE_LABELS = ["web", "repo_code", "repo_docs", "git", "project_memory", "inquirer", "session", "mixed"] as const;
export type SourceLabel = typeof SOURCE_LABELS[number];
export type RoutingExpectation = SourceLabel | "unsupported";
export type RoutingCase = { id: string; prompt: string; expected: RoutingExpectation; required: Source[] };
export type RoutingResult = { id: string; choice: SourceLabel; probability: number; elapsedMs: number };

const AVAILABLE_SOURCES = { files: true, semble: true, graphify: true, docs: true, git: true,
  session: true, project_memory: true, inquirer: true, web: true };

export function evaluateSourceChoices(cases: RoutingCase[], results: RoutingResult[]) {
  if (cases.length !== results.length || new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error("Invalid routing fixture or result count");
  let correct = 0;
  let highConfidence = 0;
  let highConfidenceErrors = 0;
  let webErrors = 0;
  let oracleLocalConfusions = 0;
  let baselineRequiredHits = 0;
  let baselineRequiredTotal = 0;
  let baselineExtra = 0;
  let baselineWebLocalLeaks = 0;
  const rows = cases.map((c, i) => {
    const result = results[i];
    if (result?.id !== c.id || !SOURCE_LABELS.includes(result.choice) || !Number.isFinite(result.probability)
      || result.probability < 0 || result.probability > 1 || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) throw new Error(`Invalid result for ${c.id}`);
    if (result.choice === c.expected) correct++;
    if (result.probability >= 0.65) {
      highConfidence++;
      if (result.choice !== c.expected) highConfidenceErrors++;
    }
    if (c.expected === "web" && result.choice !== "web") webErrors++;
    if ((c.expected === "inquirer" && result.choice === "project_memory")
      || (c.expected === "project_memory" && result.choice === "inquirer")) oracleLocalConfusions++;
    const baseline = routedFallbackPlan({ config: { sources: AVAILABLE_SOURCES } }, c.prompt, "explicit").sources;
    baselineRequiredTotal += c.required.length;
    baselineRequiredHits += c.required.filter((source) => baseline.includes(source)).length;
    baselineExtra += baseline.filter((source) => !c.required.includes(source)).length;
    if (c.expected === "web" && baseline.some((source) => source !== "web")) baselineWebLocalLeaks++;
    return { id: c.id, expected: c.expected, predicted: result.choice, probability: result.probability,
      baseline, elapsedMs: result.elapsedMs };
  });
  const latencies = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  return { cases: cases.length, correct, webErrors, oracleLocalConfusions, highConfidence,
    highConfidenceErrors, baselineRequiredHits, baselineRequiredTotal, baselineExtra, baselineWebLocalLeaks,
    p50Ms: latencies[Math.floor((latencies.length - 1) * 0.5)] ?? 0,
    p95Ms: latencies[Math.floor((latencies.length - 1) * 0.95)] ?? 0, rows };
}

async function main() {
  const model = process.env.LAYA_MODEL_PATH;
  if (!model) throw new Error("Set LAYA_MODEL_PATH to a pinned, locally available checkpoint directory");
  const fixturePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(import.meta.dir, "source-routing-fixture.json");
  const { version, provenance, cases } = JSON.parse(readFileSync(fixturePath, "utf8")) as { version: string; provenance?: string; cases: RoutingCase[] };
  const proc = Bun.spawn([process.env.LAYA_PYTHON ?? "python3", path.join(import.meta.dir, "laya-source-routing.py"), model], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
  });
  proc.stdin.write(JSON.stringify(cases.map(({ id, prompt }) => ({ id, prompt }))));
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) throw new Error("Offline Laya source-routing shadow failed");
  const response = JSON.parse(output) as { loadMs: number; results: RoutingResult[] };
  console.log(JSON.stringify({ fixture: version, provenance: provenance ?? "Synthetic, author-labeled shadow only.", modelLoadMs: response.loadMs,
    ...evaluateSourceChoices(cases, response.results),
    warning: "Heuristic fallback is not the live model planner. Never use this result as an authorization or deployment gate." }, null, 2));
}

if (import.meta.main) await main();
