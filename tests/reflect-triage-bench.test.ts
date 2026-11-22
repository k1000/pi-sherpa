#!/usr/bin/env bun
import assert from "node:assert/strict";
import path from "node:path";

const script = path.join(import.meta.dir, "../bench/reflect-triage-bench.py");
const result = Bun.spawnSync(["python3", script, "--self-test"], {
  env: { ...process.env, JEV_API_KEY: "", LAYA_MODEL_PATH: "" },
  stdout: "pipe", stderr: "pipe",
});
assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
assert.match(new TextDecoder().decode(result.stdout), /fixture, privacy checksum, split and scoring checks passed/);
console.log("Reflection triage benchmark self-test passed");
