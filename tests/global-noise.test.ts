/**
 * Tests for Sherpa global source-noise filtering.
 * Run with: npx tsx tests/global-noise.test.ts
 */

import { isGloballyNoisySource } from "../index";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ─── Noisy sources that MUST be filtered ────────────────────────────────────

test("filters Sherpa self-cache dir (.pi/sherpa/) but not sibling config file", () => {
  assert(isGloballyNoisySource("repo:///Users/kamil/.pi/sherpa/dspy/dev.jsonl:18"), "dev.jsonl should be noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.pi/sherpa/semble-state.json:4"), "semble-state.json should be noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.pi/sherpa/compiled-candidates/retrieval.prompt.json:4"), "compiled candidates should be noisy");
  // Critical: the sibling config FILE (no trailing slash after `sherpa`) must survive
  assert(!isGloballyNoisySource("repo://.pi/sherpa.config.json"), "sherpa.config.json must NOT be filtered");
  assert(!isGloballyNoisySource("repo:///Users/kamil/.pi/sherpa.config.json"), "absolute sherpa.config.json must NOT be filtered");
});

test("filters shell rc files", () => {
  assert(isGloballyNoisySource("repo:///Users/kamil/.zshrc:86"), ".zshrc should be noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.bashrc"), ".bashrc should be noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.bash_profile:10"), ".bash_profile should be noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.profile"), ".profile should be noisy");
});

test("filters existing shell/cache/build/backup noise", () => {
  assert(isGloballyNoisySource("repo:///Users/kamil/.zsh_history:5"), "zsh_history noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.zcompdump-casper"), "zcompdump noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/Library/Caches/something"), "Library/Caches noisy");
  assert(isGloballyNoisySource("repo://dist/main.js"), "dist/ noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.pi/revolver/x"), ".pi/revolver noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.bun/install/global"), ".bun noisy");
  assert(isGloballyNoisySource("repo://models.json.bak-20260616-185320.bak:7"), "timestamped .bak file noisy");
  assert(isGloballyNoisySource("repo://config.backup"), ".backup file noisy");
});

test("strips repo:// and file:// schemes and lowercases", () => {
  assert(isGloballyNoisySource("file:///Users/kamil/.zshrc"), "file:// scheme stripped");
  assert(isGloballyNoisySource("repo:///Users/KAMIL/.PI/SHERPA/dev.jsonl"), "case-insensitive match");
});

test("filters tool-state dot-directories", () => {
  assert(isGloballyNoisySource("repo:///Users/kamil/.nvm/bash_completion:88"), ".nvm noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.roo/commands/rdio.md:97"), ".roo noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.antigravity/extensions/ms-python/SECURITY.md:31"), ".antigravity noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.mtplx/tuning.json:50"), ".mtplx noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.41d/41d.js:3"), ".41d noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/.pi/understand-anything/READMEs/README.md:64"), "understand-anything state noisy");
  // Sibling project files under .pi/agent must survive.
  assert(!isGloballyNoisySource("repo://.pi/agent/skills/use-sherpa/SKILL.md"), "pi skills kept");
  assert(!isGloballyNoisySource("repo://.pi/agent/extensions/pi-sherpa/index.ts"), "pi extension source kept");
});

test("filters binary/image assets", () => {
  assert(isGloballyNoisySource("repo://assets/logo.svg:12"), ".svg noisy");
  assert(isGloballyNoisySource("repo:///Users/kamil/pelican-riding-horse-final.svg:187"), "absolute .svg noisy");
  assert(isGloballyNoisySource("repo://docs/diagram.PNG"), "case-insensitive image noisy");
  assert(!isGloballyNoisySource("repo://src/svg-renderer.ts:1"), "source file mentioning svg kept");
});

// ─── Legitimate sources that MUST survive ──────────────────────────────────

test("keeps legitimate source files", () => {
  assert(!isGloballyNoisySource("repo://src/index.ts:42"), "src file kept");
  assert(!isGloballyNoisySource("repo://lib/rg.ts:35"), "lib file kept");
  assert(!isGloballyNoisySource("repo://package.json"), "package.json kept (focus-gated elsewhere)");
  assert(!isGloballyNoisySource("repo://tests/global-noise.test.ts:1"), "test file kept");
  assert(!isGloballyNoisySource("repo://README.md"), "README kept");
});

// ─── Runner ────────────────────────────────────────────────────────────────

for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✅ ${t.name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ❌ ${t.name}`);
    console.log(`     ${e.message}`);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
