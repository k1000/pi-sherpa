import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  buildReport,
  emptyTotals,
  listTranscripts,
  parseTranscript,
  scanRows,
} from './sherpa-metrics.mjs';

const row = (o) => JSON.stringify(o);

// A session that actually contains an injection, an unrelated mention, and a
// tool result that nothing follows.
const injectedSession = [
  row({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'how does sherpa route?' }] } }),
  row({
    type: 'custom_message',
    customType: 'sherpa-context',
    content: 'x'.repeat(700),
    display: true,
  }),
  row({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Sherpa injected nothing useful here.' }],
      usage: { input: 1000, cacheRead: 4000, output: 50 },
    },
  }),
  row({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'y'.repeat(700) }] } }),
].join('\n');

// A session that only talks about sherpa in assistant prose: no injection.
const mentionOnlySession = [
  row({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'is sherpa on?' }] } }),
  row({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Sherpa was not active in these sessions.' }],
      usage: { input: 200, cacheRead: 800, output: 10 },
    },
  }),
  row({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Confirmed: no sherpa blocks.' }], usage: { input: 100, cacheRead: 300, output: 5 } } }),
].join('\n');

function fixtureRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sherpa-metrics-'));
  mkdirSync(path.join(dir, 'sess-a'), { recursive: true });
  mkdirSync(path.join(dir, 'sess-b'), { recursive: true });
  writeFileSync(path.join(dir, 'sess-a', 'a.jsonl'), `${injectedSession}\n`);
  writeFileSync(path.join(dir, 'sess-b', 'b.jsonl'), `${mentionOnlySession}\n`);
  return dir;
}

test('injection is counted from customType, not from assistant prose', () => {
  const totals = emptyTotals();
  scanRows(parseTranscript(`${injectedSession}\n`), totals);
  scanRows(parseTranscript(`${mentionOnlySession}\n`), totals);

  assert.equal(totals.sherpaInjections, 1, 'exactly one real injection');
  assert.equal(totals.assistantTextMentions, 3, 'mentions are counted separately');
  assert.ok(totals.sherpaInjectedTokens > 0, 'injected tokens come from the injection row');
});

test('a result in the final turn is charged zero following turns', () => {
  const totals = emptyTotals();
  scanRows(parseTranscript(`${injectedSession}\n`), totals);

  assert.equal(totals.lastTurnResults, 1);
  const bash = totals.perTool.get('bash');
  assert.ok(bash, 'bash result recorded');
  assert.equal(bash.count, 1);
  assert.ok(bash.raw > 0, 'raw tokens still measured');
  assert.equal(bash.amortized, 0, 'no phantom following turn');
});

test('a result followed by two assistant turns is charged twice', () => {
  const rows = parseTranscript(
    [
      row({ type: 'message', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'z'.repeat(350) }] } }),
      row({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } }),
      row({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } }),
    ].join('\n'),
  );
  const totals = emptyTotals();
  scanRows(rows, totals);
  const read = totals.perTool.get('read');
  assert.equal(read.raw, 100);
  assert.equal(read.amortized, 200);
  assert.equal(totals.lastTurnResults, 0);
});

test('report keeps injection counts separate from usage totals', () => {
  const root = fixtureRoot();
  const totals = emptyTotals();
  for (const file of listTranscripts(root)) {
    scanRows(parseTranscript(readFileSync(file, 'utf8')), totals);
  }
  const report = buildReport(totals, root);
  assert.equal(report.sessions, 2);
  assert.equal(report.sherpaInjections, 1);
  assert.equal(report.usage.inputSideTokens, 6400);
  assert.equal(report.usage.assistantTurns, 3);
  assert.match(report.tokenEstimator, /chars \/ 3\.5/);
});
