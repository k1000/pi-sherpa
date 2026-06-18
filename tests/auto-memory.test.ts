/**
 * Sherpa auto-memory tests.
 * Run with: tsx tests/auto-memory.test.ts
 */

import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutoMemoryState, extractAutoMemoryCandidates, stringifyForAutoMemory, writeAutoMemoryArtifact } from "../lib/auto-memory";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

function withDirs(fn: (repo: string, vault: string, memory: string, scratch: string[]) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-auto-memory-"));
  const repo = path.join(root, "repo");
  const vault = path.join(root, "vault");
  const memory = path.join(vault, "projects", "Repo");
  const scratch: string[] = [];
  try {
    fn(repo, vault, memory, scratch);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("extractAutoMemoryCandidates is deprecated and ignores raw session text", () => {
  const candidates = extractAutoMemoryCandidates(`
    ✓ test passed
    Always use migrations for production schema changes because db:push bypasses tracking.
    tiny
    RUN v2.1.9
    caps.id must remain text not uuid in ClearStack worker code.
  `);
  assert(candidates.length === 0, `expected no candidates, got ${candidates.length}`);
});

test("stringifyForAutoMemory truncates large values safely", () => {
  const text = stringifyForAutoMemory({ value: "x".repeat(2000) }, 200);
  assert(text.length === 200, "should truncate to max");
});

test("writeAutoMemoryArtifact no longer writes regex-extracted candidates", () => withDirs((repo, vault, memory, scratch) => {
  const state = createAutoMemoryState();
  const result = writeAutoMemoryArtifact(state, {
    cwd: repo,
    obsidianVault: vault,
    obsidianMemoryPath: memory,
    appendScratchpadCandidate: (text) => scratch.push(text),
  }, "agent_end", "Workers must preserve idempotent queue completion semantics and never falsely complete failed side effects.");

  assert(!result.written, "deprecated extractor should not write artifacts");
  assert(result.candidates.length === 0, "should not extract regex candidates");
  assert(scratch.length === 0, "should not write scratchpad candidate");
  assert(existsSync(path.join(memory, "journal")), "should create journal dir");
  assert(existsSync(path.join(memory, "inbox")), "should create inbox dir");

  const duplicate = writeAutoMemoryArtifact(state, {
    cwd: repo,
    obsidianVault: vault,
    obsidianMemoryPath: memory,
    appendScratchpadCandidate: (text) => scratch.push(text),
  }, "agent_end", "Workers must preserve idempotent queue completion semantics and never falsely complete failed side effects.");
  assert(!duplicate.written, "duplicate hash should not rewrite");
}));

test("writeAutoMemoryArtifact tracks lifecycle hashes without raw regex distillation", () => withDirs((repo, vault, memory, scratch) => {
  const state = createAutoMemoryState();
  const config = {
    cwd: repo,
    obsidianVault: vault,
    obsidianMemoryPath: memory,
    appendScratchpadCandidate: (text: string) => scratch.push(text),
  };

  const agent = writeAutoMemoryArtifact(state, config, "agent_end", "Pattern: Sherpa must preserve durable task lessons in Obsidian project memory and keep scratchpad entries ephemeral.");
  const compact = writeAutoMemoryArtifact(state, config, "session_compact", "Invariant: session compaction should extract structural memory candidates without dumping raw context into the main session.");
  const shutdown = writeAutoMemoryArtifact(state, config, "session_shutdown:exit", "Rule: session shutdown should persist only durable structural lessons and should ignore one-off raw logs.");

  assert(!agent.written && !compact.written && !shutdown.written, "deprecated regex extractor should not write lifecycle artifacts");
  assert(state.writtenHashes.length === 3, "each lifecycle event should still be deduped by hash");
  assert(scratch.length === 0, "lifecycle events should not emit scratchpad candidates");

  const inboxFiles = readdirSync(path.join(memory, "inbox")).filter((file) => file.endsWith(".md"));
  assert(inboxFiles.length === 0, `expected no inbox candidate files, got ${inboxFiles.length}`);
}));

for (const { name, fn } of tests) {
  try {
    fn();
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
