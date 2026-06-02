#!/usr/bin/env bun
/**
 * @sherpa-purpose Run Pi Sherpa extension tests and bundle check
 * @sherpa-timeout 180000
 * @sherpa-side-effects none
 * @sherpa-safe true
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sherpaDir = path.resolve(__dirname, "..");
function run(command: string[], cwd = sherpaDir) {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

if (!existsSync(sherpaDir)) {
  throw new Error(`Sherpa extension directory not found: ${sherpaDir}`);
}

const testsDir = path.join(sherpaDir, "tests");
if (!existsSync(testsDir)) {
  throw new Error(`Sherpa extension tests directory not found: ${testsDir}`);
}

const tests = readdirSync(testsDir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort();

for (const test of tests) {
  const testPath = path.join(testsDir, test);
  console.log(`\n▶ ${test}`);
  run(["bun", testPath]);
}

console.log("\n▶ bundle check");
run([
  "bun",
  "build",
  path.join(sherpaDir, "index.ts"),
  "--target=node",
  "--format=esm",
  "--external=@mariozechner/pi-ai",
  "--external=@mariozechner/pi-coding-agent",
  "--external=typebox",
  "--outfile=/tmp/pi-sherpa-check.mjs",
]);

console.log("\n✅ Pi Sherpa extension checks passed");
