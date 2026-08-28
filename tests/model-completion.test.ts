import assert from "node:assert/strict";

import { extractToolJsonObject, sherpaStructuredJsonPayload, usesSherpaToolJsonSchema } from "../lib/model-completion";

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
  usesSherpaToolJsonSchema({ provider: "zai", id: "glm-5.3-flash" }),
  false,
  "uses text JSON rather than empty forced GLM tool calls",
);
assert.equal(
  (sherpaStructuredJsonPayload({ model: "test" }, { provider: "zai", id: "glm-5.3-flash" }) as any).enable_thinking,
  undefined,
  "does not disable mandatory GLM thinking",
);
assert.equal(
  (sherpaStructuredJsonPayload({ model: "test" }, { provider: "olmx", id: "Qwen3" }) as any).enable_thinking,
  false,
  "disables thinking for Qwen structured tool calls",
);

console.log("model-completion tests passed=7");
