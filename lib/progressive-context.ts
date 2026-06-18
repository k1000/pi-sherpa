/**
 * Progressive Context Disclosure — Tiered context bundles.
 *
 * Ported from Hermes Agent's progressive disclosure pattern (L0→L1→L2).
 * Context items are delivered in tiers to minimize token overhead.
 *
 * Hermes pattern: L0 = name+description (~3K tokens index),
 * L1 = full content on demand, L2 = reference files.
 *
 * Sherpa adaptation:
 *   L0 — handle + 1-line summary + source pointer (~20-40 tokens each)
 *   L1 — snippet body up to token budget
 *   L2 — full file content (via explicit expandHandles)
 */

// ── Types ───────────────────────────────────────────────────────────

export type TierLevel = 0 | 1 | 2;

/**
 * A tiered context item. Augments the existing ContextItem with a tier level.
 */
export type TieredContextItem = {
  handle: string;
  type: string;
  source: string;
  relevance: number;
  summary: string;
  raw?: string;
  inline?: boolean;
  /** Tier level: 0=pointer, 1=snippet, 2=full content */
  tier: TierLevel;
  /** Character count of the full content (for display) */
  charCount?: number;
};

export type ProgressiveContextConfig = {
  /** Tokens per L0 item estimate. Default: 30 */
  l0TokenCost?: number;
  /** Maximum tokens for L0 items. Default: 400 (keeps index cheap) */
  l0MaxTokens?: number;
  /** Maximum tokens for L1 items. Default: 2000 */
  l1MaxTokens?: number;
  /** Maximum tokens per L1 snippet. Default: 600 */
  l1PerItemMaxTokens?: number;
};

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ProgressiveContextConfig = {
  l0TokenCost: 30,
  l0MaxTokens: 400,
  l1MaxTokens: 2000,
  l1PerItemMaxTokens: 600,
};

// ── Tier assignment ─────────────────────────────────────────────────

/**
 * Assign tier levels to a list of context items based on token budget.
 *
 * Strategy:
 * - First N items (determined by l0MaxTokens / l0TokenCost) get L1 (within budget)
 *   or L0 (over budget).
 * - Remaining items always get L0.
 * - Items with `inline: true` are always L2 (they're already resolved).
 * - Items explicitly requested via expandHandles get L2.
 *
 * Returns items sorted by relevance within each tier.
 */
export function assignTiers(
  items: Array<{
    handle: string;
    type: string;
    source: string;
    relevance: number;
    summary: string;
    raw?: string;
    inline?: boolean;
  }>,
  tokenBudget: number,
  expandHandles?: Set<string>,
  config?: ProgressiveContextConfig,
): TieredContextItem[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const l0Slots = Math.max(1, Math.floor(cfg.l0MaxTokens / cfg.l0TokenCost));
  const expandSet = expandHandles ?? new Set<string>();

  // Separate inline items (always L2)
  const inlineItems: TieredContextItem[] = [];
  const normalItems: typeof items = [];

  for (const item of items) {
    if (item.inline) {
      inlineItems.push({
        ...item,
        tier: 2,
        charCount: (item.raw ?? item.summary).length,
      });
    } else {
      normalItems.push(item);
    }
  }

  // Sort normal items by relevance descending
  normalItems.sort((a, b) => b.relevance - a.relevance);

  const result: TieredContextItem[] = [...inlineItems];
  let l1Budget = Math.min(cfg.l1MaxTokens, tokenBudget - inlineItems.length * cfg.l0TokenCost);
  let l0Given = 0;

  for (const item of normalItems) {
    const isExpanded = expandSet.has(item.handle);
    const itemTokenEstimate = estimateTokens(item.raw ?? item.summary);

    if (isExpanded) {
      // Explicit expansion request → L2
      result.push({
        ...item,
        tier: 2,
        charCount: (item.raw ?? item.summary).length,
      });
    } else if (l0Given < l0Slots && itemTokenEstimate > 0 && itemTokenEstimate <= cfg.l1PerItemMaxTokens && l1Budget >= itemTokenEstimate) {
      // Within the L1 budget window → L1 (snippet)
      result.push({
        ...item,
        tier: 1,
        charCount: (item.raw ?? item.summary).length,
      });
      l0Given++;
      l1Budget -= itemTokenEstimate;
    } else {
      // Beyond budget or too large → L0 (pointer)
      result.push({
        ...item,
        tier: 0,
        charCount: (item.raw ?? item.summary).length,
      });
      l0Given++;
    }
  }

  return result;
}

/**
 * Promote a handle from its current tier to L2.
 * Returns the promoted item or null if not found.
 */
export function promoteToL2(
  items: TieredContextItem[],
  handle: string,
): TieredContextItem | null {
  const idx = items.findIndex((item) => item.handle === handle);
  if (idx === -1) return null;

  const item = items[idx]!;
  const promoted: TieredContextItem = {
    ...item,
    tier: 2,
    charCount: (item.raw ?? item.summary).length,
  };
  items[idx] = promoted;
  return promoted;
}

/**
 * Format a single tiered item for display.
 */
export function formatTieredItem(item: TieredContextItem): string {
  const tierLabel = item.tier === 0 ? "🔗" : item.tier === 1 ? "📄" : "📑";
  const lines: string[] = [
    `${tierLabel} [${item.handle}] (tier=${item.tier}, rel=${item.relevance}) ${item.summary.slice(0, 120)}`,
  ];

  if (item.tier === 1 || item.tier === 2) {
    const content = (item.raw ?? item.summary).slice(0, 2000);
    if (content) lines.push(`\`\`\`\n${content}\n\`\`\``);
  }

  lines.push(`  Source: ${item.source}`);
  if (item.charCount) lines.push(`  Size: ${item.charCount} chars`);

  return lines.join("\n");
}

/**
 * Render a tiered context bundle as markdown.
 * L0 items are listed compactly; L1/L2 items include their content.
 */
export function renderTieredBundle(
  items: TieredContextItem[],
  bundleId: string,
  focus: string,
): string {
  const l0 = items.filter((i) => i.tier === 0);
  const l1 = items.filter((i) => i.tier === 1);
  const l2 = items.filter((i) => i.tier === 2);

  const parts: string[] = [
    `## Sherpa Context (${bundleId})`,
    `Focus: ${focus}`,
    `Items: ${items.length} (L0: ${l0.length}, L1: ${l1.length}, L2: ${l2.length})`,
    "",
  ];

  if (l0.length > 0) {
    parts.push("### 🔗 Quick references (L0)");
    parts.push("Expand any handle with `/sherpa:expand <handle>` or pass `expandHandles`.");
    parts.push("");
    for (const item of l0) {
      parts.push(`- **${item.handle}** (rel=${item.relevance}) — ${item.summary.slice(0, 100)}`);
      parts.push(`  \`Source: ${item.source}\``);
    }
    parts.push("");
  }

  if (l1.length > 0) {
    parts.push("### 📄 Snippets (L1)");
    parts.push("");
    for (const item of l1) {
      parts.push(formatTieredItem(item));
      parts.push("");
    }
  }

  if (l2.length > 0) {
    parts.push("### 📑 Full content (L2)");
    parts.push("");
    for (const item of l2) {
      parts.push(formatTieredItem(item));
      parts.push("");
    }
  }

  return parts.join("\n");
}

/**
 * Estimate how many tokens a text string consumes.
 * Rough heuristic: 1 token ≈ 4 characters for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
