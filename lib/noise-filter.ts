/**
 * Global source-noise filtering.
 *
 * Extracted from index.ts. Determines whether a candidate source is global noise
 * (shell rc files, caches, build/dist output, sqlite/db files, sherpa-internal
 * state, etc.) that should never reach the main model regardless of focus.
 *
 * Directly unit-tested by tests/global-noise.test.ts — keep that file green.
 */

export const GLOBAL_NOISY_SOURCE_PATTERNS = [
  /(?:^|\/)\.zcompdump[^/]*$/i,
  /(?:^|\/)\.zsh_history(?::\d+)?$/i,
  /(?:^|\/)\.(?:zshrc|bashrc|bash_profile|zprofile|profile|zshenv)(?::\d+)?$/i,
  /(?:^|\/)\.bun\//i,
  // Tool-state dot-directories: version managers, editor/AI tool state, and
  // their vendored extension trees. Never project context.
  /(?:^|\/)\.nvm\//i,
  /(?:^|\/)\.roo\//i,
  // Foreign agent tooling state (Claude Code config/skills).
  /(?:^|\/)\.claude\//i,
  /(?:^|\/)\.antigravity\//i,
  /(?:^|\/)\.mtplx\//i,
  /(?:^|\/)\.41d\//i,
  /(?:^|\/)\.pi\/understand-anything\//i,
  // Binary/image assets are never useful text context.
  /\.(?:svg|png|jpe?g|gif|webp|ico|bmp|tiff?)(?::\d+)?$/i,
  /(?:^|\/)\.cache\//i,
  /(?:^|\/)\.android\/cache\//i,
  /(?:^|\/)go\/pkg\/mod\//i,
  /(?:^|\/)\.ssh\//i,
  /(?:^|\/)node_modules\//i,
  /(?:^|\/)agent\/sessions\//i,
  /(?:^|\/)\.semgrep\//i,
  /(?:^|\/)logs?\//i,
  /(?:^|\/)\.cdk\/cache\//i,
  /(?:^|\/)library\/caches\//i,
  /(?:^|\/)\.omp\/logs\//i,
  /(?:^|\/)agent-disabled-extension-backups\//i,
  /(?:^|\/)extensions-disabled\//i,
  /(?:^|\/)extensions\.disabled\//i,
  /(?:^|\/)\.pi\/revolver\//i,
  /(?:^|\/)\.pi\/sherpa\//i,
  /(?:^|\/)graphify-out\//i,
  /(?:^|\/)\.fallow\//i,
  /(?:^|\/)\.pi-memory\/(?:session-search|memory-index).*\.(?:db|sqlite)/i,
  /(?:^|\/)(?:dist|build|coverage)\//i,
  /(?:^|\/)public\/.*\.bundle\.js(?::\d+)?$/i,
  /\.min\.js(?::\d+)?$/i,
  /\.bak(?:-[^/:]+)?(?::\d+)?$/i,
  /\.backup(?::\d+)?$/i,
  /\.(?:db|sqlite)(?::\d+)?$/i,
];

export function isGloballyNoisySource(source: string) {
  const normalized = source.replace(/^repo:\/\//, "").replace(/^file:\/\//, "").replace(/\\/g, "/").toLowerCase();
  return GLOBAL_NOISY_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}
