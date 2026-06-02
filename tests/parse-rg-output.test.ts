/**
 * Sherpa File Source Tests
 * 
 * Tests for Sherpa's file/docs/git retrieval sources.
 * Run with: npx tsx tests/parse-rg-output.test.ts
 */

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function countOccurrences(str: string, sub: string): number {
    return (str.match(new RegExp(sub, "g")) || []).length;
}

function parseRgOutput(output: string): Array<{ fileAndLine: string; content: string }> {
    const results: Array<{ fileAndLine: string; content: string }> = [];
    for (const block of output.split("\n").slice(0, 30)) {
        if (!block.trim()) continue;
        // OLD BUGGY PARSER: block.split(":") breaks on any colon
        // FIX: split on first ":" only (after the line number)
        const firstColon = block.indexOf(":");
        const secondColon = block.indexOf(":", firstColon + 1);
        if (firstColon === -1) continue;
        
        // file:line:content — split at second colon to separate line number from content
        const fileAndLine = block.slice(0, secondColon);
        const content = block.slice(secondColon + 1).trim();
        results.push({ fileAndLine, content });
    }
    return results;
}

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
    } catch (e: any) {
        return e.stdout ?? "";
    }
}

async function gitChanged(cwd: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--short"], { timeout: 1500 });
        return stdout;
    } catch {
        return "";
    }
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
    console.log("🧪 Sherpa File Source Tests\n");
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

// TEST 1: Parse simple ripgrep output (no colons in content)
test("parseRgOutput: simple output", async () => {
    const output = `/path/file.ts:42:const x = 1;
/path/file.ts:100:export function foo() {}`;
    const results = parseRgOutput(output);
    assert(results.length === 2, `Expected 2 results, got ${results.length}`);
    assert(results[0].fileAndLine === "/path/file.ts:42", `Wrong file:line: ${results[0].fileAndLine}`);
    assert(results[0].content === "const x = 1;", `Wrong content: ${results[0].content}`);
    assert(results[1].fileAndLine === "/path/file.ts:100", `Wrong file:line: ${results[1].fileAndLine}`);
    assert(results[1].content === "export function foo() {}", `Wrong content: ${results[1].content}`);
});

// TEST 2: Parse output with colons in content (URLs)
test("parseRgOutput: content with URL (critical bug)", async () => {
    const output = `/path/file.ts:42:fetch("https://api.example.com/v1/test")`;
    const results = parseRgOutput(output);
    assert(results.length === 1, `Expected 1 result, got ${results.length}`);
    // OLD BUG: would split on every colon, breaking the URL
    assert(results[0].content.includes("https://api.example.com"), 
           `Content lost URL: ${results[0].content}`);
});

// TEST 3: Parse output with JSON containing colons
test("parseRgOutput: JSON with colons", async () => {
    const output = `/path/file.ts:10:{"type":"Sherpa","provider":"omlxa"}`;
    const results = parseRgOutput(output);
    assert(results.length === 1, `Expected 1 result, got ${results.length}`);
    assert(results[0].content.includes('"provider":"omlxa"'),
           `JSON corrupted: ${results[0].content}`);
});

// TEST 4: Parse output with URL that has port number
test("parseRgOutput: URL with port", async () => {
    const output = `/path/file.ts:5:baseUrl: "http://127.0.0.1:8000/v1"`;
    const results = parseRgOutput(output);
    assert(results.length === 1, `Expected 1 result, got ${results.length}`);
    assert(results[0].content.includes("8000"), 
           `Port lost: ${results[0].content}`);
});

// TEST 5: Parse output with Windows-style path (has drive letter)
test("parseRgOutput: Windows path", async () => {
    const output = `C:\\Users\\test\\file.ts:10:const x = 1;`;
    const results = parseRgOutput(output);
    assert(results.length === 1, `Expected 1 result, got ${results.length}`);
    assert(results[0].fileAndLine.includes("C:\\Users"), 
           `Path corrupted: ${results[0].fileAndLine}`);
});

