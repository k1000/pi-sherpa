#!/usr/bin/env bun
/**
 * Deterministic Sherpa selection benchmark.
 *
 * Replays the frozen candidate pools from `bench/fixture.json` through the
 * current deterministic ranking/selection pipeline (`postProcessCandidates`)
 * and scores the top-3 against human-written evaluation labels:
 *   missed[] = sources the user said should have been surfaced
 *   noise[]  = sources the user said should not have been surfaced
 *
 * PRIMARY METRIC (lower is better):
 *   label_loss = (1 - missed_hit_rate) + noise_leak_rate
 *
 * Secondary metrics are reported for monitoring. `upstream_miss_rate` counts
 * missed labels that never reached the candidate pool, which this stage
 * cannot fix.
 *
 * Run: bun bench/ranking-bench.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { postProcessCandidates } from "../lib/candidate-postprocess";

type PoolItem = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
};

type Case = {
  bundleId: string;
  focus: string;
  mode: string;
  pool: PoolItem[];
  missed: string[];
  noise: string[];
  recall: number | null;
  precision: number | null;
};

const FIXTURE = path.join(import.meta.dir, "fixture.json");
const TOP_K = 3;

/** Normalize a source/label for path-insensitive comparison. */
export function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^repo:\/\//, "")
    .replace(/^file:\/\//, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** True when a candidate source satisfies a human label. */
export function labelMatches(label: string, source: string): boolean {
  const l = normalizeLabel(label);
  const s = normalizeLabel(source);
  if (!l || !s) return false;
  if (l === s) return true;
  if (l.includes("://") || l.startsWith("http")) return s === l;
  // Directory label such as `apps/clearview`.
  if (!l.includes(".") && (`/${s}/`).includes(`/${l}/`)) return true;
  // Path suffix: absolute candidate source ending with the repo-relative label.
  if (l.includes("/") && s.endsWith(`/${l}`)) return true;
  // Bare filename label: match only the final path segment exactly.
  if (!l.includes("/")) {
    const base = s.split("/").pop() ?? "";
    if (base === l) return true;
  }
  return false;
}

function rate(hit: number, total: number): number {
  return total ? hit / total : 0;
}

/** Deterministic ~20% hold-out split (monitoring only, not the optimized target). */
export function isDevCase(bundleId: string): boolean {
  let sum = 0;
  for (let i = 0; i < bundleId.length; i++) sum = (sum * 31 + bundleId.charCodeAt(i)) >>> 0;
  return sum % 5 === 0;
}

export function evaluate(fixture: { cases: Case[] }) {
  let missedPairs = 0;
  let missedHits = 0;
  let noisePairs = 0;
  let noiseLeaks = 0;
  let upstreamMiss = 0;
  let emptyTop = 0;

  for (const testCase of fixture.cases) {
    const ranked = postProcessCandidates(testCase.pool as never[], testCase.focus, testCase.mode);
    const top = ranked.slice(0, TOP_K);
    if (top.length === 0) emptyTop++;

    for (const label of testCase.missed) {
      const inPool = testCase.pool.some((c) => labelMatches(label, c.source));
      if (!inPool) {
        upstreamMiss++;
        continue;
      }
      missedPairs++;
      if (top.some((c) => labelMatches(label, (c as PoolItem).source))) missedHits++;
    }

    for (const label of testCase.noise) {
      const inPool = testCase.pool.some((c) => labelMatches(label, c.source));
      if (!inPool) continue;
      noisePairs++;
      if (top.some((c) => labelMatches(label, (c as PoolItem).source))) noiseLeaks++;
    }
  }

  const missedHitRate = rate(missedHits, missedPairs);
  const noiseLeakRate = rate(noiseLeaks, noisePairs);
  const labelLoss = (1 - missedHitRate) + noiseLeakRate;

  return {
    labelLoss,
    missedHitRate,
    noiseLeakRate,
    upstreamMissRate: rate(upstreamMiss, missedPairs + upstreamMiss),
    emptyTopRate: rate(emptyTop, fixture.cases.length),
    missedPairs,
    noisePairs,
    upstreamMiss,
    cases: fixture.cases.length,
  };
}

function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] };
  const r = evaluate(fixture);
  const dev = evaluate({ cases: fixture.cases.filter((c) => isDevCase(c.bundleId)) });
  const lines = [
    `METRIC label_loss=${r.labelLoss.toFixed(4)}`,
    `METRIC missed_hit_rate=${r.missedHitRate.toFixed(4)}`,
    `METRIC noise_leak_rate=${r.noiseLeakRate.toFixed(4)}`,
    `METRIC label_loss_dev=${dev.labelLoss.toFixed(4)}`,
    `METRIC missed_hit_rate_dev=${dev.missedHitRate.toFixed(4)}`,
    `METRIC noise_leak_rate_dev=${dev.noiseLeakRate.toFixed(4)}`,
    `METRIC upstream_miss_rate=${r.upstreamMissRate.toFixed(4)}`,
    `METRIC empty_top_rate=${r.emptyTopRate.toFixed(4)}`,
    `METRIC missed_pairs=${r.missedPairs}`,
    `METRIC noise_pairs=${r.noisePairs}`,
    `METRIC cases=${r.cases}`,
    `METRIC dev_cases=${dev.cases}`,
  ];
  console.log(lines.join("\n"));
  console.log(
    `\nlabel_loss=${r.labelLoss.toFixed(4)} (missed_hit=${r.missedHitRate.toFixed(3)} noise_leak=${r.noiseLeakRate.toFixed(3)})` +
    `\nmissed_pairs=${r.missedPairs} noise_pairs=${r.noisePairs} upstream_miss=${r.upstreamMiss} cases=${r.cases}`,
  );
}

if (import.meta.main) main();
