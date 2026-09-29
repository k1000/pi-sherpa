#!/usr/bin/env bun
import assert from "node:assert/strict";
import { evaluate, prepare, type Case, type ReplayCase } from "../bench/laya-shadow";

const testCase: Case = {
  bundleId: "one", focus: "Find where authentication is checked", mode: "explicit",
  pool: [
    { type: "file", source: "repo://src/noise.ts:1", summary: "A", relevance: 0.6 },
    { type: "file", source: "repo://src/other.ts:2", summary: "B", relevance: 0.5 },
    { type: "file", source: "repo://src/third.ts:3", summary: "C", relevance: 0.4 },
    { type: "file", source: "repo://src/auth.ts:4", summary: "D", relevance: 0.3 },
  ],
  missed: ["src/auth.ts", "src/absent.ts"], noise: ["src/noise.ts"],
};
const replay: ReplayCase[] = [{ bundleId: "one", focus: testCase.focus, candidates: testCase.pool.map((c) => ({ source: c.source, excerpt: c.summary })) }];

assert.deepEqual(evaluate([testCase], replay, [[0.1, 0.2, 0.3, 0.9]]), {
  cases: 1, scored: 4, upstreamMisses: 1, outsideTop12: 0, positiveLabels: 1,
  baselineHits: 0, shadowHits: 1, noiseLabels: 1, baselineNoise: 1, shadowNoise: 0, changedTop3: 1,
});
assert.throws(() => evaluate([testCase], replay, [[0.1]]), /Invalid scores/);
assert.throws(() => evaluate([testCase], replay, [[0.1, 0.2, Number.NaN, 0.4]]), /Invalid scores/);
assert.throws(() => evaluate([testCase], replay, [[0.1, 0.2, 1.1, 0.4]]), /Invalid scores/);
const prepared = prepare([testCase])[0];
assert.equal(prepared.bundleId, "one");
assert.ok(prepared.candidates.length <= 4);
assert.ok(prepared.candidates.every((c) => c.excerpt.length <= 240));
console.log("Laya shadow evaluation checks passed");
