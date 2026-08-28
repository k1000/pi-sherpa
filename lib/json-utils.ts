/** Lenient JSON extraction helpers for model responses. */

function jsonEnd(text: string, start: number): number {
  const stack = [text[start] === "{" ? "}" : "]"];
  let quoted = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return index;
    }
  }
  return -1;
}

function extractLastJsonObject(text: string): unknown {
  let parsed: unknown = null;
  for (let start = text.indexOf("{"); start !== -1;) {
    const end = jsonEnd(text, start);
    if (end === -1) {
      start = text.indexOf("{", start + 1);
      continue;
    }
    try { parsed = JSON.parse(text.slice(start, end + 1)); }
    catch { /* Continue scanning: model prose may contain malformed JSON before its final result. */ }
    // Advance past this complete object so nested objects cannot replace it.
    start = text.indexOf("{", end + 1);
  }
  return parsed;
}

export function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { return null; }
}

export function extractJsonObject(text: string): unknown {
  // Models may put JSON examples or reasoning before their actual final response.
  return extractLastJsonObject(text);
}
