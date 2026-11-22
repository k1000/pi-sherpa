import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import sherpa from "../index";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) { tests.push({ name, fn }); }

async function withHarness(fn: (run: (name: string, event: Record<string, unknown>) => Promise<unknown>, cwd: string) => Promise<void>) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "sherpa-before-agent-start-"));
  const handlers = new Map<string, Handler>();
  sherpa({
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerCommand() {},
    registerTool() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getEntries: () => [] },
    ui: { notify() { assert.fail("no notification expected"); } },
  } as unknown as ExtensionContext;
  try {
    await fn(async (name, event) => {
      const handler = handlers.get(name);
      assert.ok(handler, `missing ${name} handler`);
      return await handler(event, ctx);
    }, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writeConfig(cwd: string, enabled: boolean) {
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "sherpa.config.json"), JSON.stringify({
    enabled,
    mode: "auto",
    frontDoor: { enabled: true },
    debug: { timing: { enabled: true, logPath: "timing.jsonl", thresholdMs: 0 } },
  }));
}

const customEvent = {
  type: "before_agent_start",
  messageType: "custom",
  message: { role: "custom", customType: "sherpa-context", content: "Retrieved context", display: true, timestamp: 0 },
  systemPrompt: "System prompt",
};

test("custom-message turns do not require a user prompt before session initialization", () => withHarness(async (run) => {
  assert.equal(await run("before_agent_start", customEvent), undefined);
}));

for (const enabled of [false, true]) {
  test(`custom-message turns bypass retrieval and timing with enabled=${enabled}`, () => withHarness(async (run, cwd) => {
    // Initialize disabled to avoid unrelated startup filesystem maintenance.
    writeConfig(cwd, false);
    await run("session_start", { type: "session_start", reason: "startup" });
    writeConfig(cwd, enabled);
    const before = readFileSync(path.join(cwd, "timing.jsonl"), "utf8");
    assert.equal(await run("before_agent_start", customEvent), undefined);
    assert.equal(readFileSync(path.join(cwd, "timing.jsonl"), "utf8"), before);
  }));
}

test("user prompts retain trivial/slash handling and timing", () => withHarness(async (run, cwd) => {
  writeConfig(cwd, false);
  await run("session_start", { type: "session_start", reason: "startup" });
  writeConfig(cwd, true);
  for (const prompt of ["hello", "/compact"]) {
    assert.equal(await run("before_agent_start", { type: "before_agent_start", messageType: "user", prompt }), undefined);
  }
  const records = readFileSync(path.join(cwd, "timing.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.filter((r) => r.action === "before_agent_start.frontDoor.total").map((r) => [r.focus, r.outcome]), [
    ["hello", "trivial"],
    ["/compact", "slash-command"],
  ]);
}));

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`, error); }
}
console.log(`Results: ${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
