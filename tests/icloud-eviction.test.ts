#!/usr/bin/env bun
/**
 * @sherpa-purpose Regression: iCloud-evicted (dateless, st_blocks=0) vault files
 * must never be read synchronously — before the fileIsMaterialized guard, a
 * single retrieval froze the whole agent for minutes (readFileSync blocks ~1s+
 * per evicted file while iCloud materializes it).
 * @sherpa-timeout 60000
 * @sherpa-safe true
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileIsMaterialized } from "../lib/common";
import { readCsvRows } from "../lib/catalog";
import { addOntologyFallbackMemory, addProjectMemoryCandidates } from "../lib/project-memory-readers";
import { indexSherpaMemory } from "../lib/memory-index";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

/** Create a truly sparse file (0 allocated blocks) on APFS. */
function makeSparseFile(dir: string, name: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, "");
  truncateSync(p, 1024 * 1024); // 1 MiB of zeros, no blocks allocated
  return p;
}

test("fileIsMaterialized: sparse (st_blocks=0) file is NOT materialized", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-evic-"));
  try {
    const sparse = makeSparseFile(dir, "evicted.md");
    const st = statSync(sparse);
    if (st.blocks !== 0) {
      console.log(`⏭️  filesystem reports blocks=${st.blocks} for truncated file — sparse semantics unavailable here, skipping`);
      return;
    }
    assert.equal(fileIsMaterialized(sparse), false, "sparse file must be treated as evicted");
    const real = path.join(dir, "real.md");
    writeFileSync(real, "hello");
    assert.equal(fileIsMaterialized(real), true, "normal file must be materialized");
    assert.equal(fileIsMaterialized(path.join(dir, "missing.md")), false, "missing file must be not materialized");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCsvRows returns [] for evicted catalog.csv instead of reading it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-evic-"));
  try {
    const sparse = makeSparseFile(dir, "catalog.csv");
    const st = statSync(sparse);
    if (st.blocks !== 0) {
      console.log("⏭️  sparse semantics unavailable, skipping");
      return;
    }
    assert.deepEqual(readCsvRows(sparse), [], "evicted catalog.csv must yield no rows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addOntologyFallbackMemory skips evicted notes without reading them", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sherpa-evic-"));
  try {
    const real = path.join(dir, "wiki", "concepts");
    mkdirSync(real, { recursive: true });
    const sparseNote = makeSparseFile(real, "evicted-note.md");
    const st = statSync(sparseNote);
    if (st.blocks !== 0) {
      console.log("⏭️  sparse semantics unavailable, skipping");
      return;
    }
    writeFileSync(path.join(real, "real-note.md"), "retrieval freeze regression evidence notes");
    const added: Array<{ source: string; raw: string }> = [];
    addOntologyFallbackMemory(dir, "retrieval", (type, source, raw) => { added.push({ source, raw }); });
    assert.equal(added.some((a) => a.source.includes("evicted-note")), false, "evicted note must never be read/added");
    assert.ok(added.some((a) => a.source.includes("real-note")), "materialized note must still be considered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real vault retrieval path completes quickly (freeze regression)", async () => {
  const vault = path.join(os.homedir(), "Documents", "articles");
  if (!existsSync(vault)) {
    console.log("⏭️  vault not present, skipping");
    return;
  }
  const baseDir = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-sherpa");
  const startedAt = Date.now();
  // Exact hot path from addMemoryIndexCandidates: full re-index including the
  // vault catalog + sherpa-evaluations walk. Pre-fix this took minutes
  // (1093/1304 vault files evicted, ~1.1s sync read each).
  indexSherpaMemory(baseDir, {
    scratchpadRoot: path.join(baseDir, ".pi-memory", "scratchpad"),
    catalogRoots: [baseDir, vault],
    evaluationRoot: vault,
  });
  const elapsed = Date.now() - startedAt;
  console.log(`vault memory-index completed in ${elapsed}ms`);
  assert.ok(elapsed < 15_000, `vault indexing took ${elapsed}ms — freeze regression (evicted reads not skipped)`);

  // The other half of the freeze: project-memory-readers fan-out over 80
  // research areas + 120 projects, each reading catalog.csv + matched notes.
  const pmStartedAt = Date.now();
  const pmAdds: string[] = [];
  addProjectMemoryCandidates(baseDir, vault, "retrieval freeze", "retrieval freeze", {
    searchOtherProjects: true,
    includeTaxonomy: true,
  }, (type, source) => { pmAdds.push(source); });
  const pmElapsed = Date.now() - pmStartedAt;
  console.log(`project-memory-readers completed in ${pmElapsed}ms (${pmAdds.length} candidates)`);
  assert.ok(pmElapsed < 15_000, `project-memory-readers took ${pmElapsed}ms — freeze regression`);
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
