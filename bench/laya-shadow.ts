#!/usr/bin/env bun
/** Offline, shadow-only comparison. Never changes Sherpa's delivered context. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { postProcessCandidates } from "../lib/candidate-postprocess";
import { isDevCase, labelMatches } from "./ranking-bench";

export type Candidate = { type: string; source: string; summary: string; relevance: number; handle?: string };
export type Case = { bundleId: string; focus: string; mode: string; pool: Candidate[]; missed: string[]; noise: string[] };
export type ReplayCase = { bundleId: string; focus: string; candidates: Array<{ source: string; excerpt: string }> };
const TOP_K = 3;

export function prepare(cases: Case[]): ReplayCase[] {
  return cases.map((testCase) => ({
    bundleId: testCase.bundleId,
    focus: testCase.focus,
    candidates: postProcessCandidates(testCase.pool, testCase.focus, testCase.mode)
      .slice(0, 12)
      .map((candidate) => ({ source: candidate.source, excerpt: candidate.summary.slice(0, 240) })),
  }));
}

export function evaluate(cases: Case[], replay: ReplayCase[], scores: number[][]) {
  if (replay.length !== cases.length || scores.length !== cases.length) throw new Error("Case count mismatch");
  const totals = { cases: cases.length, scored: 0, upstreamMisses: 0, outsideTop12: 0, positiveLabels: 0,
    baselineHits: 0, shadowHits: 0, noiseLabels: 0, baselineNoise: 0, shadowNoise: 0, changedTop3: 0 };
  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const candidates = replay[i].candidates;
    const row = scores[i];
    if (replay[i].bundleId !== testCase.bundleId || row.length !== candidates.length ||
      row.some((score) => !Number.isFinite(score) || score < 0 || score > 1)) throw new Error(`Invalid scores for case ${i}`);
    totals.scored += candidates.length;
    const baseline = candidates.slice(0, TOP_K).map((c) => c.source);
    const shadow = candidates.map((candidate, index) => ({ source: candidate.source, score: row[index], index }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, TOP_K).map((c) => c.source);
    if (baseline.join("\n") !== shadow.join("\n")) totals.changedTop3++;
    for (const label of testCase.missed) {
      if (!testCase.pool.some((c) => labelMatches(label, c.source))) { totals.upstreamMisses++; continue; }
      if (!candidates.some((c) => labelMatches(label, c.source))) { totals.outsideTop12++; continue; }
      totals.positiveLabels++;
      if (baseline.some((s) => labelMatches(label, s))) totals.baselineHits++;
      if (shadow.some((s) => labelMatches(label, s))) totals.shadowHits++;
    }
    for (const label of testCase.noise) {
      if (!candidates.some((c) => labelMatches(label, c.source))) continue;
      totals.noiseLabels++;
      if (baseline.some((s) => labelMatches(label, s))) totals.baselineNoise++;
      if (shadow.some((s) => labelMatches(label, s))) totals.shadowNoise++;
    }
  }
  return totals;
}

async function main() {
  const model = process.env.LAYA_MODEL_PATH;
  if (!model) throw new Error("Set LAYA_MODEL_PATH to a pinned, locally available checkpoint directory");
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "fixture.json"), "utf8")) as { cases: Case[] };
  const replay = prepare(fixture.cases);
  const proc = Bun.spawn([process.env.LAYA_PYTHON ?? "python3", path.join(import.meta.dir, "laya-shadow.py"), model], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
    env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
  });
  proc.stdin.write(JSON.stringify(replay));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) throw new Error("Local Laya replay failed");
  const response = JSON.parse(stdout) as { scores: number[][]; elapsedMs: number; questionVersion: string };
  const devCases = fixture.cases.filter((c) => isDevCase(c.bundleId));
  const devIndexes = fixture.cases.flatMap((c, i) => isDevCase(c.bundleId) ? [i] : []);
  console.log(JSON.stringify({
    questionVersion: response.questionVersion,
    elapsedMs: response.elapsedMs,
    all: evaluate(fixture.cases, replay, response.scores),
    dev: evaluate(devCases, devIndexes.map((i) => replay[i]), devIndexes.map((i) => response.scores[i])),
    warning: "Exploratory shadow replay only: historical inferred labels, contaminated holdout; not an authorization or deployment gate.",
  }, null, 2));
}

if (import.meta.main) await main();
