export type TimingRecord = {
  at: string;
  action: string;
  durationMs: number;
};

type TimingSummary = {
  action: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
};

function percentile(values: number[], percentile: number) {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentile) - 1));
  return values[index] ?? 0;
}

export function parseTimingRecords(text: string): TimingRecord[] {
  const records: TimingRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (typeof value?.at === "string" && typeof value?.action === "string" && Number.isFinite(value?.durationMs) && value.durationMs >= 0) {
        records.push({ at: value.at, action: value.action, durationMs: value.durationMs });
      }
    } catch { /* ignore incomplete/corrupt JSONL lines */ }
  }
  return records;
}

export function summarizeTimingRecords(records: TimingRecord[]): TimingSummary[] {
  const byAction = new Map<string, number[]>();
  for (const record of records) {
    const values = byAction.get(record.action) ?? [];
    values.push(record.durationMs);
    byAction.set(record.action, values);
  }
  return [...byAction.entries()].map(([action, values]) => {
    values.sort((a, b) => a - b);
    return { action, count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values[values.length - 1] ?? 0 };
  }).sort((a, b) => b.p95 - a.p95 || b.count - a.count || a.action.localeCompare(b.action));
}

export function formatTimingReport(records: TimingRecord[], thresholdMs: number) {
  if (!records.length) return `No timing records yet. Timing logs only include operations at or above ${thresholdMs}ms.`;
  const lines = [
    `Sherpa timing summary (${records.length} sampled events; threshold ${thresholdMs}ms)`,
    "action | count | p50 | p95 | max",
    "--- | ---: | ---: | ---: | ---:",
  ];
  for (const summary of summarizeTimingRecords(records).slice(0, 12)) {
    lines.push(`${summary.action} | ${summary.count} | ${summary.p50}ms | ${summary.p95}ms | ${summary.max}ms`);
  }
  return lines.join("\n");
}
