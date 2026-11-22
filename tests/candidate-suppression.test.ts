#!/usr/bin/env bun
/**
 * @sherpa-purpose Retrieval suppression rules: polluting artifact types removed,
 * recency boost favors newer artifacts, normal candidates pass through.
 * @sherpa-timeout 60000
 * @sherpa-safe true
 */

import assert from "node:assert/strict";
import {
  applyCandidateSuppression,
  isPollutingCandidate,
  MAX_RECENCY_BOOST,
  POLLUTING_MARKERS,
  RECENCY_WINDOW_MS,
  recencyBoost,
  suppressCandidate,
  type SuppressibleCandidate,
} from "../lib/candidate-suppression";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) { tests.push({ name, fn }); }

const NOW = Date.parse("2026-07-31T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
// (a) evaluation/status-type candidates are removed
// ═══════════════════════════════════════════════════════════

test("each polluting marker is recognized on artifact types", () => {
  for (const marker of POLLUTING_MARKERS) {
    const type = `memory-${marker}-report`;
    assert.equal(isPollutingCandidate({ type, source: "inquirer_memory://abc" }), true, `marker ${marker}`);
  }
  assert.equal(isPollutingCandidate({ type: "evaluation", source: "inquirer_memory://abc" }), true);
  assert.equal(isPollutingCandidate({ type: "eval-note", source: "inquirer_memory://abc" }), true);
  assert.equal(isPollutingCandidate({ type: "status-report", source: "inquirer_memory://abc" }), true);
  assert.equal(isPollutingCandidate({ type: "trace-log", source: "inquirer_memory://abc" }), true);
});

test("pollution is also detected via the source URI", () => {
  assert.equal(isPollutingCandidate({ type: "inquirer_graph", source: "inquirer_graph://bundle-abc-evaluation-xyz" }), true);
});

test("suppressCandidate hard-suppresses evaluation/status artifacts", () => {
  const evalResult = suppressCandidate({ type: "evaluation", source: "inquirer_memory://e1", relevance: 0.9 }, NOW);
  assert.equal(evalResult.suppressed, true);
  const statusResult = suppressCandidate({ type: "status-report", source: "inquirer_memory://s1", relevance: 0.9 }, NOW);
  assert.equal(statusResult.suppressed, true);
});

test("applyCandidateSuppression removes evaluation/status candidates", () => {
  const candidates: SuppressibleCandidate[] = [
    { type: "inquirer_memory", source: "inquirer_memory://normal-1", relevance: 0.5 },
    { type: "evaluation", source: "inquirer_memory://eval-1", relevance: 0.9 },
    { type: "trace-log", source: "inquirer_memory://trace-1", relevance: 0.8 },
    { type: "status-report", source: "inquirer_memory://status-1", relevance: 0.7 },
  ];
  const kept = applyCandidateSuppression(candidates, NOW);
  assert.deepEqual(kept.map((c) => c.source), ["inquirer_memory://normal-1"]);
});

test("applyCandidateSuppression removes candidates whose source embeds polluting type", () => {
  const candidates: SuppressibleCandidate[] = [
    { type: "inquirer_graph", source: "inquirer_graph://bundle-abc-evaluation-xyz", relevance: 0.6 },
    { type: "inquirer_graph", source: "inquirer_graph://bundle-ok", relevance: 0.3 },
  ];
  const kept = applyCandidateSuppression(candidates, NOW);
  assert.deepEqual(kept.map((c) => c.source), ["inquirer_graph://bundle-ok"]);
});

// ═══════════════════════════════════════════════════════════
// (b) recency boost favors newer artifacts
// ═══════════════════════════════════════════════════════════

test("recencyBoost: brand-new artifact gets max mild boost", () => {
  assert.equal(recencyBoost(NOW, NOW), MAX_RECENCY_BOOST);
  assert.equal(recencyBoost(new Date(NOW).toISOString(), NOW), MAX_RECENCY_BOOST);
});

test("recencyBoost: half window yields half boost", () => {
  const half = recencyBoost(NOW - RECENCY_WINDOW_MS / 2, NOW);
  assert.ok(Math.abs(half - MAX_RECENCY_BOOST / 2) < 0.001);
});

test("recencyBoost: window-old artifact gets no boost", () => {
  assert.equal(recencyBoost(NOW - RECENCY_WINDOW_MS, NOW), 0);
  assert.equal(recencyBoost(NOW - 30 * DAY, NOW), 0);
});

test("recencyBoost: missing or unparseable createdAt gets no boost", () => {
  assert.equal(recencyBoost(undefined, NOW), 0);
  assert.equal(recencyBoost("", NOW), 0);
  assert.equal(recencyBoost("not-a-date", NOW), 0);
});

test("recency boost favors newer artifact over older with equal relevance", () => {
  const newer = suppressCandidate({ type: "inquirer_memory", source: "inquirer_memory://new", relevance: 0.5, createdAt: NOW - DAY }, NOW);
  const older = suppressCandidate({ type: "inquirer_memory", source: "inquirer_memory://old", relevance: 0.5, createdAt: NOW - 30 * DAY }, NOW);
  assert.equal(newer.suppressed, false);
  assert.equal(older.suppressed, false);
  assert.ok(newer.adjustedRelevance > older.adjustedRelevance, `newer ${newer.adjustedRelevance} should outrank older ${older.adjustedRelevance}`);
});

test("applyCandidateSuppression keeps recency-boosted relevance on survivors", () => {
  const candidates: SuppressibleCandidate[] = [
    { type: "inquirer_memory", source: "inquirer_memory://old", relevance: 0.5, createdAt: NOW - 30 * DAY },
    { type: "inquirer_memory", source: "inquirer_memory://new", relevance: 0.5, createdAt: NOW - DAY },
  ];
  const kept = applyCandidateSuppression(candidates, NOW);
  assert.equal(kept.length, 2);
  const bySource = new Map(kept.map((c) => [c.source, c.relevance]));
  assert.ok((bySource.get("inquirer_memory://new") ?? 0) > (bySource.get("inquirer_memory://old") ?? 0));
});

// ═══════════════════════════════════════════════════════════
// (c) normal candidates pass through unchanged
// ═══════════════════════════════════════════════════════════

test("normal candidates are neither suppressed nor downweighted", () => {
  const candidates: SuppressibleCandidate[] = [
    { type: "file", source: "repo://src/auth/login.ts", relevance: 0.5 },
    { type: "inquirer_memory", source: "inquirer_memory://vault.pi-sherpa.c699c98755502adc", relevance: 0.4 },
    { type: "doc_snippet", source: "repo://docs/guide.md", relevance: 0.25 },
  ];
  const kept = applyCandidateSuppression(candidates, NOW);
  assert.deepEqual(kept, candidates, "normal candidates must pass through unchanged");
});

test("candidates without createdAt get no recency boost", () => {
  const { suppressed, adjustedRelevance } = suppressCandidate({ type: "file", source: "repo://src/main.ts", relevance: 0.33 }, NOW);
  assert.equal(suppressed, false);
  assert.equal(adjustedRelevance, 0.33);
});

test("order is preserved for surviving candidates", () => {
  const candidates: SuppressibleCandidate[] = [
    { type: "file", source: "repo://a.ts", relevance: 0.2 },
    { type: "evaluation", source: "inquirer_memory://drop", relevance: 0.9 },
    { type: "file", source: "repo://b.ts", relevance: 0.1 },
  ];
  const kept = applyCandidateSuppression(candidates, NOW);
  assert.deepEqual(kept.map((c) => c.source), ["repo://a.ts", "repo://b.ts"]);
});

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
