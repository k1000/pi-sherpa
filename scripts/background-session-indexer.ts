#!/usr/bin/env bun
/** Index session logs after Pi exits without delaying session shutdown. */

import { closeSessionDb, indexSessionLog } from "../lib/session-search";

const [sessionLogPath, baseDir] = process.argv.slice(2);

if (!sessionLogPath || !baseDir) {
  console.error("Usage: background-session-indexer.ts <session-log-path> <base-dir>");
  process.exit(1);
}

try {
  const indexed = indexSessionLog({ sessionLogPath }, baseDir);
  console.log(JSON.stringify({ indexed }));
} finally {
  closeSessionDb();
}
