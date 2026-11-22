#!/usr/bin/env bun
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redact, selectHistorical } from "../bench/jev-historical-bench";
import type { Case } from "../bench/laya-shadow";

assert.equal(redact("/Users/someone/project 192.168.1.2 name@example.com"), "/Users/[HOME]/project [IP] [EMAIL]");
assert.equal(redact("https://internal.example.org/path 123e4567-e89b-12d3-a456-426614174000"), "[URL] [UUID]");
const cases = JSON.parse(readFileSync(path.join(import.meta.dir, "../bench/fixture.json"), "utf8")).cases as Case[];
const result = selectHistorical(cases);
assert.ok(result.originals.length > 0 && result.originals.length <= 110);
assert.equal(result.originals.length + result.excluded, cases.length);
assert.ok(result.outgoing.every((c) => c.candidates.length >= 2));
assert.ok(result.outgoing.every((c) => c.focus.length <= 1200));
assert.ok(result.outgoing.every((c) => [c.focus, ...c.candidates.flatMap((x) => [x.source, x.excerpt])]
  .every((text) => !/\b\w+@\w+\.[a-z]{2,}\b|\/Users\/kamil\b|https?:\/\//i.test(text))));
assert.ok(result.outgoing.every((c, i) => c.bundleId === result.originals[i].bundleId));
const safe = result.originals[0];
const screened = selectHistorical([safe, { ...safe, bundleId: "injected", focus: `${safe.focus} sk-ABCDEFGHIJKLMN123` }]);
assert.equal(screened.outgoing.length, 1);
assert.equal(screened.excluded, 1);
console.log(`Historical egress guard checks passed; ${result.originals.length} candidate cases, ${result.excluded} excluded`);
