import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { extractJsonObject } from "./json-utils";

/** Sidecar model completion helpers with timeout and JSON-object parsing. */

type RetrievalPromptStateLike = { retrievalPrompt: string };

export function timeoutAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
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
  const response = await Promise.race([
    complete(model, { systemPrompt: state.retrievalPrompt, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal }),
    timeoutAfter<any>(timeoutMs, timeoutMessage),
  ]);
  if (response.stopReason === "aborted") return { aborted: true, parsed: null };
  const text = response.content.filter((c: any): c is { type: "text"; text: string } => c.type === "text").map((c: any) => c.text).join("\\n");
  return { aborted: false, parsed: extractJsonObject(text) };
}
