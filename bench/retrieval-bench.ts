#!/usr/bin/env bun
/**
 * Candidate-generation (retrieval) benchmark.
 *
 * Measures the stage that ranking cannot fix: for each bundle, are the
 * human-labeled relevant paths (`missed`) actually surfaced as candidates?
 *
 * PRIMARY METRIC (higher is better):
 *   retrieval_recall = surfaced_existing_missed / existing_missed
 *
 * Only labels that exist on disk are counted (a deleted path is not a retrieval
 * failure). `surfaced` means the deterministic file-retrieval path produced a
 * candidate whose source matches the label.
 *
 * Run: bun bench/retrieval-bench.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { addExplicitPathCandidates } from "../lib/exact-source";
import { addIndicatorFileCandidates, addRoutedFileCandidates, retryFrontDoorFileCandidates } from "../lib/file-candidates";
import { postProcessCandidates } from "../lib/candidate-postprocess";

type RetrievalCase = {
  bundleId: string;
  focus: string;
  mode: string;
  planner: string;
  sourcePlan: { sources: string[]; routePlan?: { read?: string[]; skip?: string[] } };
  indicators: string[];
  missed: string[];
  noise: string[];
};

const FIXTURE = path.join(import.meta.dir, "retrieval-fixture.json");
const CWD = homedir();

function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/^repo:\/\//, "")
    .replace(/^file:\/\//, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^\.\//, "");
}

function matchesLabel(label: string, source: string): boolean {
  const l = normalize(label).toLowerCase();
  const s = normalize(source).toLowerCase();
  if (!l || !s) return false;
  if (l === s) return true;
  if (l.includes("/") && s.endsWith(`/${l}`)) return true;
  if (s.endsWith(l)) return true;
  const base = l.split("/").pop() ?? "";
  return base.length > 4 && s.endsWith(`/${base}`);
}

function labelExists(label: string): boolean {
  const n = normalize(label);
  if (!n) return false;
  const abs = n.startsWith("/") ? n : path.join(CWD, n);
  return existsSync(abs);
}

async function retrieve(testCase: RetrievalCase): Promise<string[]> {
  const found: string[] = [];
  const add = (type: string, source: string) => { if (source) found.push(source); };
  const sourcePlan = testCase.sourcePlan as never;
  const indicators = { indicators: testCase.indicators } as never;
  addExplicitPathCandidates(CWD, testCase.focus, add as never);
  await addRoutedFileCandidates({ cwd: CWD }, testCase.focus, testCase.mode, sourcePlan, add as never);
  await addIndicatorFileCandidates({ cwd: CWD }, testCase.mode, sourcePlan, indicators, add as never);
  await retryFrontDoorFileCandidates({ cwd: CWD }, testCase.focus, testCase.mode, sourcePlan, [] as never, add as never, () => true);
  return found;
}

async function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: RetrievalCase[] };
  let existing = 0;
  let surfaced = 0;
  let surfacedAt12 = 0;
  let fallbackExisting = 0;
  let fallbackSurfaced = 0;
  let noiseExisting = 0;
  let noiseSurfaced = 0;
  let totalCandidates = 0;
  for (const testCase of fixture.cases) {
    const found = await retrieve(testCase);
    totalCandidates += found.length;
    // What the model actually sees: deterministic ranking, capped at 12.
    const ranked = postProcessCandidates(
      found.map((source) => ({ type: "file", source, summary: "", relevance: 0.2 })),
      testCase.focus,
      testCase.mode,
    ).slice(0, 12).map((c) => c.source);
    for (const label of testCase.missed) {
      if (!labelExists(label)) continue;
      existing++;
      const isFallback = testCase.planner !== "llm" && testCase.planner !== "override";
      if (isFallback) fallbackExisting++;
      if (found.some((s) => matchesLabel(label, s))) {
        surfaced++;
        if (isFallback) fallbackSurfaced++;
      }
      if (ranked.some((s) => matchesLabel(label, s))) surfacedAt12++;
    }
    for (const label of testCase.noise) {
      if (!labelExists(label)) continue;
      noiseExisting++;
      if (found.some((s) => matchesLabel(label, s))) noiseSurfaced++;
    }
  }
  const recall = existing ? surfaced / existing : 0;
  console.log([
    `METRIC retrieval_recall_at_12=${(existing ? surfacedAt12 / existing : 0).toFixed(4)}`,
    `METRIC retrieval_recall=${recall.toFixed(4)}`,
    `METRIC retrieval_noise_rate=${(noiseExisting ? noiseSurfaced / noiseExisting : 0).toFixed(4)}`,
    `METRIC retrieval_fallback_recall=${(fallbackExisting ? fallbackSurfaced / fallbackExisting : 0).toFixed(4)}`,
    `METRIC retrieval_candidates_per_case=${(fixture.cases.length ? totalCandidates / fixture.cases.length : 0).toFixed(2)}`,
    `METRIC retrieval_existing_labels=${existing}`,
    `METRIC retrieval_surfaced=${surfaced}`,
    `METRIC retrieval_surfaced_at_12=${surfacedAt12}`,
    `METRIC retrieval_noise_labels=${noiseExisting}`,
    `METRIC retrieval_fallback_labels=${fallbackExisting}`,
    `METRIC retrieval_cases=${fixture.cases.length}`,
  ].join("\n"));
  console.log(`\nrecall_at_12=${(existing ? surfacedAt12 / existing : 0).toFixed(4)} raw_recall=${recall.toFixed(4)} surfaced=${surfaced}/${existing} at12=${surfacedAt12} noise=${noiseSurfaced}/${noiseExisting} candidates/case=${(totalCandidates / (fixture.cases.length || 1)).toFixed(2)}`);
}

if (import.meta.main) await main();
