/**
 * Retrieval suppression rules.
 *
 * Filters/downweights candidate sources whose artifact types pollute retrieval —
 * self-evaluation / status artifacts (types containing 'evaluation', 'eval-',
 * 'status', 'log', or 'trace') — and applies a mild recency boost favoring
 * newer artifacts.
 *
 * Query-independent by design: these artifact classes are agent self-reports
 * that rarely answer a user's question, so they are suppressed regardless of
 * the query. (Query-dependent eval handling lives in candidate-postprocess.)
 */

export type SuppressibleCandidate = {
  /** Candidate source type (e.g. "inquirer_memory") or artifact type (e.g. "evaluation"). */
  type: string;
  /** Candidate source URI, e.g. "inquirer_memory://<artifact-id>". */
  source: string;
  /** Base relevance in [0, 1] (optional; defaults to 0). */
  relevance?: number;
  /** Artifact creation time: epoch ms or ISO string. Drives the recency boost. */
  createdAt?: number | string;
};

/** Markers that identify self-evaluation / status artifact types. */
export const POLLUTING_MARKERS = ["evaluation", "eval", "status", "log", "trace"] as const;

/**
 * Word-boundary matcher: "login"/"catalog"/"blog" must NOT match the "log"
 * marker, while "trace-log", "eval-note", "status-report" and
 * "bundle-abc-evaluation-xyz" must. Trailing dashes are stripped so the
 * "eval-" marker behaves as "eval".
 */
const POLLUTING_RE = new RegExp(
  `\\b(${POLLUTING_MARKERS.map((m) => m.replace(/-$/, "")).join("|")})\\b`,
  "i",
);

export function isPollutingCandidate(candidate: { type: string; source: string }): boolean {
  const haystack = `${candidate.type ?? ""} ${candidate.source ?? ""}`;
  return POLLUTING_RE.test(haystack);
}

/** Mild recency window: artifacts newer than this get a boost; older ones get none. */
export const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Maximum recency boost applied to a brand-new artifact. */
export const MAX_RECENCY_BOOST = 0.1;

export function recencyBoost(createdAt: number | string | undefined, now = Date.now()): number {
  if (createdAt === undefined || createdAt === null || createdAt === "") return 0;
  const ts = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(ts)) return 0;
  const age = Math.max(0, now - ts);
  if (age >= RECENCY_WINDOW_MS) return 0;
  return MAX_RECENCY_BOOST * (1 - age / RECENCY_WINDOW_MS);
}

export type SuppressionResult = {
  suppressed: boolean;
  /** relevance + recency boost (0 when suppressed). */
  adjustedRelevance: number;
};

export function suppressCandidate(candidate: SuppressibleCandidate, now = Date.now()): SuppressionResult {
  if (isPollutingCandidate(candidate)) {
    return { suppressed: true, adjustedRelevance: 0 };
  }
  return { suppressed: false, adjustedRelevance: (candidate.relevance ?? 0) + recencyBoost(candidate.createdAt, now) };
}

/**
 * Filter + adjust a list of candidates in place-of-order (stable):
 * polluting candidates are removed, surviving candidates keep their relative
 * order with relevance bumped by the recency boost.
 */
export function applyCandidateSuppression(candidates: SuppressibleCandidate[], now = Date.now()): SuppressibleCandidate[] {
  const out: SuppressibleCandidate[] = [];
  for (const candidate of candidates) {
    const { suppressed, adjustedRelevance } = suppressCandidate(candidate, now);
    if (suppressed) continue;
    out.push({ ...candidate, relevance: adjustedRelevance });
  }
  return out;
}
