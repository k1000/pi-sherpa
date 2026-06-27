import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Shared tool result and notification helpers. */

export function toolTextResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export function toolErrorResult(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const debugStack = process.env.SHERPA_DEBUG_ERRORS === "1" && stack ? `\n\n${stack}` : "";
  return toolTextResult(`${prefix}: ${message}${debugStack}`, { error: message, stack });
}

export function safeNotify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error") {
  try {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  } catch { /* stale extension contexts must not break background work */ }
}
