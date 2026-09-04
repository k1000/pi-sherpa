import assert from "node:assert/strict";

import { completionErrorMessage, extractToolJsonObject, parseJsonCompletionResponse, sherpaStructuredJsonPayload, usesSherpaToolJsonSchema } from "../lib/model-completion";

assert.deepEqual(
  extractToolJsonObject({
    content: [{ type: "toolCall", name: "emit_sherpa_json", arguments: { indicators: ["sourcePlanningMessage"] } }],
  }),
  { indicators: ["sourcePlanningMessage"] },
  "uses parsed structured-tool arguments",
);
assert.deepEqual(
  extractToolJsonObject({
    content: [{ type: "toolCall", name: "emit_sherpa_json", arguments: '{"items":[{"index":0}]}' }],
  }),
  { items: [{ index: 0 }] },
  "parses providers that serialize structured-tool arguments as JSON text",
);
assert.equal(
  extractToolJsonObject({
    content: [{ type: "toolCall", name: "emit_sherpa_json", arguments: "not JSON" }],
  }),
  null,
  "rejects malformed structured-tool arguments",
);
assert.equal(
  extractToolJsonObject({ content: [{ type: "toolCall", name: "other_tool", arguments: { items: [] } }] }),
  null,
  "ignores a different tool call",
);
assert.equal(
  extractToolJsonObject({ content: [{ type: "toolCall", name: "emit_sherpa_json", arguments: {} }] }),
  null,
  "falls through when a provider returns empty tool arguments",
);
assert.deepEqual(
  parseJsonCompletionResponse({ content: [{ type: "text", text: 'Result: {"sources":{"sources":["files"]}}' }] }, undefined),
  { sources: { sources: ["files"] } },
  "uses the JSON-only text contract when structured output is disabled",
);
assert.deepEqual(
  parseJsonCompletionResponse({ content: '{"sources":{"sources":["files"]}}' }, undefined),
  { sources: { sources: ["files"] } },
  "accepts OpenAI-compatible string content",
);
assert.deepEqual(
  parseJsonCompletionResponse({ content: [{ type: "text", text: '{"items":[{"index":0}]}' }] }, "tool_json_schema"),
  { items: [{ index: 0 }] },
  "falls through to JSON text when a structured-output model does not return a tool call",
);
assert.equal(
  parseJsonCompletionResponse({ content: [{ type: "text", text: "not JSON" }] }, undefined),
  null,
  "returns null for malformed JSON so callers can use deterministic fallback",
);
assert.deepEqual(
  parseJsonCompletionResponse({
    content: [
      { type: "toolCall", name: "emit_sherpa_json", arguments: {} },
      { type: "text", text: '{"sources":{"sources":["files"]}}' },
    ],
  }, "tool_json_schema"),
  { sources: { sources: ["files"] } },
  "uses text JSON when a provider returned empty tool arguments",
);
assert.deepEqual(
  parseJsonCompletionResponse({
    content: [
      { type: "text", text: '{"sources":{"sources":["files"],"reason":"' },
      { type: "text", text: 'split response","confidence":0.9}}' },
    ],
  }, undefined),
  { sources: { sources: ["files"], reason: "split response", confidence: 0.9 } },
  "parses JSON split across text content parts",
);
assert.equal(
  completionErrorMessage({ stopReason: "error", errorMessage: "429 quota exhausted" }),
  "429 quota exhausted",
  "preserves provider failures instead of treating them as invalid JSON",
);
assert.equal(
  completionErrorMessage({ stopReason: "error" }),
  "Sherpa model returned an error response",
  "supplies a useful fallback for provider errors without a message",
);
assert.equal(
  usesSherpaToolJsonSchema({ provider: "zai", id: "glm-5.3-flash", api: "openai-completions" }),
  false,
  "uses text JSON rather than empty forced GLM tool calls",
);
assert.equal(
  usesSherpaToolJsonSchema({ provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses" }),
  false,
  "does not force Chat-Completions tools for Responses models",
);
assert.equal(
  usesSherpaToolJsonSchema({ provider: "olmx", id: "Qwen3", api: "openai-completions" }),
  false,
  "uses text JSON for oMLX after forced tools returned unusable payloads",
);
assert.equal(
  usesSherpaToolJsonSchema({ provider: "qwen", id: "qwen3.8-flash", api: "openai-completions" }),
  false,
  "uses Qwen's reliable text JSON contract instead of incomplete forced-tool arguments",
);
assert.deepEqual(
  sherpaStructuredJsonPayload({ model: "test" }, { provider: "qwen", id: "qwen3.8-flash", api: "openai-completions" }),
  { model: "test", enable_thinking: false, response_format: { type: "json_object" } },
  "uses Qwen JSON mode without forced tools or thinking",
);
assert.deepEqual(
  sherpaStructuredJsonPayload({ model: "test" }, { provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses" }),
  { model: "test" },
  "leaves a Responses payload free of Chat-Completions tools",
);
const chatCompletionsPayload = sherpaStructuredJsonPayload(
  { model: "test" },
  { provider: "openai", id: "gpt-test", api: "openai-completions" },
) as any;
assert.equal(chatCompletionsPayload.enable_thinking, false, "disables thinking for supported Chat-Completions tool calls");
assert.equal(chatCompletionsPayload.tool_choice.function.name, "emit_sherpa_json", "forces the JSON tool only for supported Chat-Completions models");

console.log("model-completion tests passed=22");
