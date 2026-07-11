#!/usr/bin/env bun
/**
 * @sherpa-purpose Verify candidate ranking: evaluation penalty, target term boost work.
 * @sherpa-timeout 60000
 * @sherpa-safe true
 */

import { candidateSortKey, postProcessCandidates } from "../lib/candidate-postprocess";

type ContextItem = { type: string; source: string; summary: string; raw?: string; relevance: number };

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) { passed++; }
  else { console.error(`❌ FAIL: ${label}`); failed++; }
}

// ─── 1. Evaluation penalty: eval items score lower on non-eval queries ───
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

const evalScore = candidateSortKey(evalItem, "fix the login bug", "front-door");
const normalScore = candidateSortKey(normalItem, "fix the login bug", "front-door");

// Eval items should score less than normal items for non-eval queries
assert("eval item scores lower than normal item for code query", evalScore < normalScore);
// Eval items should be penalized compared to just relevance
assert("eval item penalized (score < relevance)", evalScore < 0.24);

// ─── 2. Eval items NOT penalized for eval queries ───
const evalScoreEval = candidateSortKey(evalItem, "review sherpa evaluation metrics", "front-door");
const evalScoreEval2 = candidateSortKey(evalItem, "check eval precision recall", "front-door");
assert("eval item scores higher on eval query than code query", evalScoreEval > evalScore);
assert("eval item not penalized on 'eval' query", evalScoreEval2 >= evalScore);

// ─── 3. Target term boost ───
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

const matchedScore = candidateSortKey(termMatched, "review auth login implementation", "explicit");
const unrelatedScore = candidateSortKey(unrelated, "review auth login implementation", "explicit");
assert("term-matched candidate scores higher than unrelated", matchedScore > unrelatedScore);

// ─── 4. postProcessCandidates filters eval for non-eval queries ───
const candidates: ContextItem[] = [
  { type: "file", source: "repo://src/auth/login.ts", summary: "Login handler", relevance: 0.35 },
  { type: "memory_index", source: "memory-index://evaluation/wiki/evidence/sherpa-evaluations/bundle-xyz.md", summary: "Eval bundle xyz", relevance: 0.2 },
  { type: "memory_index", source: "memory-index://reflect/ref_20260701.md", summary: "Reflection about auth patterns", relevance: 0.25 },
];

const filtered = postProcessCandidates(candidates, "implement login page", "front-door");
assert("postProcess keeps file candidate", filtered.some((c) => c.source.includes("login.ts")));
assert("postProcess removes eval for non-eval query", !filtered.some((c) => c.source.includes("sherpa-evaluations")));


// ─── 5. postProcessCandidates keeps eval for eval queries ───
const filteredEval = postProcessCandidates(candidates, "check sherpa evaluation metrics", "front-door");
assert("postProcess keeps eval for eval query", filteredEval.some((c) => c.source.includes("sherpa-evaluations")));

// ─── Report ───
if (failed === 0) {
  console.log(`✅ All ${passed} ranking tests passed`);
} else {
  console.log(`⚠️  ${passed} passed, ${failed} failed`);
  process.exit(1);
}
