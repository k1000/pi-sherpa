import path from "node:path";
import { existsSync } from "node:fs";

import type { AddContextItem } from "./context-adder";
import { pathSourceLabel } from "./exact-source";
import { latestTraceFiles, traceFileStats } from "./file-snippet";
import { isTraceLogMetricsPrompt } from "./query-classifier";

/** Add Sherpa runtime trace-file context when the user's focus asks about trace/log metrics. */

export function addRuntimeTraceCandidates(ctx: { cwd: string }, focus: string, add: AddContextItem) {
  if (!isTraceLogMetricsPrompt(focus)) return;
  const traceDir = path.join(ctx.cwd, ".pi-memory", "sherpa-traces");
  if (!existsSync(traceDir)) return;
  const files = latestTraceFiles(traceDir);
  add("sherpa_trace_location", pathSourceLabel(traceDir, ctx.cwd), [
    "Sherpa retrieval traces are written under the active cwd, not necessarily under the pi-sherpa extension checkout.",
    `Active trace directory: ${traceDir}`,
    files.length ? "Recent trace files:" : "No trace jsonl files found.",
    ...files.map((file) => traceFileStats(traceDir, file)),
  ].join("\n"), 0.88);
}
