import assert from "node:assert/strict";
import { formatTimingReport, parseTimingRecords, summarizeTimingRecords } from "../lib/timing-metrics";

const records = parseTimingRecords([
  '{"at":"2026-01-01T00:00:00Z","action":"curate","durationMs":400}',
  'not-json',
  '{"at":"2026-01-01T00:00:01Z","action":"curate","durationMs":100}',
  '{"at":"2026-01-01T00:00:02Z","action":"files","durationMs":300}',
].join("\n"));

assert.equal(records.length, 3, "invalid JSONL lines must be ignored");
const summaries = summarizeTimingRecords(records);
assert.deepEqual(summaries[0], { action: "curate", count: 2, p50: 100, p95: 400, max: 400 });
assert.deepEqual(summaries[1], { action: "files", count: 1, p50: 300, p95: 300, max: 300 });
assert.match(formatTimingReport(records, 250), /3 sampled events; threshold 250ms/);
assert.match(formatTimingReport([], 250), /No timing records yet/);

console.log("timing-metrics tests passed");
