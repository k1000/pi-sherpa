/**
 * Sherpa auto-memory tests.
 * Run with: tsx tests/auto-memory.test.ts
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
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

test("extractAutoMemoryCandidates keeps structural rules and ignores noise", () => {
  const candidates = extractAutoMemoryCandidates(`
    ✓ test passed
    Always use migrations for production schema changes because db:push bypasses tracking.
    tiny
    RUN v2.1.9
    caps.id must remain text not uuid in ClearStack worker code.
  `);
  assert(candidates.length === 2, `expected 2 candidates, got ${candidates.length}`);
  assert(candidates[0]!.includes("Always use migrations"), "missing migration candidate");
  assert(candidates[1]!.includes("caps.id"), "missing caps.id candidate");
});

test("stringifyForAutoMemory truncates large values safely", () => {
  const text = stringifyForAutoMemory({ value: "x".repeat(2000) }, 200);
  assert(text.length === 200, "should truncate to max");
});

test("writeAutoMemoryArtifact writes Obsidian memory and project scratchpad candidate", () => withDirs((repo, vault, memory, scratch) => {
  const state = createAutoMemoryState();
  const result = writeAutoMemoryArtifact(state, {
    cwd: repo,
    obsidianVault: vault,
    obsidianMemoryPath: memory,
    appendScratchpadCandidate: (text) => scratch.push(text),
  }, "agent_end", "Workers must preserve idempotent queue completion semantics and never falsely complete failed side effects.");

  assert(result.written, "should write artifact");
  assert(result.candidates.length === 1, "should extract candidate");
  assert(scratch.length === 1, "should write scratchpad candidate");
  assert(existsSync(path.join(memory, "journal")), "should create journal dir");
  assert(existsSync(path.join(memory, "inbox")), "should create inbox dir");
  const journalText = readFileSync(path.join(memory, "journal", new Date().toISOString().slice(0, 10) + ".md"), "utf8");
  assert(journalText.includes("idempotent queue"), "journal should contain candidate");

  const duplicate = writeAutoMemoryArtifact(state, {
    cwd: repo,
    obsidianVault: vault,
    obsidianMemoryPath: memory,
    appendScratchpadCandidate: (text) => scratch.push(text),
  }, "agent_end", "Workers must preserve idempotent queue completion semantics and never falsely complete failed side effects.");
  assert(!duplicate.written, "duplicate hash should not rewrite");
}));

test("writeAutoMemoryArtifact proves lifecycle session distillation for agent, compact, and shutdown", () => withDirs((repo, vault, memory, scratch) => {
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

  assert(agent.written && compact.written && shutdown.written, "all lifecycle events should write");
  assert(scratch.length === 3, "each lifecycle event should emit a scratchpad candidate");

  const inboxFiles = readdirSync(path.join(memory, "inbox")).filter((file) => file.endsWith(".md"));
  assert(inboxFiles.length === 3, `expected 3 inbox candidate files, got ${inboxFiles.length}`);

  const journalFile = path.join(memory, "journal", new Date().toISOString().slice(0, 10) + ".md");
  const journalText = readFileSync(journalFile, "utf8");
  assert(journalText.includes("agent_end"), "journal should include agent_end reason");
  assert(journalText.includes("session_compact"), "journal should include session_compact reason");
  assert(journalText.includes("session_shutdown:exit"), "journal should include session_shutdown reason");
  assert(journalText.includes("Candidate learnings"), "journal should include candidate learnings");
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
