/**
 * Progressive Context Disclosure tests.
 * Run with: bun tests/progressive-context.test.ts
 */

import { assignTiers, promoteToL2, renderTieredBundle, type TieredContextItem } from "../lib/progressive-context";

const tests: Array<{ name: string; fn: () => void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function assertEqual(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function makeItems(count: number): Array<{
  handle: string; type: string; source: string; relevance: number; summary: string; raw?: string; inline?: boolean;
}> {
  return Array.from({ length: count }, (_, i) => ({
    handle: `ctx-${i + 1}`,
    type: "code_snippet",
    source: "file://src/test.ts",
    relevance: 1.0 - i * 0.1,
    summary: `Test item ${i + 1}: this is a summary that contains some useful information about the codebase`,
    raw: `This is the full content of item ${i + 1}. It contains detailed information about how the module works, including function signatures, parameter types, and example usage. `.repeat(10),
  }));
}

test("assigns L0 to items when budget is exhausted", () => {
  const items = makeItems(20);
  // Very small budget → most items should be L0
  const tiered = assignTiers(items, 100);
  const l0Count = tiered.filter((i) => i.tier === 0).length;
  assert(l0Count > 10, `${l0Count} L0 items with small budget`);
});

test("assigns L1 to top items within budget", () => {
  const items = makeItems(5);
  // Generous budget → top items should be L1
  const tiered = assignTiers(items, 5000);
  const l1Count = tiered.filter((i) => i.tier === 1).length;
  assert(l1Count > 0, `${l1Count} L1 items with generous budget`);
});

test("inline items always get L2", () => {
  const items = makeItems(3);
  items[0]!.inline = true;
  const tiered = assignTiers(items, 100);
  assertEqual(tiered[0]!.tier, 2, "inline item is L2");
});

test("expanded handles get L2", () => {
  const items = makeItems(5);
  const tiered = assignTiers(items, 100, new Set(["ctx-3"]));
  const expanded = tiered.find((i) => i.handle === "ctx-3");
  assert(expanded?.tier === 2, "expanded handle is L2");
});

test("promoteToL2 promotes a handle to tier 2", () => {
  const items: TieredContextItem[] = makeItems(3).map((item) => ({
    ...item,
    tier: 0,
    charCount: item.raw!.length,
  }));
  const promoted = promoteToL2(items, "ctx-2");
  assert(promoted !== null, "should find and promote");
  assertEqual(promoted!.tier, 2, "promoted to L2");
  assertEqual(items[1]!.tier, 2, "item in array is updated");
});

test("promoteToL2 returns null for unknown handle", () => {
  const items: TieredContextItem[] = makeItems(3).map((item) => ({
    ...item,
    tier: 0,
    charCount: item.raw!.length,
  }));
  const result = promoteToL2(items, "ctx-999");
  assert(result === null, "null for unknown handle");
});

test("renderTieredBundle produces valid markdown", () => {
  const items: TieredContextItem[] = [
    { handle: "ctx-1", type: "code", source: "file://a.ts", relevance: 0.9, summary: "Short summary", tier: 0, raw: "full content" },
    { handle: "ctx-2", type: "code", source: "file://b.ts", relevance: 0.8, summary: "Another summary", tier: 1, raw: "snippet content", charCount: 20 },
  ];
  const md = renderTieredBundle(items, "bundle-test", "testing rendering");
  assert(md.includes("bundle-test"), "bundle ID in output");
  assert(md.includes("L0"), "L0 section present");
  assert(md.includes("L1"), "L1 section present");
  assert(md.includes("ctx-1"), "ctx-1 in output");
  assert(md.includes("ctx-2"), "ctx-2 in output");
});

// ── Run ──
for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { failed++; console.error(`❌ ${name}`); console.error(error); }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
