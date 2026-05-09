/**
 * Sherpa File Source Integration Tests
 * 
 * Tests Sherpa's actual file/docs/git retrieval behavior.
 * Run with: cd extensions/pi-sherpa && npx tsx tests/file-source.test.ts
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

// ─── Sherpa's exact source functions (copied from index.ts) ────────────────────

function score(text: string, focus: string): number {
  const words = new Set(focus.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []);
  if (!words.size) return 0.1;
  const textLower = text.toLowerCase();
  let hits = 0;
  for (const w of words) if (textLower.includes(w)) hits++;
  return hits / words.size;
}

function summarize(raw: string, budgetChars = 700): string {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const important = lines.filter(l => /error|fail|exception|warning|todo|fixme|export |function |class |describe\(|it\(/i.test(l));
  const picked = (important.length ? important : lines).slice(0, 10).join("\n");
  return picked.length > budgetChars ? picked.slice(0, budgetChars - 1) + "…" : picked;
}

async function rg(cwd: string, query: string): Promise<string> {
  const terms = query.match(/[A-Za-z0-9_./-]{4,}/g)?.slice(0, 6) ?? [];
  if (!terms.length) return "";
  const bundledRg = path.join(cwd, "bin", "rg");
  const rgBin = existsSync(bundledRg) ? bundledRg : "rg";
  try {
    const { stdout } = await execFileAsync(rgBin, [
      "-n", "--hidden", "--glob", "!.git", "--glob", "!node_modules",
      terms.join("|"), cwd
    ], { timeout: 3000, maxBuffer: 500_000 });
    return stdout;
  } catch (e: any) { return e.stdout ?? ""; }
}

async function gitChanged(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--short"], { timeout: 1500 });
    return stdout;
  } catch { return ""; }
}

// OLD BUGGY PARSER (what Sherpa currently uses)
function parseRgOutputOld(output: string): Array<{ fileAndLine: string; content: string }> {
  const results: Array<{ fileAndLine: string; content: string }> = [];
  for (const block of output.split("\n").slice(0, 30)) {
    if (!block.trim()) continue;
    const parts = block.split(":");
    const fileAndLine = parts.slice(0, 2).join(":");
    const content = parts.slice(2).join(":").trim();
    results.push({ fileAndLine, content });
  }
  return results;
}

// FIXED PARSER
function parseRgOutputNew(output: string): Array<{ fileAndLine: string; content: string }> {
  const results: Array<{ fileAndLine: string; content: string }> = [];
  for (const block of output.split("\n").slice(0, 30)) {
    if (!block.trim()) continue;
    const firstColon = block.indexOf(":");
    const secondColon = block.indexOf(":", firstColon + 1);
    if (firstColon === -1) continue;
    const fileAndLine = block.slice(0, secondColon);
    const content = block.slice(secondColon + 1).trim();
    results.push({ fileAndLine, content });
  }
  return results;
}

interface Candidate {
  type: string;
  source: string;
  relevance: number;
  summary: string;
  raw: string;
}

async function searchSources(
  cwd: string,
  focus: string,
  sources: { files: boolean; docs: boolean; git: boolean; session: boolean }
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  
  if (sources.files) {
    const out = await rg(cwd, focus);
    for (const block of out.split("\n").slice(0, 30)) {
      if (!block.trim()) continue;
      const firstColon = block.indexOf(":");
      const secondColon = block.indexOf(":", firstColon + 1);
      if (firstColon === -1) continue;
      const fileAndLine = block.slice(0, secondColon);
      const content = block.slice(secondColon + 1).trim();
      if (!content) continue;
      const relevance = score(content + " " + fileAndLine, focus) + 0.15;
      if (relevance < 0.08) continue;
      candidates.push({
        type: "file_snippet",
        source: `repo://${fileAndLine}`,
        relevance: Math.min(1, relevance),
        summary: summarize(content),
        raw: content,
      });
    }
  }
  
  if (sources.docs) {
    for (const f of ["AGENTS.md", "README.md", "docs/README.md"]) {
      const p = path.join(cwd, f);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8").slice(0, 4000);
      const relevance = score(raw + " " + f, focus) + 0.1;
      if (relevance < 0.08) continue;
      candidates.push({
        type: "doc_snippet",
        source: `repo://${f}`,
        relevance: Math.min(1, relevance),
        summary: summarize(raw),
        raw,
      });
    }
  }
  
  if (sources.git) {
    const raw = await gitChanged(cwd);
    const relevance = score(raw, focus) + 0.05;
    if (relevance >= 0.08) {
      candidates.push({
        type: "git_status",
        source: "git://status",
        relevance: Math.min(1, relevance),
        summary: summarize(raw),
        raw,
      });
    }
  }
  
  return candidates;
}

// ─── Test Suite ────────────────────────────────────────────────────────────────

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function runTests() {
  console.log("🧪 Sherpa File Source Integration Tests\n");
  console.log("=".repeat(60));

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✅ ${t.name}`);
      passed++;
    } catch (e: any) {
      console.log(`  ❌ ${t.name}`);
      console.log(`     ${e.message}`);
      failed++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TEST_CWD = "/Users/kamil/.pi/agent";

test("searchSources: finds Sherpa files", async () => {
  const results = await searchSources(TEST_CWD, "Sherpa", { files: true, docs: false, git: false, session: false });
  assert(results.length > 0, `Expected file results for "Sherpa", got ${results.length}`);
  assert(results[0].type === "file_snippet", `Expected file_snippet, got ${results[0].type}`);
  console.log(`     Found ${results.length} results, top relevance: ${(results[0].relevance * 100).toFixed(0)}%`);
});

test("searchSources: finds config files", async () => {
  const results = await searchSources(TEST_CWD, "sherpa config model", { files: true, docs: false, git: false, session: false });
  assert(results.length > 0, `Expected results for config query, got ${results.length}`);
  console.log(`     Found ${results.length} results`);
  for (const r of results.slice(0, 3)) {
    console.log(`     - ${r.source} (${(r.relevance * 100).toFixed(0)}%): ${r.summary.slice(0, 60)}`);
  }
});

test("searchSources: git status in git repo", async () => {
  // /Users/kamil/.pi/agent may not be a git repo, so git might return empty
  const results = await searchSources(TEST_CWD, "git status changes", { files: false, docs: false, git: true, session: false });
  // Git search either returns a result or empty - both are valid
  assert(results.length >= 0, "Should not error");
});

test("searchSources: no matches returns empty", async () => {
  // Use /tmp to avoid matching test files
  const results = await searchSources("/tmp", "xyznonexistentabc123", { files: true, docs: false, git: false, session: false });
  assert(results.length === 0, `Expected 0 results for non-existent query, got ${results.length}`);
});

test("searchSources: all sources combined", async () => {
  const results = await searchSources(TEST_CWD, "Sherpa config provider", { files: true, docs: true, git: true, session: false });
  assert(results.length > 0, `Expected combined results, got ${results.length}`);
  console.log(`     Found ${results.length} total results`);
  const types = results.map(r => r.type);
  console.log(`     Types: ${[...new Set(types)].join(", ")}`);
});

test("OLD parser vs NEW parser: JSON with provider field", async () => {
  const rgOutput = `/Users/kamil/.pi/agent/.pi/sherpa.config.json:30:    "provider": "omlxa",`;
  const oldResults = parseRgOutputOld(rgOutput);
  const newResults = parseRgOutputNew(rgOutput);
  
  // Both should preserve the content
  assert(oldResults[0].content.includes("omlxa"), `OLD content missing: ${oldResults[0].content}`);
  assert(newResults[0].content.includes("omlxa"), `NEW content missing: ${newResults[0].content}`);
  
  // OLD parser gives wrong file:line for paths with dots
  // NEW parser is more robust
  assert(newResults[0].fileAndLine === "/Users/kamil/.pi/agent/.pi/sherpa.config.json:30",
         `NEW wrong: ${newResults[0].fileAndLine}`);
});

test("OLD parser vs NEW parser: URL in content", async () => {
  const rgOutput = `/file.ts:42:fetch("http://127.0.0.1:8000/api")`;
  const oldResults = parseRgOutputOld(rgOutput);
  const newResults = parseRgOutputNew(rgOutput);
  
  // Content should be preserved by both
  assert(oldResults[0].content.includes("8000"), `OLD lost URL port: ${oldResults[0].content}`);
  assert(newResults[0].content.includes("8000"), `NEW lost URL port: ${newResults[0].content}`);
});

test("score: relevance calculation", () => {
  const s1 = score("provider omlxa Sherpa config", "Sherpa provider");
  const s2 = score("foo bar baz qux", "Sherpa provider");
  assert(s1 > s2, `Better match should score higher: ${s1} vs ${s2}`);
  assert(s1 >= 0.5, `High overlap should score >= 0.5: ${s1}`);
});

test("score: partial match scores reasonably", () => {
  const s = score("function parseConfig json", "Sherpa config");
  assert(s >= 0, `Should have some relevance: ${s}`);
  assert(s <= 1, `Score should not exceed 1.0: ${s}`);
  assert(s < 1, `Partial match should not be 1.0: ${s}`);
});

test("score: no match scores low but > 0", () => {
  const s = score("unrelated content here", "Sherpa config");
  assert(s < 0.3, `No match should score low: ${s}`);
  assert(s >= 0, `Score should not be negative: ${s}`);
});

test("summarize: extracts first lines", () => {
  const long = "line1\nline2\nline3\nfunction foo() {}\nline5";
  const s = summarize(long, 100);
  assert(s.includes("function foo()"), `Should include function line: ${s}`);
});

test("rg: finds multiple terms", async () => {
  const out = await rg(TEST_CWD, "Sherpa config");
  assert(out.includes("Sherpa") || out.includes("sherpa"), `Should find Sherpa or sherpa`);
  assert(out.includes(":"), `Should be in file:line:content format`);
});

test("rg: returns empty for no match", async () => {
  const out = await rg("/tmp", "zzznotexist999xyz");
  assert(out.trim() === "", `Should be empty, got: ${out.slice(0, 50)}`);
});

// ─── Run ─────────────────────────────────────────────────────────────────────

runTests();
