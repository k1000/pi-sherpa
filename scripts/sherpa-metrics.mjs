#!/usr/bin/env node
/**
 * Sherpa baseline metrics (PRD P0-1).
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
 *
 * "amortized" = result tokens x number of assistant turns that strictly follow
 * the result in the same session, i.e. what the result costs once it sits in
 * context. A result in the final turn is followed by nothing and is charged
 * zero; it is still counted in `lastTurnResults` so expect those calls to show
 * raw tokens with no amortized cost.
 *
 * Sherpa activity is detected from the transcript representation it writes
 * (`type: "custom_message"`, `customType: "sherpa-context"`), never from
 * assistant prose mentioning the word "sherpa" — a mention proves nothing about
 * injection. Text mentions are reported separately as `assistantTextMentions`.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CHARS_PER_TOKEN = 3.5;
export const SHERPA_CONTEXT_TYPE = 'sherpa-context';

const toks = (chars) => chars / CHARS_PER_TOKEN;

const contentChars = (message) =>
  (Array.isArray(message?.content) ? message.content : []).reduce(
    (sum, c) => sum + (typeof c?.text === 'string' ? c.text.length : 0),
    0,
  );

export function emptyTotals() {
  return {
    sessions: 0,
    rows: 0,
    usage: { input: 0, cacheRead: 0, output: 0, assistantTurns: 0 },
    sherpaInjections: 0,
    sherpaInjectedTokens: 0,
    assistantTextMentions: 0,
    lastTurnResults: 0,
    customTypes: new Map(),
    perTool: new Map(),
  };
}

function bump(totals, tool, raw, amortized) {
  const cur = totals.perTool.get(tool) ?? { count: 0, raw: 0, amortized: 0, sizes: [] };
  cur.count += 1;
  cur.raw += raw;
  cur.amortized += amortized;
  cur.sizes.push(raw);
  totals.perTool.set(tool, cur);
}

/** Fold one session file (array of transcript rows) into totals. */
export function scanRows(rows, totals) {
  if (!rows.length) return totals;
  totals.sessions += 1;
  totals.rows += rows.length;

  // Assistant turns strictly after each row index, for amortization.
  const assistantAfter = new Array(rows.length).fill(0);
  let seen = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    assistantAfter[i] = seen;
    if (rows[i]?.message?.role === 'assistant') seen += 1;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;

    // Any custom message tells us the transcript records injections at all:
    // the histogram is the control that proves the detector can fire.
    if (typeof row.customType === 'string') {
      totals.customTypes.set(row.customType, (totals.customTypes.get(row.customType) ?? 0) + 1);
    }

    // Injected context is a top-level custom message, not a chat message.
    if (row.customType === SHERPA_CONTEXT_TYPE) {
      totals.sherpaInjections += 1;
      const chars = typeof row.content === 'string' ? row.content.length : 0;
      totals.sherpaInjectedTokens += toks(chars);
      continue;
    }

    const m = row.message;
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'assistant') {
      totals.usage.assistantTurns += 1;
      const u = m.usage ?? {};
      totals.usage.input += Number(u.input ?? 0) || 0;
      totals.usage.cacheRead += Number(u.cacheRead ?? u.cache_read ?? 0) || 0;
      totals.usage.output += Number(u.output ?? 0) || 0;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (typeof c?.text === 'string' && /sherpa/i.test(c.text)) totals.assistantTextMentions += 1;
      }
      continue;
    }

    if (m.role !== 'toolResult') continue;
    const raw = toks(contentChars(m));
    const following = assistantAfter[i];
    if (following === 0) totals.lastTurnResults += 1;
    bump(totals, m.toolName ?? 'unknown', raw, raw * following);
  }
  return totals;
}

export function parseTranscript(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip malformed rows */
    }
  }
  return rows;
}

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

export function buildReport(totals, root) {
  const rank = [...totals.perTool.entries()].sort((a, b) => b[1].amortized - a[1].amortized);
  const totalAmortized = rank.reduce((sum, [, v]) => sum + v.amortized, 0) || 1;
  const inputSide = totals.usage.input + totals.usage.cacheRead || 1;
  const tools = rank.map(([name, v]) => {
    const sizes = [...v.sizes].sort((a, b) => a - b);
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
  return {
    generatedAt: new Date().toISOString(),
    root,
    sessions: totals.sessions,
    rows: totals.rows,
    usage: { ...totals.usage, inputSideTokens: totals.usage.input + totals.usage.cacheRead },
    sherpaInjections: totals.sherpaInjections,
    sherpaInjectedTokens: Math.round(totals.sherpaInjectedTokens),
    assistantTextMentions: totals.assistantTextMentions,
    lastTurnResults: totals.lastTurnResults,
    customTypes: Object.fromEntries([...totals.customTypes.entries()].sort((a, b) => b[1] - a[1])),
    tokenEstimator: `chars / ${CHARS_PER_TOKEN}`,
    tools,
  };
}

/** List `**\/*.jsonl` under root without a glob dependency. */
export function listTranscripts(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function printReport(report) {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (n) => n.toLocaleString('en-US');
  console.log(`sessions ${report.sessions} | rows ${num(report.rows)} | root ${report.root}`);
  console.log(
    `input-side ${num(report.usage.inputSideTokens)} tok = fresh ${num(report.usage.input)} + cacheRead ${num(report.usage.cacheRead)} | output ${num(report.usage.output)} | assistant turns ${num(report.usage.assistantTurns)}`,
  );
  console.log('tool              calls      raw tok   amort tok  %input  median    p90     max');
  for (const t of report.tools.slice(0, 10)) {
    console.log(
      `${pad(t.tool, 16)} ${pad(num(t.calls), 7)} ${pad(num(t.rawTokens), 12)} ${pad(num(t.amortizedTokens), 11)} ${pad(`${t.shareOfInputSide}%`, 7)} ${pad(num(t.medianTokens), 6)} ${pad(num(t.p90Tokens), 6)} ${num(t.maxTokens)}`,
    );
  }
  console.log(
    `sherpa injections (customType ${SHERPA_CONTEXT_TYPE}): ${num(report.sherpaInjections)} | injected ${num(report.sherpaInjectedTokens)} tok | results in final turn (charged 0): ${num(report.lastTurnResults)}`,
  );
  const types = Object.entries(report.customTypes);
  console.log(
    `custom messages in corpus: ${types.length ? types.map(([t, n]) => `${t}=${num(n)}`).join(' ') : 'none'} (control: the detector can fire)`,
  );
  console.log(
    `assistant text mentioning "sherpa": ${num(report.assistantTextMentions)} (informational only, not evidence of injection)`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const root = flag('--root') ?? path.join(process.env.HOME ?? '', '.pi/agent/sessions');
  const jsonPath = flag('--json');

  const totals = emptyTotals();
  for (const file of listTranscripts(root)) scanRows(parseTranscript(readFileSync(file, 'utf8')), totals);
  const report = buildReport(totals, root);
  printReport(report);

  if (jsonPath) {
    mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`json written: ${jsonPath}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('sherpa-metrics.mjs')) main();
