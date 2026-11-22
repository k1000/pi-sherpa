import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluateSourceChoices, SOURCE_LABELS, type RoutingCase } from "../bench/laya-source-routing";

const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../bench/source-routing-fixture.json"), "utf8")) as { version: string; cases: RoutingCase[] };
assert.equal(fixture.version, "source-routing-shadow-v1");
assert.equal(fixture.cases.length, 18);
assert.equal(new Set(fixture.cases.map((c) => c.id)).size, fixture.cases.length);
for (const label of SOURCE_LABELS) assert.ok(fixture.cases.some((c) => c.expected === label), `missing ${label} routing example`);
for (const c of fixture.cases) assert.ok(c.required.length > 0 && c.prompt, `incomplete fixture: ${c.id}`);

const cases: RoutingCase[] = [
  { id: "internet", prompt: "Search the internet for current news", expected: "web", required: ["web"] },
  { id: "oracle", prompt: "Find a lesson in Inquirer on Oracle", expected: "inquirer", required: ["inquirer"] },
];
const report = evaluateSourceChoices(cases, [
  { id: "internet", choice: "repo_code", probability: 0.8, elapsedMs: 30 },
  { id: "oracle", choice: "project_memory", probability: 0.4, elapsedMs: 50 },
]);
assert.equal(report.correct, 0);
assert.equal(report.webErrors, 1);
assert.equal(report.oracleLocalConfusions, 1);
assert.equal(report.highConfidence, 1);
assert.equal(report.highConfidenceErrors, 1);
assert.equal(report.baselineRequiredHits, 2);
assert.equal(report.baselineWebLocalLeaks, 0);
assert.equal(report.p50Ms, 30);
assert.equal(report.p95Ms, 30);
const unsupported = evaluateSourceChoices(
  [{ id: "ops", prompt: "check a remote service", expected: "unsupported", required: [] }],
  [{ id: "ops", choice: "inquirer", probability: 0.9, elapsedMs: 10 }],
);
assert.equal(unsupported.correct, 0, "a forced source choice cannot satisfy an unsupported operational request");
assert.equal(unsupported.baselineRequiredTotal, 0);
assert.throws(() => evaluateSourceChoices(cases, [{ id: "wrong", choice: "web", probability: 1, elapsedMs: 1 } as never]), /Invalid routing fixture or result count/);
assert.throws(() => evaluateSourceChoices(cases, [
  { id: "oracle", choice: "inquirer", probability: 1, elapsedMs: 1 },
  { id: "internet", choice: "web", probability: 1, elapsedMs: 1 },
]), /Invalid result/);
console.log("laya-source-routing tests passed");
