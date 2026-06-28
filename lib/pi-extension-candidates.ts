import path from "node:path";
import { existsSync } from "node:fs";

import type { AddContextItem } from "./context-adder";
import { pathSourceLabel } from "./exact-source";
import { readSnippetAround } from "./file-snippet";
import { isPiSherpaMetaDebugPrompt, isTraceLogMetricsPrompt } from "./query-classifier";

/** Pi extension candidate helpers that do not resolve extension roots themselves. */

export function addPiSherpaDebugSourceCandidates(ctx: { cwd: string }, focus: string, root: string, add: AddContextItem) {
  if (!isPiSherpaMetaDebugPrompt(focus)) return;
  const dspyPath = path.join(root, "lib", "dspy.ts");
  const indexPath = path.join(root, "index.ts");
  if (isTraceLogMetricsPrompt(focus) && existsSync(dspyPath)) {
    const raw = readSnippetAround(dspyPath, ["dspyTraceDir", "writeDspyTrace", "readDspyTraces", "summarizeDspyTraces"]);
    if (raw) add("file", pathSourceLabel(dspyPath, ctx.cwd), raw, 0.82);
  }
  if (existsSync(indexPath)) {
    const raw = readSnippetAround(indexPath, ["recordDspyTrace", "buildBundle", "compileContextWithModel", "planSources"]);
    if (raw) add("file", pathSourceLabel(indexPath, ctx.cwd), raw, 0.66);
  }
}
