import assert from "node:assert/strict";
import { extractJsonArray, extractJsonObject } from "../lib/json-utils";

assert.deepEqual(extractJsonObject('{"selected":[0]}'), { selected: [0] }, "parses a bare object");
assert.deepEqual(extractJsonObject('Result: {"selected":[0]}'), { selected: [0] }, "parses an object after prose");
assert.deepEqual(
  extractJsonObject('I will return {"example":true}.\n```json\n{"selected":[2],"reason":"final result"}\n```'),
  { selected: [2], reason: "final result" },
  "uses the final valid JSON object when model prose includes an earlier object",
);
assert.deepEqual(
  extractJsonObject('<think>{"scratch":"not the answer"}</think>\n{"selected":[1]}'),
  { selected: [1] },
  "ignores JSON-shaped model reasoning before the final result",
);
assert.deepEqual(
  extractJsonObject('{"reason":"braces { inside a string } are valid","selected":[0]}'),
  { reason: "braces { inside a string } are valid", selected: [0] },
  "handles braces inside JSON strings",
);
assert.deepEqual(
  extractJsonObject('{"items":[{"index":0}]}'),
  { items: [{ index: 0 }] },
  "keeps the outer object when it contains nested objects",
);
assert.equal(extractJsonObject('no object here'), null, "returns null without an object");
assert.deepEqual(extractJsonArray('```json\n[1, 2]\n```'), [1, 2], "keeps array extraction behavior");

console.log("json-utils tests passed=8");
