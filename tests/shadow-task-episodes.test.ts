import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneShadowTaskEpisodes, writeShadowTaskEpisode } from "../lib/shadow-task-episodes";
import type { ContextBundleRecord, ContextEvaluation } from "../lib/evaluation";

const tests: Array<{ name: string; run: () => void }> = [];
const test = (name: string, run: () => void) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const withTemp = (run: (root: string) => void) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-shadow-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const now = new Date("2026-09-29T12:00:00.000Z");
const bundle: ContextBundleRecord = {
  bundleId: "bundle-shadow-test", timestamp: now.getTime(), mode: "automatic",
  focus: "Fix JEV_API_KEY=verysecretvalue user@example.com https://private.example/foo lead 826399000006 in /Users/kamil/work/app.ts Bearer hiddenBearerValue -----BEGIN PRIVATE KEY----- keymaterial",
  items: [{ handle: "ctx-1", type: "file_snippet", source: "repo:///Users/kamil/work/app.ts", summary: "must never persist raw snippet" }],
};
const evaluation: ContextEvaluation = {
  bundleId: bundle.bundleId, taskOutcome: "completed", scores: { relevance: 0.2, precision: 0.3, recall: 0.1 },
  noise: [], missed: ["src/app.ts"], reflection: "raw private final answer", improvementHint: "auto generated suggestion",
  evaluatedAt: now.toISOString(),
};
const input = { bundle, evaluation, cwd: "/Users/kamil/work", files: {
  readFiles: ["src/app.ts"], writtenFiles: ["src/server.ts"], referencedFiles: ["src/app.ts"], changedFiles: ["unrelated.txt"],
}, now };

test("writes only redacted bounded metadata in a private card", () => withTemp((root) => {
  assert(writeShadowTaskEpisode({ ...input, root }), "should write an episode");
  const names = readdirSync(root);
  assert(names.length === 1, "one card expected");
  const saved = readFileSync(path.join(root, names[0]), "utf8");
  const card = JSON.parse(saved);
  assert(card.schema === "sherpa-shadow-task-episode-v1", "schema recorded");
  assert(card.review.decision === null && card.review.protected === null, "no fabricated human label");
  assert(card.evidence.readFiles[0] === "src/app.ts", "tool-observed file preserved");
  assert(card.evidence.gitDirtySnapshot[0] === "unrelated.txt", "dirty snapshot distinct from read files");
  for (const secret of ["verysecretvalue", "hiddenBearerValue", "keymaterial", "user@example.com", "private.example", "826399000006", "/Users/kamil", "must never persist raw snippet", "raw private final answer", "auto generated suggestion"]) {
    assert(!saved.includes(secret), `private value leaked: ${secret}`);
  }
  assert((statSync(root).mode & 0o777) === 0o700, "private directory");
  assert((statSync(path.join(root, names[0])).mode & 0o777) === 0o600, "private file");
}));

test("records test exit evidence without saving commands or tool output", () => withTemp((root) => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "check-1", name: "bash", arguments: { command: "bun test tests/secret-customer-123.ts" } }] },
    { role: "toolResult", toolCallId: "check-1", content: [{ type: "text", text: "private customer output [Exit code: 0]" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "other-1", name: "bash", arguments: { command: "curl https://secret.example -H 'Authorization: Bearer private'" } }] },
  ];
  assert(writeShadowTaskEpisode({ ...input, root, messages }), "capture with verification evidence");
  const saved = readFileSync(path.join(root, readdirSync(root)[0]), "utf8");
  const checks = JSON.parse(saved).evidence.observedChecks;
  assert(checks.length === 1 && checks[0].kind === "bun-test" && checks[0].status === "passed", "only safe test result stored");
  for (const sensitive of ["secret-customer", "private customer", "secret.example", "Bearer private"]) {
    assert(!saved.includes(sensitive), `raw command or output leaked: ${sensitive}`);
  }
}));

test("does not overwrite reviewer decisions on repeat capture", () => withTemp((root) => {
  assert(writeShadowTaskEpisode({ ...input, root }), "first capture");
  const file = path.join(root, readdirSync(root)[0]);
  const card = JSON.parse(readFileSync(file, "utf8"));
  card.review = { decision: "A", reason: "reviewed", protected: true };
  writeFileSync(file, JSON.stringify(card));
  assert(!writeShadowTaskEpisode({ ...input, root }), "duplicate ignored");
  assert(JSON.parse(readFileSync(file, "utf8")).review.reason === "reviewed", "review is retained");
}));

test("prunes expired collector cards only, without following unrelated files", () => withTemp((root) => {
  writeShadowTaskEpisode({ ...input, root });
  const stale = path.join(root, "episode-old.json");
  const unrelated = path.join(root, "my-review.json");
  const expired = new Date(now.getTime() - 31 * 86400_000);
  writeFileSync(stale, JSON.stringify({ schema: "sherpa-shadow-task-episode-v1", capturedAt: expired.toISOString() }));
  writeFileSync(unrelated, "{}");
  utimesSync(stale, now, now); utimesSync(unrelated, expired, expired);
  const result = pruneShadowTaskEpisodes(root, now);
  assert(result === 1, "one expired card removed");
  assert(!existsSync(stale) && existsSync(unrelated), "unrelated review retained");
  assert(readdirSync(root).length === 2, "fresh card retained");
}));

test("writer fails closed and never escapes an unsafe root", () => withTemp((root) => {
  const file = path.join(root, "not-a-directory");
  writeFileSync(file, "not a directory");
  assert(!writeShadowTaskEpisode({ ...input, root: file }), "failed capture should not throw");
  chmodSync(root, 0o755);
  assert(!writeShadowTaskEpisode({ ...input, root }), "world-readable directory rejected");
}));

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
if (failures) process.exitCode = 1;
