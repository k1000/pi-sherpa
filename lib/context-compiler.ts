export type RejectionManifestItem = { index: number; source: string };

/** Pure parser helpers for Sherpa context compiler model output. */

export function parseCurationRejected(parsed: any, manifest: RejectionManifestItem[]): Array<{ index: number; reason: string; source: string }> {
  if (!Array.isArray(parsed?.rejected)) return [];
  return parsed.rejected.filter((r: any) => typeof r?.index === "number").map((r: any) => ({
    index: Number(r.index),
    reason: String(r.reason ?? ""),
    source: String(manifest[r.index]?.source ?? ""),
  }));
}

export function parseCompiledContextItems(parsed: any, itemCount: number): Array<{ index: number; summary?: string; why?: string }> {
  const raw = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: Array<{ index: number; summary?: string; why?: string }> = [];
  for (const item of raw) {
    const n = typeof item?.index === "number" ? item.index : Number(item?.index);
    if (!Number.isInteger(n) || n < 0 || n >= itemCount || out.some((x) => x.index === n)) continue;
    out.push({
      index: n,
      summary: typeof item.summary === "string" ? item.summary.trim().slice(0, 700) : undefined,
      why: typeof item.why === "string" ? item.why.trim().slice(0, 240) : undefined,
    });
    if (out.length >= 3) break;
  }
  return out;
}

export function preserveExpandHint(summary: string, originalSummary: string, handle: string): string {
  const existingHint = originalSummary.match(/\s*\(expand with \/sherpa:expand ctx-\d+\)$/i)?.[0];
  const hint = existingHint ?? ` (expand with /sherpa:expand ${handle})`;
  if (/\(expand with \/sherpa:expand ctx-\d+\)$/i.test(summary)) return summary;
  return `${summary.replace(/\s+/g, " ").trim()}${hint}`;
}
