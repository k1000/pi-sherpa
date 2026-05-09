# Pi Sherpa Extension

Sherpa is a Pi extension for context retrieval, scratchpad access, automation discovery, and read-side memory routing.

Project-memory retrieval is organized by scope: current project catalog results first, then general research documents from `research/<area>/`. Other project catalogs are searched only when `searchOtherProjects: true` is passed to `sherpa_request_context`. The global taxonomy (`/Users/kamil/Documents/articles/taxonomy.csv`) is optional retrieval context: include it with `includeTaxonomy: true`, or Sherpa includes it automatically for taxonomy/tag/category/relationship/nomenclature questions.

## Archivist boundary

Durable write-side bookkeeping has moved to Archivist. By default `writeSide.enabled` is `false`, so Sherpa no longer writes lifecycle memory, documentation-audit entries, reflection preservation, distillation output, or automation candidates. Sherpa remains responsible for read-side context delivery and the repo-local scratchpad tools.

Use Archivist replacements for write-side work:

- `archivist_preserve` instead of `sherpa_preserve`
- `archivist_distill` instead of `sherpa_distill`
- `archivist_run_automation` instead of `sherpa_run_automation`
- `/archivist:docs:audit` instead of `/sherpa:docs:audit`
- `/archivist:sync-reflect` instead of `/sherpa:sync-reflect`

## Model configuration

Sherpa uses a dedicated sidecar model unless `useMainPiModel` is explicitly enabled in `.pi/sherpa.config.json` or `~/.pi/sherpa.config.json`. This installation's global Sherpa config uses `minimax/MiniMax-M2.7-highspeed` so Sherpa stays aligned with Archivist while remaining separate from the main Pi model.

## Verification

Run the extension-local check script after prompt, memory, routing, automation, or lifecycle changes:

```bash
/Users/kamil/.pi/agent/extensions/pi-sherpa/scripts/check-extension.ts
```

This runs:

- all tests under `tests/*.test.ts`
- an esbuild bundle check for `index.ts`

The check script is intentionally stored with the extension, not in project repositories that only exercise Sherpa during testing.

