#!/usr/bin/env bun
/**
 * Background model worker for post-task work.
 * 
 * Handles LLM calls that would otherwise block Pi's TUI event loop.
 * Runs as a child process so the main agent process stays responsive.
 * 
 * Uses @mariozechner/pi-ai's complete() for proper provider-specific
 * handling (OpenAI, Anthropic, Google, Mistral, etc.).
 * 
 * Usage: bun run scripts/background-model-worker.ts <work-type> <input-json>
 *   work-type: "task-reflection" | "session-analysis" | "dspy-compile"
 *   input-json: JSON payload
 * 
 * Outputs JSON to stdout. Exit code 0 on success, 1 on error.
 */

import { complete } from "@mariozechner/pi-ai";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

interface ModelDef {
  provider: string;
  id: string;
  api: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

interface AuthPayload {
  apiKey?: string;
  headers?: Record<string, string>;
}

interface TaskReflectionInput {
  retrievalPrompt: string;
  model: ModelDef;
  auth: AuthPayload;
  messages: Array<{ role: string; content: Array<{ type: string; text: string }>; timestamp: number }>;
  timeoutMs: number;
}

interface SessionAnalysisInput {
  model: ModelDef;
  auth: AuthPayload;
  systemPrompt: string;
  messageText: string;
  timeoutMs: number;
}

interface CompileInput {
  scriptPath: string;
  basePrompt: string;
  outDir: string;
  cwd: string;
  timeoutMs: number;
}

const workType = process.argv[2];
const inputJson = process.argv[3];

if (!workType || !inputJson) {
  console.error(JSON.stringify({ error: "Usage: bun background-model-worker.ts <work-type> <input-json>" }));
  process.exit(1);
}

function makeModel(model: ModelDef, auth: AuthPayload) {
  return {
    provider: model.provider,
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: auth.apiKey,
    headers: auth.headers,
  };
}

async function run() {
  switch (workType) {
    case "task-reflection": {
      const input: TaskReflectionInput = JSON.parse(inputJson);
      const { retrievalPrompt, model: modelDef, auth, messages, timeoutMs } = input;
      const modelObj = makeModel(modelDef, auth);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await complete(modelObj, {
          systemPrompt: retrievalPrompt,
          messages: messages as any,
        }, { signal: controller.signal, apiKey: auth.apiKey, headers: auth.headers });

        const aborted = response.stopReason === "aborted";
        const text = response.content
          .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();

        console.log(JSON.stringify({ aborted, text, error: null }));
      } catch (err) {
        const isTimeout = (err as Error).name === "AbortError";
        console.log(JSON.stringify({ aborted: isTimeout, text: "", error: isTimeout ? "timed out" : String(err) }));
      } finally {
        clearTimeout(timer);
      }
      break;
    }

    case "session-analysis": {
      const input: SessionAnalysisInput = JSON.parse(inputJson);
      const { model: modelDef, auth, systemPrompt, messageText, timeoutMs } = input;
      const modelObj = makeModel(modelDef, auth);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await complete(modelObj, {
          systemPrompt,
          messages: [{ role: "user", content: [{ type: "text", text: messageText }] }],
        }, { signal: controller.signal, apiKey: auth.apiKey, headers: auth.headers });

        const aborted = response.stopReason === "aborted";
        const text = response.content
          .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();

        console.log(JSON.stringify({ aborted, text, error: null }));
      } catch (err) {
        const isTimeout = (err as Error).name === "AbortError";
        console.log(JSON.stringify({ aborted: isTimeout, text: "", error: isTimeout ? "timed out" : String(err) }));
      } finally {
        clearTimeout(timer);
      }
      break;
    }

    case "dspy-compile": {
      const input: CompileInput = JSON.parse(inputJson);
      const { scriptPath, basePrompt, outDir, cwd, timeoutMs } = input;
      try {
        const stdout = execFileSync("python3", [scriptPath, "--base-prompt", basePrompt, "--out-dir", outDir], {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1_000_000,
          encoding: "utf8",
        });
        console.log(JSON.stringify({ aborted: false, stdout, error: null }));
      } catch (err: any) {
        if (err.killed || err.signal) {
          console.log(JSON.stringify({ aborted: true, stdout: err.stdout || "", error: "timed out" }));
        } else {
          console.log(JSON.stringify({ aborted: false, stdout: err.stdout || "", error: err.message }));
        }
      }
      break;
    }

    default:
      console.error(JSON.stringify({ error: `Unknown work type: ${workType}` }));
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
