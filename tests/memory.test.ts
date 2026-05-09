/**
 * Sherpa memory backend tests.
 * Run with: tsx tests/memory.test.ts
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recallMemory, syncReflectMemory } from "../lib/memory";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

async function withDirs(fn: (paths: { root: string; repo: string; extensionMemory: string; vault: string; obsidianMemory: string }) => Promise<void> | void) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-memory-"));
  const repo = path.join(root, "repo");
  const extensionMemory = path.join(root, "extension-memory");
  const vault = path.join(root, "vault");
  const obsidianMemory = path.join(vault, "projects", "Repo");
  mkdirSync(path.join(repo, ".pi", "reflect"), { recursive: true });
  mkdirSync(path.join(extensionMemory, ".l2_facts"), { recursive: true });
  try {
    await fn({ root, repo, extensionMemory, vault, obsidianMemory });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("syncReflectMemory writes high-value reflection to Obsidian", async () => withDirs(async ({ repo, extensionMemory, vault, obsidianMemory }) => {
  const indexPath = path.join(repo, ".pi", "reflect", "index.jsonl");
  writeFileSync(indexPath, JSON.stringify({
    id: "ref-1",
    type: "knowledge",
    title: "Workers must preserve idempotent queue completion",
    summary: "Worker queues must never mark rows completed when production side effects fail.",
    importance: "high",
    tags: ["workers", "idempotent"],
    createdAt: "2026-05-07T00:00:00.000Z",
  }) + "\n");

  const result = await syncReflectMemory({ cwd: repo, extensionMemoryDir: extensionMemory, obsidianVault: vault, obsidianMemoryPath: obsidianMemory }, { refId: "ref-1" });
  assert(result.includes("1 synced"), "should sync one reflection");
  const conceptDir = path.join(obsidianMemory, "wiki", "concepts");
  const files = existsSync(conceptDir) ? readdirSync(conceptDir).filter((name) => name.endsWith(".md")) : [];
  assert(files.length === 1, `expected one obsidian concept note, got ${files.length} [${files.join(", ")}]; result was:\n${result}`);
  const target = path.join(conceptDir, files[0]!);
  assert(readFileSync(target, "utf8").includes("never mark rows completed"), "expected reflection body");
}));

test("syncReflectMemory defaults medium durable reflections to Obsidian", async () => withDirs(async ({ repo, extensionMemory, vault, obsidianMemory }) => {
  writeFileSync(path.join(repo, ".pi", "reflect", "index.jsonl"), JSON.stringify({
    id: "ref-medium",
    type: "knowledge",
    title: "Medium durable reflection",
    summary: "Medium durable knowledge should still route to Obsidian project memory by default.",
    importance: "medium",
    tags: ["sherpa", "routing"],
  }) + "\n");

  const result = await syncReflectMemory({ cwd: repo, extensionMemoryDir: extensionMemory, obsidianVault: vault, obsidianMemoryPath: obsidianMemory }, { refId: "ref-medium" });
  assert(result.includes("1 synced"), "should sync medium reflection");
  assert(existsSync(path.join(obsidianMemory, "wiki", "concepts", "medium-durable-reflection.md")), "medium durable reflection should go to Obsidian concepts");
  assert(!existsSync(path.join(repo, ".pi-memory", ".l2_facts", "medium-durable-reflection.md")), "should not write medium durable reflection to repo .pi-memory by default");
}));

test("recallMemory finds Obsidian and extension memory", () => withDirs(({ repo, extensionMemory, vault, obsidianMemory }) => {
  mkdirSync(path.join(obsidianMemory, "wiki", "concepts"), { recursive: true });
  writeFileSync(path.join(obsidianMemory, "wiki", "concepts", "worker-idempotency.md"), "# Worker idempotency\nQueues must be idempotent.");
  writeFileSync(path.join(extensionMemory, ".l2_facts", "global-worker.md"), "# Global worker fact\nWorker retries should be safe.");

  const result = recallMemory({ cwd: repo, extensionMemoryDir: extensionMemory, obsidianVault: vault, obsidianMemoryPath: obsidianMemory }, "worker idempotent retries");
  assert(result.includes("worker-idempotency.md"), "should include obsidian memory");
  assert(result.includes("global-worker.md"), "should include extension memory");
}));

test("syncReflectMemory dry-run does not write notes", async () => withDirs(async ({ repo, extensionMemory, vault, obsidianMemory }) => {
  writeFileSync(path.join(repo, ".pi", "reflect", "index.jsonl"), JSON.stringify({
    id: "ref-2",
    type: "pattern",
    title: "Dry run reflection",
    summary: "Dry run should not write durable notes.",
    importance: "high",
    tags: ["test"],
  }) + "\n");

  const result = await syncReflectMemory({ cwd: repo, extensionMemoryDir: extensionMemory, obsidianVault: vault, obsidianMemoryPath: obsidianMemory }, { dryRun: true });
  assert(result.includes("dry-run"), "should report dry run");
  assert(!existsSync(path.join(obsidianMemory, "wiki", "procedures", "dry-run-reflection.md")), "should not write in dry run");
}));

async function main() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`✅ ${name}`);
    } catch (error) {
      failed++;
      console.error(`❌ ${name}`);
      console.error(error);
    }
  }

  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
