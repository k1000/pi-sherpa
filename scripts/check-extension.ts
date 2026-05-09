#!/usr/bin/env -S pnpm exec tsx
/**
 * @sherpa-purpose Run Pi Sherpa extension tests and bundle check
 * @sherpa-timeout 180000
 * @sherpa-side-effects none
 * @sherpa-safe true
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sherpaDir = path.resolve(__dirname, "..");
const invocationCwd = process.cwd();

function findBin(name: string): string {
  const candidates: string[] = [];
  for (const start of [invocationCwd, sherpaDir]) {
    let current = start;
    while (true) {
      candidates.push(path.join(current, "node_modules", ".bin", name));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  candidates.push(path.join("/Users/kamil/Library/pnpm", name));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find ${name}. Run from a project with dependencies installed, or install ${name} globally.`);
  }
  return found;
}

const tsxBin = findBin("tsx");
const esbuildBin = findBin("esbuild");

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
  execFileSync(tsxBin, [testPath], { cwd: sherpaDir, stdio: "inherit" });
}

console.log("\n▶ bundle check");
execFileSync(esbuildBin, [
  path.join(sherpaDir, "index.ts"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--external:@mariozechner/pi-ai",
  "--external:@mariozechner/pi-coding-agent",
  "--external:typebox",
  "--outfile=/tmp/pi-sherpa-check.mjs",
], { cwd: sherpaDir, stdio: "inherit" });

console.log("\n✅ Pi Sherpa extension checks passed");
