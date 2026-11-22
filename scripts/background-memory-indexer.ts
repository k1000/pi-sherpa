#!/usr/bin/env bun
/** Refresh Sherpa's memory index after Pi exits without blocking shutdown. */

import { closeSherpaMemoryIndexes, indexSherpaMemory } from "../lib/memory-index";

const [baseDir, configJson] = process.argv.slice(2);

if (!baseDir || !configJson) {
  console.error("Usage: background-memory-indexer.ts <base-dir> <config-json>");
  process.exit(1);
}

try {
  const stats = indexSherpaMemory(baseDir, JSON.parse(configJson));
  console.log(JSON.stringify(stats));
} finally {
  closeSherpaMemoryIndexes();
}
