import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { extractJsonObject } from "./json-utils";
import { summarize } from "./text-utils";

/** Sidecar model completion helpers with timeout and JSON-object parsing. */

type RetrievalPromptStateLike = { retrievalPrompt: string };

type SummarizeStateLike = {
  distillPrompt: string;
  config: {
    privacy: { allowRemoteModel: boolean };
    model: { provider: string; id: string; useMainPiModel: boolean; heuristicOnly: boolean; fallbackToHeuristics: boolean; structuredOutput?: "tool_json_schema" };
  };
};

export function timeoutAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

async function completeWithAbortableTimeout(
  model: any,
  systemPrompt: string,
  messages: UserMessage[],
  auth: any,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
  onPayload?: (payload: unknown, model: any) => unknown | undefined | Promise<unknown | undefined>,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromContext = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.("abort", abortFromContext, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      complete(model, { systemPrompt, messages }, { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal, onPayload }),
      new Promise<any>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timedOut) controller.abort();
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromContext);
  }
}

function sherpaModelName(model: any): string {
  return `${model?.provider ?? ""}/${model?.id ?? model?.name ?? ""}`.toLowerCase();
}

export function usesSherpaToolJsonSchema(model: any): boolean {
  // GLM satisfies forced tool calls with an empty arguments object; its reliable
  // JSON contract is the text response requested by the prompt.
  return !sherpaModelName(model).includes("glm");
}

export function sherpaStructuredJsonPayload(payload: unknown, model: any): unknown | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const disableThinking = !sherpaModelName(model).includes("glm");
  return {
    ...(payload as Record<string, unknown>),
    // GLM models reject enable_thinking=false because thinking is mandatory.
    // Other OpenAI-compatible/Qwen sidecars need it disabled for forced tool calls.
    ...(disableThinking ? { enable_thinking: false } : {}),
    tools: [{
      type: "function",
      function: {
        name: "emit_sherpa_json",
        description: "Return the requested Sherpa planner result as structured JSON.",
        parameters: {
          type: "object",
          additionalProperties: true,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "emit_sherpa_json" } },
  };
}

export function extractToolJsonObject(response: any): unknown {
  const toolCall = response.content?.find?.((c: any) => c?.type === "toolCall" && c?.name === "emit_sherpa_json");
  const argumentsValue = toolCall?.arguments;
  if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) return argumentsValue;
  return typeof argumentsValue === "string" ? extractJsonObject(argumentsValue) : null;
}

export async function completeJsonObjectWithTimeout(
  state: RetrievalPromptStateLike,
  ctx: ExtensionContext,
  model: any,
  auth: any,
  message: UserMessage,
  timeoutMs: number,
  timeoutMessage: string,
) {
  const structuredOutput = (state as any).config?.model?.structuredOutput;
  const onPayload = structuredOutput === "tool_json_schema" && usesSherpaToolJsonSchema(model)
    ? (payload: unknown, completionModel: any) => sherpaStructuredJsonPayload(payload, completionModel)
    : undefined;
  const response = await completeWithAbortableTimeout(model, state.retrievalPrompt, [message], auth, ctx.signal, timeoutMs, timeoutMessage, onPayload);
  if (response.stopReason === "aborted") return { aborted: true, parsed: null };
  const toolJson = structuredOutput === "tool_json_schema" ? extractToolJsonObject(response) : null;
  if (toolJson) return { aborted: false, parsed: toolJson };
  const text = response.content.filter((c: any): c is { type: "text"; text: string } => c.type === "text").map((c: any) => c.text).join("\\n");
  return { aborted: false, parsed: extractJsonObject(text) };
}

export async function llmSummarize(ctx: ExtensionContext, state: SummarizeStateLike, raw: string, budgetChars = 1200): Promise<string> {
  if (state.config.model.heuristicOnly) return summarize(raw, budgetChars);
  if (!state.config.privacy.allowRemoteModel && !state.config.model.useMainPiModel) return summarize(raw, budgetChars);
  const model = state.config.model.useMainPiModel ? ctx.model : ctx.modelRegistry.find(state.config.model.provider, state.config.model.id);
  if (!model) {
    if (state.config.model.fallbackToHeuristics) return summarize(raw, budgetChars);
    throw new Error(`Sherpa model not found: ${state.config.model.provider}/${state.config.model.id}`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    if (state.config.model.fallbackToHeuristics) return summarize(raw, budgetChars);
    throw new Error((auth as any).error ?? `Auth failed for ${model.provider}`);
  }
  if (!auth.apiKey) {
    if (state.config.model.fallbackToHeuristics) return summarize(raw, budgetChars);
    throw new Error(`No API key for ${model.provider}`);
  }
  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: raw.slice(0, 24000) }],
    timestamp: Date.now(),
  };
  const response = await completeWithAbortableTimeout(
    model,
    `${state.distillPrompt}\n\nTask: Summarize this coding-agent context/tool output for the main coding agent. Maximum ${budgetChars} characters. Preserve actionable facts, failures, commands, paths, and next steps. Do not include secrets or raw noisy output.`,
    [message],
    auth,
    ctx.signal,
    10_000,
    "llmSummarize timed out",
  );
  if (response.stopReason === "aborted") return summarize(raw, budgetChars);
  const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();
  return text ? (text.length > budgetChars ? text.slice(0, budgetChars - 1) + "…" : text) : summarize(raw, budgetChars);
}
