/** Small text scoring/summarization helpers used by retrieval and rendering. */

export function approxTokens(s: string) { return Math.ceil(s.length / 4); }

export function isTrivial(text: string) { return text.trim().length < 24 && !/[/.]|error|fail|test|bug|fix|refactor|implement/i.test(text); }

export function score(text: string, focus: string) {
  const words = new Set(focus.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  let hits = 0; for (const w of words) if (text.toLowerCase().includes(w)) hits++;
  return words.size ? hits / words.size : 0.1;
}

export function summarize(raw: string, budgetChars = 700) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const important = lines.filter(l => /error|fail|exception|warning|todo|fixme|export |function |class |describe\(|it\(/i.test(l));
  const picked = (important.length ? important : lines).slice(0, 10).join("\n");
  return picked.length > budgetChars ? picked.slice(0, budgetChars - 1) + "…" : picked;
}

export function conciseSummary(text: string, max = 420): string {
  const single = text.replace(/\s+/g, " ").trim();
  const expandHint = single.match(/\s*\(expand with \/sherpa:expand ctx-\d+\)$/i)?.[0] ?? "";
  const body = expandHint ? single.slice(0, -expandHint.length).trim() : single;
  if (body.length + expandHint.length <= max) return single;
  const room = Math.max(80, max - expandHint.length - 1);
  return `${body.slice(0, room)}…${expandHint}`;
}
