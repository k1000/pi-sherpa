/**
 * End-to-end Sherpa distillation experiment test.
 * Run with: tsx tests/distillation-experiment.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutoMemoryState, writeAutoMemoryArtifact } from "../lib/auto-memory";
import { writeDistilledSkill } from "../lib/distillation";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function withExperiment(fn: (paths: { root: string; repo: string; vault: string; memory: string; scratch: string[] }) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-distillation-e2e-"));
  const paths = { root, repo: path.join(root, "repo"), vault: path.join(root, "vault"), memory: path.join(root, "vault", "projects", "Demo"), scratch: [] as string[] };
  try { fn(paths); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("explicit task, automation, and session distillation all produce durable Obsidian evidence", () => withExperiment(({ repo, vault, memory, scratch }) => {
  const task = writeDistilledSkill({
    trigger: "pattern",
    task: "Task-level distillation proof",
    outcome: "Task-level distillation should create an Obsidian project skill artifact with a durable lesson.",
    domain: "typescript",
  }, repo, memory);

  const automation = writeDistilledSkill({
    trigger: "success",
    task: "Automation-level distillation proof",
    outcome: "Automation-level distillation should preserve reusable workflow rules in Obsidian project memory.",
    domain: "typescript",
  }, repo, memory);

  const state = createAutoMemoryState();
  const config = { cwd: repo, obsidianVault: vault, obsidianMemoryPath: memory, appendScratchpadCandidate: (text: string) => scratch.push(text) };
  const agent = writeAutoMemoryArtifact(state, config, "agent_end", "Pattern: agent-end session distillation must preserve durable structural lessons in Obsidian project memory.");
  const compact = writeAutoMemoryArtifact(state, config, "session_compact", "Invariant: session compact distillation should record structural continuity without raw context dumps.");
  const shutdown = writeAutoMemoryArtifact(state, config, "session_shutdown:exit", "Rule: shutdown distillation should keep only durable structural lessons and avoid transient logs.");

  assert(existsSync(task.skillPath), "task skill missing");
  assert(existsSync(automation.skillPath), "automation skill missing");
  assert(task.skillPath.startsWith(path.join(memory, "wiki", "procedures")), "task procedure should be in Obsidian semantic wiki");
  assert(automation.skillPath.startsWith(path.join(memory, "wiki", "procedures")), "automation procedure should be in Obsidian semantic wiki");
  assert(!task.skillPath.includes(".pi-memory") && !automation.skillPath.includes(".pi-memory"), "explicit distillation should not use .pi-memory by default");

  assert(agent.written && compact.written && shutdown.written, "session lifecycle distillation should write all events");
  assert(readdirSync(path.join(memory, "inbox")).length === 3, "session distillation should create three inbox candidate artifacts");
  assert(scratch.length === 3, "session distillation should emit three scratchpad candidates");

  const journalText = readFileSync(path.join(memory, "journal", new Date().toISOString().slice(0, 10) + ".md"), "utf8");
  assert(journalText.includes("agent_end"), "journal proof missing agent_end");
  assert(journalText.includes("session_compact"), "journal proof missing session_compact");
  assert(journalText.includes("session_shutdown:exit"), "journal proof missing shutdown");
}));

for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
