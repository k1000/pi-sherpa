import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeSessionDb, searchSessions } from "../lib/session-search";

const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-background-index-"));
try {
  const logPath = path.join(dir, "session.jsonl");
  writeFileSync(logPath, `${JSON.stringify({ sessionId: "background", ts: "2026-08-31T00:00:00.000Z", kind: "prompt", prompt: "background indexing works" })}\n`);

  const stdout = execFileSync("bun", ["run", "scripts/background-session-indexer.ts", logPath, dir], {
    cwd: path.resolve(process.cwd()),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(stdout).indexed, 1, "worker indexes the new session entry");
  assert.equal(searchSessions("background indexing", 5, { sessionLogPath: logPath }, dir)[0]?.sessionId, "background");
} finally {
  closeSessionDb();
  rmSync(dir, { recursive: true, force: true });
}

console.log("background session indexer tests passed=2");
