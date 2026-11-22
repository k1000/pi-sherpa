#!/usr/bin/env node
/**
 * Sherpa baseline metrics (PRD P0-2).
 *
 * Reads pi session transcripts and reports where input-side tokens actually go,
 * which is the number Sherpa must move. No dependencies, read-only.
 *
 * Usage:
 *   node scripts/sherpa-metrics.mjs                 # human summary
 *   node scripts/sherpa-metrics.mjs --json <path>    # also write JSON report
 *   node scripts/sherpa-metrics.mjs --root <dir>     # alternate sessions root
 *
 * Token estimation: chars / 3.5 (same constant used by the PRD guard).
 * "amortized" = result tokens x number of assistant turns that follow in the
 * same session, i.e. what the result actually costs once it sits in context.
 */
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
void require;

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = rootFlag >= 0 ? args[rootFlag + 1] : path.join(process.env.HOME ?? '', '.pi/agent/sessions');
const jsonFlag = args.indexOf('--json');
const jsonPath = jsonFlag >= 0 ? args[jsonFlag + 1] : null;

const CHARS_PER_TOKEN = 3.5;
const files = globSync(path.join(root, '**/*.jsonl'));

const perTool = new Map(); // toolName -> {count, raw, amortized, sizes[]}
const usage = { input: 0, cacheRead: 0, output: 0, assistantTurns: 0 };
let sessions = 0;
let sherpaMarkers = 0;
let rows = 0;

const toks = (chars) => chars / CHARS_PER_TOKEN;

function bump(tool, entry) {
  const cur = perTool.get(tool) ?? { count: 0, raw: 0, amortized: 0, sizes: [] };
  cur.count += 1;
  cur.raw += entry.raw;
  cur.amortized += entry.amortized;
  cur.sizes.push(entry.raw);
  perTool.set(tool, cur);
}

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
};

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      /* skip malformed rows */
    }
  }
  if (!parsed.length) continue;
  sessions += 1;
  rows += parsed.length;

  // Assistant turns after each row, for amortization.
  const assistantAfter = new Array(parsed.length).fill(0);
  let seen = 0;
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    assistantAfter[i] = seen;
    const m = parsed[i]?.message;
    if (m && m.role === 'assistant') seen += 1;
  }

  for (let i = 0; i < parsed.length; i += 1) {
    const m = parsed[i]?.message;
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'assistant') {
      usage.assistantTurns += 1;
      const u = m.usage ?? {};
      usage.input += Number(u.input ?? 0) || 0;
      usage.cacheRead += Number(u.cacheRead ?? u.cache_read ?? 0) || 0;
      usage.output += Number(u.output ?? 0) || 0;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        const text = typeof c?.text === 'string' ? c.text : '';
        if (/sherpa/i.test(text)) sherpaMarkers += 1;
      }
      continue;
    }

    if (m.role !== 'toolResult') continue;
    const chars = (Array.isArray(m.content) ? m.content : []).reduce(
      (sum, c) => sum + (typeof c?.text === 'string' ? c.text.length : 0),
      0,
    );
    const raw = toks(chars);
    const mult = Math.max(1, assistantAfter[i]);
    bump(m.toolName ?? 'unknown', { raw, amortized: raw * mult });
  }
}

const rank = [...perTool.entries()].sort((a, b) => b[1].amortized - a[1].amortized);
const totalAmortized = rank.reduce((sum, [, v]) => sum + v.amortized, 0) || 1;
const inputSide = usage.input + usage.cacheRead || 1;

const tools = rank.map(([name, v]) => {
  const sizes = v.sizes.sort((a, b) => a - b);
  return {
    tool: name,
    calls: v.count,
    rawTokens: Math.round(v.raw),
    amortizedTokens: Math.round(v.amortized),
    shareOfToolOutput: Number(((v.amortized / totalAmortized) * 100).toFixed(1)),
    shareOfInputSide: Number(((v.amortized / inputSide) * 100).toFixed(1)),
    medianTokens: Math.round(quantile(sizes, 0.5)),
    p90Tokens: Math.round(quantile(sizes, 0.9)),
    maxTokens: Math.round(sizes.at(-1) ?? 0),
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  root,
  sessions,
  rows,
  usage: { ...usage, inputSideTokens: usage.input + usage.cacheRead },
  sherpaMarkers,
  tools,
};

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString('en-US');

console.log(`sessions ${sessions} | rows ${num(rows)} | root ${root}`);
console.log(
  `input-side ${num(report.usage.inputSideTokens)} tok = fresh ${num(usage.input)} + cacheRead ${num(usage.cacheRead)} | output ${num(usage.output)} | assistant turns ${num(usage.assistantTurns)}`,
);
console.log('tool              calls      raw tok   amort tok  %input  median    p90     max');
for (const t of tools.slice(0, 10)) {
  console.log(
    `${pad(t.tool, 16)} ${pad(num(t.calls), 7)} ${pad(num(t.rawTokens), 12)} ${pad(num(t.amortizedTokens), 11)} ${pad(`${t.shareOfInputSide}%`, 7)} ${pad(num(t.medianTokens), 6)} ${pad(num(t.p90Tokens), 6)} ${num(t.maxTokens)}`,
  );
}
console.log(`shares are of input-side paid tokens; sherpa markers in assistant text: ${sherpaMarkers}`);

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`json written: ${jsonPath}`);
}
