import assert from "node:assert/strict";
import { retrievalTimeoutMs, withRetrievalBatch, withRetrievalTimeout } from "../index";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

async function silenceWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  try {
    console.warn = () => undefined;
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

test("retrievalTimeoutMs uses shorter front-door budget", () => {
  assert.equal(retrievalTimeoutMs("front-door"), 6000);
  assert.equal(retrievalTimeoutMs("explicit"), 12000);
  assert.equal(retrievalTimeoutMs("proactive"), 12000);
});

test("withRetrievalTimeout returns fast source results", async () => {
  const result = await withRetrievalTimeout("fast-source", Promise.resolve("ok"), 50);
  assert.equal(result, "ok");
});

test("withRetrievalTimeout skips timed-out source", async () => {
  const startedAt = Date.now();
  const result = await silenceWarnings(() => withRetrievalTimeout("slow-source", new Promise<string>(() => undefined), 15));
  assert.equal(result, undefined);
  assert.ok(Date.now() - startedAt < 250, "timeout guard should return promptly");
});

test("withRetrievalTimeout skips failed source", async () => {
  const result = await silenceWarnings(() => withRetrievalTimeout("failed-source", Promise.reject(new Error("boom")), 50));
  assert.equal(result, undefined);
});

test("source searches start concurrently and return separate batches to combine", async () => {
  let started = 0;
  let signalBothStarted!: () => void;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { signalBothStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const search = (name: string) => withRetrievalBatch(name, async (add) => {
    if (++started === 2) signalBothStarted();
    await gate;
    add("file", name, name);
  }, 500);
  const first = search("repo");
  const second = search("oracle-inquirer");
  try {
    await Promise.race([bothStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sources did not start concurrently")), 200))]);
  } finally {
    release();
  }
  assert.deepEqual(await Promise.all([first, second]), [
    [["file", "repo", "repo"]],
    [["file", "oracle-inquirer", "oracle-inquirer"]],
  ]);
});

test("timed-out sources cannot add to the combined candidate batch later", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const result = await silenceWarnings(() => withRetrievalBatch("slow-source", async (add) => {
    await gate;
    add("file", "late", "late");
  }, 15));
  assert.deepEqual(result, []);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(result, [], "a timed-out source must not mutate the batch that gets merged");
});

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
