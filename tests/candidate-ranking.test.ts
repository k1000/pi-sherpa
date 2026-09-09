#!/usr/bin/env bun
/**
 * @sherpa-purpose Verify candidate ranking: evaluation penalty, target term boost,
 * ACT-R recency/frequency scoring, and backward compatibility.
 * @sherpa-timeout 60000
 * @sherpa-safe true
 */

import { candidateSortKey, postProcessCandidates, parentDirKey, decayScore, frequencyScore, applyRecencyBoost } from "../lib/candidate-postprocess";

type ContextItem = { type: string; source: string; summary: string; raw?: string; relevance: number; lastAccessedAt?: number; accessCount?: number };

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) { passed++; }
  else { console.error(`❌ FAIL: ${label}`); failed++; }
}

function approxEqual(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

// ═══════════════════════════════════════════════════════════════
// ACT-R Recency Scoring Tests
// ═══════════════════════════════════════════════════════════════

// ─── 1. decayScore: zero days → 1.0 ───
const now = Date.now();
assert("decayScore: today returns 1.0", approxEqual(decayScore(now, now, 14), 1.0));

// ─── 2. decayScore: exactly halfLife days (14) → ~0.5 ───
const halfLifeMs = 14 * 24 * 60 * 60 * 1000;
assert("decayScore: 14 days ago returns ~0.5", approxEqual(decayScore(now - halfLifeMs, now, 14), Math.exp(-1)));

// ─── 3. decayScore: 28 days ago → ~0.25 ───
const twoHalfLifeMs = 28 * 24 * 60 * 60 * 1000;
assert("decayScore: 28 days ago returns ~0.25", approxEqual(decayScore(now - twoHalfLifeMs, now, 14), Math.exp(-2)));

// ─── 4. decayScore: far past → ~0.0 ───
const farPastMs = 365 * 24 * 60 * 60 * 1000; // 1 year
assert("decayScore: 1 year ago returns ~0.0", decayScore(now - farPastMs, now, 14) < 0.001);

// ─── 5. decayScore: custom halfLife ───
assert("decayScore: custom 7-day halfLife", approxEqual(decayScore(now - 7 * 24 * 60 * 60 * 1000, now, 7), Math.exp(-1)));

// ─── 6. decayScore: negative diff clamped to 0 ───
assert("decayScore: future timestamp clamped to 0 → 1.0", approxEqual(decayScore(now + 100000, now, 14), 1.0));

// ═══════════════════════════════════════════════════════════════
// Frequency Score Tests
// ═══════════════════════════════════════════════════════════════

// ─── 7. frequencyScore: 0 accesses → 0 ───
assert("frequencyScore: 0 accesses returns 0", frequencyScore(0, 5) === 0);

// ─── 8. frequencyScore: baselineCount (5) → 0.5 ───
assert("frequencyScore: 5 accesses returns 0.5", approxEqual(frequencyScore(5, 5), 0.5));

// ─── 9. frequencyScore: 10 accesses → 1.0 (cap) ───
assert("frequencyScore: 10 accesses returns 1.0", approxEqual(frequencyScore(10, 5), 1.0));

// ─── 10. frequencyScore: many accesses → cap at 1.0 ───
assert("frequencyScore: 100 accesses caps at 1.0", approxEqual(frequencyScore(100, 5), 1.0));

// ─── 11. frequencyScore: custom baseline ───
assert("frequencyScore: custom baseline of 3", approxEqual(frequencyScore(3, 3), 0.5));

// ═══════════════════════════════════════════════════════════════
// applyRecencyBoost Tests
// ═══════════════════════════════════════════════════════════════

// ─── 12. applyRecencyBoost: recent + frequent item ───
const recentItem: ContextItem = {
  type: "file",
  source: "repo://src/utils.ts",
  summary: "Utility functions",
  relevance: 0.5,
  lastAccessedAt: now,
  accessCount: 10,
};
const boostScore = applyRecencyBoost(recentItem, now);
// 0.6 * 0.5 + 0.2 * 1.0 + 0.2 * 1.0 = 0.3 + 0.2 + 0.2 = 0.7
assert("applyRecencyBoost: recent+frequent item", approxEqual(boostScore, 0.7));

// ─── 13. applyRecencyBoost: old + infrequent item ───
const oldItem: ContextItem = {
  type: "file",
  source: "repo://src/utils.ts",
  summary: "Utility functions",
  relevance: 0.5,
  lastAccessedAt: now - halfLifeMs, // 14 days ago
  accessCount: 1,
};
const oldBoostScore = applyRecencyBoost(oldItem, now);
// 0.6 * 0.5 + 0.2 * exp(-1) + 0.2 * (1/10) = 0.3 + 0.2*0.3679 + 0.02 = 0.3 + 0.0736 + 0.02 = 0.3936
const expectedOld = 0.6 * 0.5 + 0.2 * Math.exp(-1) + 0.2 * (1 / 10);
assert("applyRecencyBoost: old+infrequent item scores lower", approxEqual(oldBoostScore, expectedOld));

// ─── 14. applyRecencyBoost: no lastAccessedAt → max recency ───
const noLastAccessItem: ContextItem = {
  type: "file",
  source: "repo://src/utils.ts",
  summary: "Utility functions",
  relevance: 0.5,
};
const noLastAccessScore = applyRecencyBoost(noLastAccessItem, now);
// 0.6 * 0.5 + 0.2 * 1.0 + 0.2 * 0 = 0.3 + 0.2 + 0 = 0.5
assert("applyRecencyBoost: no lastAccessedAt defaults to max recency", approxEqual(noLastAccessScore, 0.5));

// ─── 15. applyRecencyBoost: no accessCount → freq=0 ───
const noAccessCountItem: ContextItem = {
  type: "file",
  source: "repo://src/utils.ts",
  summary: "Utility functions",
  relevance: 0.5,
  lastAccessedAt: now,
};
const noAccessCountScore = applyRecencyBoost(noAccessCountItem, now);
// 0.6 * 0.5 + 0.2 * 1.0 + 0.2 * 0 = 0.5
assert("applyRecencyBoost: no accessCount defaults to 0 freq", approxEqual(noAccessCountScore, 0.5));

// ═══════════════════════════════════════════════════════════════
// candidateSortKey with recency boost
// ═══════════════════════════════════════════════════════════════

// ─── 16. candidateSortKey: newer item ranks higher with same relevance ───
const recent: ContextItem = {
  type: "file",
  source: "repo://src/auth/login.ts",
  summary: "Login handler",
  relevance: 0.24,
  lastAccessedAt: now,
  accessCount: 3,
};
const old: ContextItem = {
  type: "file",
  source: "repo://src/auth/login.ts",
  summary: "Login handler",
  relevance: 0.24,
  lastAccessedAt: now - 60 * 24 * 60 * 60 * 1000, // 60 days ago
  accessCount: 1,
};
const recentKey = candidateSortKey(recent, "fix the login bug", "front-door", now);
const oldKey = candidateSortKey(old, "fix the login bug", "front-door", now);
assert("candidateSortKey: recent item scores higher than old item", recentKey > oldKey);

// ═══════════════════════════════════════════════════════════════
// postProcessCandidates with recency
// ═══════════════════════════════════════════════════════════════

// ─── 17. postProcessCandidates: recent items ranked higher ───
const item1: ContextItem = { type: "doc_snippet", source: "repo://docs/guide.md", summary: "Old doc", relevance: 0.3, lastAccessedAt: now - 90 * 24 * 60 * 60 * 1000, accessCount: 1 };
const item2: ContextItem = { type: "doc_snippet", source: "repo://docs/recent.md", summary: "Recent doc", relevance: 0.3, lastAccessedAt: now, accessCount: 5 };
const items: ContextItem[] = [item1, item2];
const sortedRecency = postProcessCandidates(items, "read documentation", "front-door", now);
assert("postProcessCandidates: most recent item appears first", sortedRecency[0]?.source === "repo://docs/recent.md");

// ─── 18. postProcessCandidates: backward compat — no lastAccessedAt ───
const noAccess: ContextItem = { type: "file", source: "repo://src/main.ts", summary: "Entry point", relevance: 0.35 };
const noAccessFiltered = postProcessCandidates([noAccess], "fix the login bug", "front-door", now);
assert("postProcessCandidates: item without lastAccessedAt is still included", noAccessFiltered.some((c) => c.source.includes("main.ts")));

// ═══════════════════════════════════════════════════════════════
// Existing tests (preserved + adapted)
// ═══════════════════════════════════════════════════════════════

// ─── 19. Evaluation penalty: eval items score lower on non-eval queries ───
const evalItem: ContextItem = {
  type: "memory_index",
  source: "memory-index://evaluation/wiki/evidence/sherpa-evaluations/bundle-abc.md",
  summary: "Evaluation results for bundle abc about relevance",
  relevance: 0.24,
};

const normalItem: ContextItem = {
  type: "file",
  source: "repo://src/auth/login.ts",
  summary: "Login handler",
  relevance: 0.24,
};

// Use a fixed now for deterministic comparison
const fixedNow = now;
const evalScore = candidateSortKey(evalItem, "fix the login bug", "front-door", fixedNow);
const normalScore = candidateSortKey(normalItem, "fix the login bug", "front-door", fixedNow);

// Eval items should score less than normal items for non-eval queries
assert("eval item scores lower than normal item for code query", evalScore < normalScore);

// ─── 20. Eval items NOT penalized for eval queries ───
const evalScoreEval = candidateSortKey(evalItem, "review sherpa evaluation metrics", "front-door", fixedNow);
const evalScoreEval2 = candidateSortKey(evalItem, "check eval precision recall", "front-door", fixedNow);
assert("eval item scores higher on eval query than code query", evalScoreEval > evalScore);
assert("eval item not penalized on 'eval' query", evalScoreEval2 >= evalScore);

// ─── 21. Target term boost ───
const termMatched: ContextItem = {
  type: "file",
  source: "repo://src/auth/login.ts",
  summary: "Login authentication flow with OAuth",
  relevance: 0.2,
  raw: "export function loginUser() { ... }",
};
const unrelated: ContextItem = {
  type: "file",
  source: "repo://src/db/connect.ts",
  summary: "Database connection pool",
  relevance: 0.2,
};

const matchedScore = candidateSortKey(termMatched, "review auth login implementation", "explicit", fixedNow);
const unrelatedScore = candidateSortKey(unrelated, "review auth login implementation", "explicit", fixedNow);
assert("term-matched candidate scores higher than unrelated", matchedScore > unrelatedScore);

// ─── 22. postProcessCandidates filters eval for non-eval queries ───
const candidates: ContextItem[] = [
  { type: "file", source: "repo://src/auth/login.ts", summary: "Login handler", relevance: 0.35 },
  { type: "memory_index", source: "memory-index://evaluation/wiki/evidence/sherpa-evaluations/bundle-xyz.md", summary: "Eval bundle xyz", relevance: 0.2 },
  { type: "memory_index", source: "memory-index://reflect/ref_20260701.md", summary: "Reflection about auth patterns", relevance: 0.25 },
];

const filtered = postProcessCandidates(candidates, "implement login page", "front-door", fixedNow);
assert("postProcess keeps file candidate", filtered.some((c) => c.source.includes("login.ts")));
assert("postProcess removes eval for non-eval query", !filtered.some((c) => c.source.includes("sherpa-evaluations")));

// ─── 23. postProcessCandidates keeps eval for eval queries ───
const filteredEval = postProcessCandidates(candidates, "check sherpa evaluation metrics", "front-door", fixedNow);
assert("postProcess keeps eval for eval query", filteredEval.some((c) => c.source.includes("sherpa-evaluations")));

// ─── 24. postProcessCandidates caps same-directory items for context diversity ───
const sameDir: ContextItem[] = [
  { type: "file", source: "repo://src/auth/a.ts", summary: "auth a", relevance: 0.9 },
  { type: "file", source: "repo://src/auth/b.ts", summary: "auth b", relevance: 0.88 },
  { type: "file", source: "repo://src/auth/c.ts", summary: "auth c", relevance: 0.86 },
  { type: "file", source: "repo://src/db/pool.ts", summary: "db pool", relevance: 0.5 },
];
const diversified = postProcessCandidates(sameDir, "review auth login implementation", "explicit", fixedNow);
const thirdDirKey = diversified[2] ? parentDirKey(diversified[2].source) : "";
assert("diversity: third slot comes from another directory", thirdDirKey.includes("db"));
assert("diversity: overflow items are retained", diversified.length === 4);

// ─── 25. Sherpa traces require a Sherpa-specific prompt ───
const traceCand: ContextItem[] = [
  { type: "sherpa_trace_location", source: "repo://.pi-memory/sherpa-traces", summary: "2 traces", relevance: 0.9 },
  { type: "file", source: "repo://src/app.ts", summary: "app", relevance: 0.5 },
];
assert(
  "sherpa traces excluded for generic log prompts",
  !postProcessCandidates(traceCand, "diagnose slow requests, need relevant logs", "explicit", fixedNow).some((c) => c.type === "sherpa_trace_location"),
);
assert(
  "sherpa traces kept for sherpa trace/metrics prompts",
  postProcessCandidates(traceCand, "review sherpa traces and metrics", "explicit", fixedNow).some((c) => c.type === "sherpa_trace_location"),
);

// ─── Report ───
if (failed === 0) {
  console.log(`✅ All ${passed} ranking tests passed`);
} else {
  console.log(`⚠️  ${passed} passed, ${failed} failed`);
  process.exit(1);
}
