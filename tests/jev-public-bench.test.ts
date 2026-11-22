#!/usr/bin/env bun
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { questionSet, scoreRows, validateFixture, verifyApprovedFixture } from "../bench/jev-public-bench";

const raw = readFileSync(path.join(import.meta.dir, "../bench/public-relevance-fixture.json"), "utf8");
const fixture = JSON.parse(raw);
const cases = verifyApprovedFixture(raw);
assert.throws(() => verifyApprovedFixture(`${raw} `), /Fixture changed/);
assert.equal(cases.length, 22);
assert.equal(cases.filter((c) => !c.positive.length).length, 3);
const blind = cases.filter((c) => c.labelSource === "blind-model");
assert.equal(blind.length, 10);
assert.deepEqual(Object.fromEntries(blind.map((c) => [c.id, c.positive])), {
  "delete-authorization": [1], "retry-after-cap": [4], "invoice-tenant-check": [3],
  "download-cancel-cleanup": [2], "no-production-tls-bypass": [], "webhook-delivery-ack": [2],
  "distributed-job-dedupe": [3], "billing-timezone-cutoff": [0], "expired-jwt-rejection": [4],
  "rate-limit-composite-key": [3],
});
assert.ok(cases.every((c) => Object.keys(questionSet(c)).length === c.candidates.length));
assert.equal(questionSet(cases[0])["3"].type, "noul");
assert.match(questionSet(cases[0])["3"].instructions, /Judge the excerpt as evidence/);

const rows = cases.map((c) => c.candidates.map((_, i) => c.positive.includes(i) ? 0.95 : 0.05));
const results = scoreRows(cases, rows);
assert.equal(results.positives, 19);
assert.equal(results.baselineTop1, 2);
assert.equal(results.baselineTop3, 10);
assert.equal(results.modelTop1, 19);
assert.equal(results.modelTop3, 19);
assert.deepEqual(results.noMatch.map((x) => x.maxScore), [0.05, 0.05, 0.05]);
assert.throws(() => scoreRows(cases, rows.slice(1)), /Missing score rows/);
assert.throws(() => scoreRows(cases, [[Number.NaN], ...rows.slice(1)]), /Invalid score row/);
assert.throws(() => validateFixture({ ...fixture, provenance: "unknown" }), /synthetic-only fixture/);
assert.throws(() => validateFixture({ ...fixture, cases: [{ ...cases[0], candidates: [["/Users/kamil/secrets", "private"]] }] }), /Invalid synthetic case/);
console.log("Shareable Jev fixture and scoring checks passed");
