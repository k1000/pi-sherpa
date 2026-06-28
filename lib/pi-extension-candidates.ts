import path from "node:path";
import { existsSync } from "node:fs";

import type { AddContextItem } from "./context-adder";
import { pathSourceLabel } from "./exact-source";
import { labelRgSource, readSnippetAround } from "./file-snippet";
import { isPiSherpaMetaDebugPrompt, isTraceLogMetricsPrompt } from "./query-classifier";
import { parseRgOutput, rg } from "./rg";
import type { SearchIndicators } from "./source-planning";

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

export async function addPiExtensionCandidates(
  ctx: { cwd: string },
  focus: string,
  indicators: SearchIndicators,
  roots: Array<{ name: string; root: string }>,
  add: AddContextItem,
) {
  for (const { name, root } of roots) {
    const keyFiles = ["README.md", "package.json", "index.ts", "SHERPA_SYSTEM.md", "lib/dspy.ts"]
      .filter((file) => existsSync(path.join(root, file)));
    add("pi_extension_route", pathSourceLabel(root, ctx.cwd), [
      `Pi extension route: ${name}`,
      `Root: ${root}`,
      keyFiles.length ? `Key files: ${keyFiles.join(", ")}` : "Key files: none detected",
      isTraceLogMetricsPrompt(focus) ? "Trace logs: active cwd .pi-memory/sherpa-traces/*.jsonl" : "",
    ].filter(Boolean).join("\n"), 0.7);
    addPiSherpaDebugSourceCandidates(ctx, focus, root, add);

    const query = [focus, ...indicators.indicators].join(" ");
    const out = await rg(ctx.cwd, query, root);
    for (const { fileAndLine, content } of parseRgOutput(out, 12)) {
      if (content) add("file", labelRgSource(fileAndLine, ctx.cwd), content, 0.42);
    }
  }
}
