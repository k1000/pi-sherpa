#!/usr/bin/env bun
/** Replay a bounded private prompt sample through the configured Sherpa planner. No retrieval or context injection. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { completeJsonObjectWithTimeout } from "../lib/model-completion";
import { parsePlannedSourcePlan, routedFallbackPlan, sourcePlanningMessage, type Source } from "../lib/source-planning";

const samplePath = process.argv[2];
if (import.meta.main) {
  if (process.env.SHERPA_SHADOW_ALLOW_REMOTE !== "1" || !samplePath || !path.isAbsolute(samplePath))
    throw new Error("Usage: SHERPA_SHADOW_ALLOW_REMOTE=1 bun bench/live-source-planner-shadow.ts /absolute/private/sample.json");
  const config = JSON.parse(readFileSync(path.join(process.env.HOME!, ".pi/sherpa.config.json"), "utf8"));
  if (!config.privacy?.allowRemoteModel || config.model?.heuristicOnly || config.model?.useMainPiModel)
    throw new Error("Configured Sherpa side planner is unavailable for remote replay");
  const provider = JSON.parse(readFileSync(path.join(process.env.HOME!, ".pi/agent/models.json"), "utf8")).providers[config.model.provider];
  const modelSpec = provider?.models?.find((model: { id: string }) => model.id === config.model.id);
  if (!modelSpec || !provider.apiKey) throw new Error("Configured Sherpa model or authentication unavailable");
  // models.json supports !command and $NAME credential references; never print the resolved key.
  const credential = String(provider.apiKey);
  const apiKey = credential.startsWith("!")
    ? execFileSync("sh", ["-c", credential.slice(1)], { encoding: "utf8", timeout: 5000 }).trim()
    : credential.startsWith("$") ? process.env[credential.slice(1).replace(/^\{|\}$/g, "")] : credential;
  if (!apiKey) throw new Error("Configured Sherpa credential resolved empty");
  const model = { ...modelSpec, provider: config.model.provider, api: provider.api, baseUrl: provider.baseUrl };
  const samples = JSON.parse(readFileSync(samplePath, "utf8")) as Array<{ id: string; prompt: string; mode?: string }>;
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 12
    || samples.some((c) => !/^[a-z][a-z0-9-]*$/.test(c.id) || !c.prompt?.trim() || c.prompt.length > 1000))
    throw new Error("Expected 1–12 bounded, locally reviewed, private prompts");
  const allEnabled = Object.fromEntries(["files", "semble", "graphify", "docs", "git", "session", "project_memory", "inquirer", "web"]
    .map((source) => [source, true])) as Record<Source, boolean>;
  const actualEnabled = { ...allEnabled, ...config.sources };
  const systemPrompt = readFileSync(path.join(import.meta.dir, "../prompts/RETRIEVAL.md"), "utf8");
  const rows = [];
  for (const sample of samples) {
    const started = performance.now();
    const mode = sample.mode === "explicit" ? "explicit" : "front-door";
    try {
      const response = await completeJsonObjectWithTimeout(
        { retrievalPrompt: systemPrompt, config }, { signal: undefined } as never,
        model, { apiKey }, sourcePlanningMessage(sample.prompt), 12_000, "source planner timed out",
      );
      const simulated = parsePlannedSourcePlan({ config: { sources: allEnabled } }, sample.prompt, mode, response.parsed);
      const configured = parsePlannedSourcePlan({ config: { sources: actualEnabled } }, sample.prompt, mode, response.parsed);
      rows.push({ id: sample.id,
        simulatedSources: (simulated ?? routedFallbackPlan({ config: { sources: allEnabled } }, sample.prompt, mode)).sources,
        configuredSources: (configured ?? routedFallbackPlan({ config: { sources: actualEnabled } }, sample.prompt, mode)).sources,
        usedFallback: !simulated, elapsedMs: Math.round(performance.now() - started),
        error: response.aborted ? "aborted" : simulated ? null : "invalid plan" });
    } catch (error) {
      rows.push({ id: sample.id,
        simulatedSources: routedFallbackPlan({ config: { sources: allEnabled } }, sample.prompt, mode).sources,
        configuredSources: routedFallbackPlan({ config: { sources: actualEnabled } }, sample.prompt, mode).sources,
        usedFallback: true, elapsedMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message.slice(0, 120) : "planner error" });
    }
  }
  console.log(JSON.stringify({ planner: `${model.provider}/${model.id}`, rows,
    warning: "Private bounded replay of the configured model planner. Simulated sources assume all enabled; configured sources preserve current web=false. No retrieval was executed." }, null, 2));
}
