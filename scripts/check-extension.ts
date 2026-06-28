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

function checkNoUnresolvedTypeScriptSymbols() {
  const result = Bun.spawnSync(["tsc", "-p", "tsconfig.check.json", "--pretty", "false"], { cwd: sherpaDir, stdout: "pipe", stderr: "pipe" });
  const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
  const fatal = output.split(/\r?\n/).filter((line) => /error TS(2304|2305|2307|2552):/.test(line));
  if (fatal.length) {
    console.error("\n❌ TypeScript unresolved-symbol guard failed");
    console.error(fatal.join("\n"));
    process.exit(1);
  }
  if (result.exitCode !== 0) {
    console.log("\nℹ TypeScript unresolved-symbol guard passed (broader type errors are currently non-gating).");
  } else {
    console.log("\n✅ TypeScript unresolved-symbol guard passed");
  }
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

console.log("\n▶ unresolved-symbol guard");
checkNoUnresolvedTypeScriptSymbols();

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
