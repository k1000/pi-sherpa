# Pi Sherpa Extension

Sherpa is a Pi extension for context retrieval, scratchpad access, automation discovery, and read-side memory routing.

Project-memory retrieval is organized by scope: current project catalog results first, then general research documents from `research/<area>/`. Distillation follows the same split: project-specific procedures live under the project's `wiki/procedures/`, while recognized cross-project domains such as `typescript`, `python`, `trading`, and `ai` route to `research/<area>/` unless an explicit target path is provided. Other project catalogs are searched only when `searchOtherProjects: true` is passed to `sherpa_request_context`. The global taxonomy (`/Users/kamil/Documents/articles/taxonomy.csv`) is optional retrieval context: include it with `includeTaxonomy: true`, or Sherpa includes it automatically for taxonomy/tag/category/relationship/nomenclature questions.

Exact source references are first-class retrieval hints: absolute paths, repo-relative paths, filenames, and handles are ranked ahead of fuzzy project-orientation matches.

## Retrieval evaluations

Each rendered context bundle includes a `Bundle: bundle-...` identifier. Use `/sherpa:evaluate [bundle-id] [outcome] [relevance] [precision] [recall] [reflection]` to persist a quality note under `wiki/evidence/sherpa-evaluations/`, and `/sherpa:evals` to summarize recent retrieval quality.

## DSPy-style prompt feedback

Sherpa records retrieval/curation traces to `.pi-memory/sherpa-traces/*.jsonl`. The current compiler is DSPy-style but dependency-light: it does **not** import the Python `dspy` package yet. It exports train/dev JSONL and compiles prompt-feedback artifacts from evaluation hints; the artifact shape is ready for a later real DSPy `BootstrapFewShot`/`MIPROv2` optimizer.

Auto-compile is guarded by quality gates so Sherpa does not learn from mostly bad data: at least 10 matched evaluations, average metric >= 0.65, and at least 3 high-scoring examples. Use these commands to build and safely promote compiled prompt guidance:

1. `/sherpa:dspy:compile` — export traces/evaluations and write a candidate artifact to `.pi/sherpa/compiled-candidates/retrieval.prompt.json` if quality gates pass. Use `--force` only to inspect a low-quality candidate; do not promote it.
2. `/sherpa:dspy:eval` — compare the candidate against the active compiled artifact metadata.
3. `/sherpa:dspy:promote` — copy the candidate into the active compiled prompt directory; existing active artifacts are backed up first.
4. `/sherpa:dspy:on` — enable compiled prompt loading from `.pi/sherpa/compiled/`.
5. `/sherpa:dspy:status` — show whether compiled/candidate retrieval prompts are available and active.
6. `/sherpa:dspy:off` — disable compiled prompt loading and fall back to regular prompt files.

The runtime path remains TypeScript-only. `scripts/optimize-sherpa-dspy.py` is an offline prompt-feedback compiler scaffold that can later be replaced with real DSPy `BootstrapFewShot` or `MIPROv2` while preserving the same `*.prompt.json` artifact shape.

## Archivist boundary

Durable write-side bookkeeping belongs to Archivist. Sherpa keeps:

- **Read-side retrieval** — context curation, front-door, explicit retrieval
- **Scratchpad** — repo-local `.pi-memory/scratchpad/` (todos, observations, issues, next steps, distillation candidates)
- **Automation** — discovery, `sherpa_run_automation`, `sherpa:automations`
- **Lifecycle tracking** — task outcome observation, changed-files logging, verification suggestions; Sherpa does not persist durable session memory via raw regex extraction

Archivist owns:

- **Preservation** — `archivist_preserve` (was `sherpa_preserve`)
- **Distillation** — `archivist_distill` (was `sherpa_distill`)
- **Documentation drift** — `/archivist:docs:audit`
- **Session-level memory** — `archivist:status`, `archivist:sync-reflect`

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