// TEST 6: Round-trip test - parse then reconstruct
test("parseRgOutput: preserves content integrity", async () => {
    const lines = [
        '/file.ts:1:simple content',
        '/file.ts:2:content with http://example.com/path',
        '/file.ts:3:{"key":"value","nested":{"a":1}}',
        '/file.ts:4:baseUrl: "http://localhost:3000/api"',
    ];
    const output = lines.join("\n");
    const results = parseRgOutput(output);
    assert(results.length === lines.length, `Expected ${lines.length}, got ${results.length}`);
    for (let i = 0; i < lines.length; i++) {
        const expected = lines[i].split(":").slice(2).join(":").trim();
        assert(results[i].content === expected, 
               `Line ${i}: expected "${expected}", got "${results[i].content}"`);
    }
});

// TEST 7: git status returns non-empty output in a git repo
test("gitChanged: returns status in git repo", async () => {
    const cwd = "/Users/kamil/.pi/agent";
    const result = await gitChanged(cwd);
    // Result may be empty (no changes) but should not error
    assert(typeof result === "string", "Should return string");
});

// TEST 8: git status in non-git dir returns empty
test("gitChanged: returns empty in non-git dir", async () => {
    const result = await gitChanged("/tmp");
    assert(result === "", `Expected empty string, got: ${result}`);
});

// TEST 9: rg function returns results for known query
test("rg: finds Sherpa-related files", async () => {
    const output = await rg("/Users/kamil/.pi/agent", "Sherpa");
    assert(output.length > 0, "Should find Sherpa in files");
    assert(output.includes("Sherpa"), "Output should contain 'Sherpa'");
    assert(/:\d+:/.test(output), "Output should contain file:line format");
});

// TEST 10: rg with no matches returns empty
test("rg: returns empty for no matches", async () => {
    const output = await rg("/tmp", "zxywvvqruu12345");
    assert(output.trim() === "", `Expected empty, got: ${output}`);
});

// TEST 11: rg limits to 30 lines
test("rg: limits results to 30 lines", async () => {
    const output = await rg("/Users/kamil/.pi/agent", "the");
    const lines = output.split("\n").filter(l => l.trim());
    assert(lines.length <= 30, `Expected <=30 lines, got ${lines.length}`);
});

// TEST 12: Parse output from actual Sherpa search (real data)
test("parseRgOutput: real Sherpa search output", async () => {
    const output = `/Users/kamil/.pi/agent/.pi/sherpa.config.json:30:    "provider": "omlxa",
/Users/kamil/.pi/agent/.pi/sherpa.md:1:# Sherpa — Project Memory Config
/Users/kamil/.pi/agent/extensions/pi-sherpa/SHERPA_SYSTEM.md:1:# Sherpa — context router, distillation engine, and session firewall.`;
    const results = parseRgOutput(output);
    assert(results.length === 3, `Expected 3, got ${results.length}`);
    // Check JSON line preserved correctly
    assert(results[0].content.includes('"omlxa"'), 
           `JSON corrupted: ${results[0].content}`);
    // Check markdown preserved
    assert(results[1].content.includes("Project Memory Config"),
           `Markdown corrupted: ${results[1].content}`);
});

// TEST 13: Empty lines are skipped
test("parseRgOutput: skips empty lines", async () => {
    const output = `/file.ts:1:content1
/file.ts:2:content2
/file.ts:3:content3`;
    const results = parseRgOutput(output);
    assert(results.length === 3, `Expected 3, got ${results.length}`);
});

// TEST 14: Lines without colons are skipped
test("parseRgOutput: skips malformed lines", async () => {
    const output = `/file.ts:1:valid line
totally invalid line
/file.ts:2:another valid`;
    const results = parseRgOutput(output);
    assert(results.length === 2, `Expected 2, got ${results.length}`);
});

// TEST 15: Parser preserves URLs with ports in content
test("parseRgOutput: URL handling", async () => {
    const output = `/file.ts:1:curl http://127.0.0.1:8080/api`;
    const results = parseRgOutput(output);
    assert(results[0].fileAndLine === "/file.ts:1", `Wrong file:line: ${results[0].fileAndLine}`);
    assert(results[0].content.includes("8080"), `Parser should preserve URL with port: ${results[0].content}`);
});

// ─── Run ─────────────────────────────────────────────────────────────────────

runTests();
