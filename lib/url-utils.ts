/** URL normalization/extraction helpers used for source de-duplication. */

export function normalizeUrl(raw: string) {
  const cleaned = raw.trim().replace(/[)\].,;!?]+$/g, "");
  try {
    const u = new URL(cleaned);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^utm_/i.test(key) || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/g, "");
    return u.toString();
  } catch { return cleaned; }
}

export function extractUrls(text: string) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(/https?:\/\/\S+/g)) {
    const url = normalizeUrl(match[0]);
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}
