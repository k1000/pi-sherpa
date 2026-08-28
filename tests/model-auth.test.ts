import assert from "node:assert/strict";

import { clearSherpaModelFallback, notifySherpaModelFallback } from "../lib/model-auth";

const notifications: Array<{ message: string; level: string }> = [];
const statuses: Array<{ key: string; value: string | undefined }> = [];
const ctx = {
  hasUI: true,
  ui: {
    notify(message: string, level: string) { notifications.push({ message, level }); },
    setStatus(key: string, value: string | undefined) { statuses.push({ key, value }); },
  },
} as any;

notifySherpaModelFallback(ctx, "model not found: local/sherpa");
assert.deepEqual(notifications, [{
  message: "Sherpa MODEL FAILURE — heuristic fallback active: model not found: local/sherpa",
  level: "error",
}]);
assert.deepEqual(statuses, [{
  key: "ai-sherpa-model",
  value: "Sherpa model OFFLINE — heuristic fallback active",
}]);

clearSherpaModelFallback(ctx);
assert.deepEqual(statuses.at(-1), { key: "ai-sherpa-model", value: undefined });

console.log("model-auth tests passed=3");
