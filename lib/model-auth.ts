import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { safeNotify } from "./tool-results";

/**
 * Sherpa side-model auth resolution and fallback notification.
 *
 * Extracted from index.ts. Resolves which model + credentials Sherpa should
 * use for inference (curate / indicator / source-plan stages), respecting the
 * privacy.allowRemoteModel and model.useMainPiModel config flags.
 */

export type SherpaModelAuth = { model: any; auth: any };

export type SherpaAuthState = {
  config?: {
    privacy?: { allowRemoteModel?: boolean };
    model?: { useMainPiModel?: boolean; provider?: string; id?: string };
  };
};

export function notifySherpaModelFallback(ctx: ExtensionContext, reason: string): void {
  // notification must not break retrieval
  safeNotify(ctx, `Sherpa sidecar model unavailable; using heuristic fallback: ${reason}`, "warning");
}

export async function getSherpaModelAuthWithReason(
  state: SherpaAuthState & { retrievalPrompt?: string },
  ctx: ExtensionContext,
): Promise<{ ok: true; value: SherpaModelAuth } | { ok: false; reason: string }> {
  const cfg = state.config ?? {};
  const privacy = cfg.privacy ?? {};
  const modelCfg = cfg.model ?? {};
  if (!privacy.allowRemoteModel && !modelCfg.useMainPiModel) {
    return { ok: false, reason: "remote model disabled by privacy.allowRemoteModel=false" };
  }
  const model = modelCfg.useMainPiModel ? ctx.model : ctx.modelRegistry.find(modelCfg.provider, modelCfg.id);
  if (!model) return { ok: false, reason: `model not found: ${modelCfg.provider}/${modelCfg.id}` };
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { ok: false, reason: `auth failed: ${(auth as any).error ?? model.provider}` };
  if (!auth.apiKey) return { ok: false, reason: `missing API key for ${model.provider}` };
  return { ok: true, value: { model, auth } };
}

export async function getSherpaModelAuth(
  state: SherpaAuthState & { retrievalPrompt?: string },
  ctx: ExtensionContext,
): Promise<SherpaModelAuth | undefined> {
  const result = await getSherpaModelAuthWithReason(state, ctx);
  return result.ok ? result.value : undefined;
}
