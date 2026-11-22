import assert from "node:assert/strict";

import { clearSherpaModelFallback, isTransientSherpaModelFailure, notifySherpaModelFallback } from "../lib/model-auth";

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

assert.equal(isTransientSherpaModelFailure("source planner error: Request timed out."), true);
assert.equal(isTransientSherpaModelFailure("model not found: local/sherpa"), false);
notifySherpaModelFallback(ctx, "source planner error: Request timed out.");
assert.equal(notifications.length, 1, "a transient planner timeout must not show a MODEL FAILURE alert");
assert.deepEqual(statuses.at(-1), {
  key: "ai-sherpa-model",
  value: "Sherpa model temporarily unavailable — heuristic fallback active",
});

console.log("model-auth tests passed=6");
