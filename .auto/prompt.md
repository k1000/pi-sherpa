# Sherpa research loop

Two completed stages, one active.

## Stage 1 (closed) — deterministic selection quality
Benchmark: `bun bench/ranking-bench.ts` (frozen `bench/fixture.json`).
Metric `label_loss` = (1 - missed_hit_rate) + noise_leak_rate, lower better.
Result: **0.7503 → 0.1513 (−79.8%)** over 29 experiments (20 keeps, 9 discards).
See `.auto/log.jsonl` runs 431–459. Remaining error is gaming-shaped or data-blocked;
do not reopen it without a changed assumption.

## Stage 2 (ACTIVE) — candidate-generation recall
Benchmark: `bun bench/retrieval-bench.ts` (frozen `bench/retrieval-fixture.json`).
Replays the deterministic file retrieval for each bundle:
`addExplicitPathCandidates` + `addRoutedFileCandidates` + `addIndicatorFileCandidates` + `retryFrontDoorFileCandidates`.

**Primary metric: `retrieval_recall_at_12`** = fraction of existing human-labeled
relevant paths that survive `postProcessCandidates(...).slice(0,12)` — what the
model actually sees (higher better). Raw `retrieval_recall` is a diagnostic only;
it over-counts candidates that are filtered downstream.
Baseline (2026-09-09, run #464): **0.0832** (79/950), raw recall 0.1032,
noise_rate 0.1348, 19.14 candidates/case.

Root cause already identified: `lib/rg.ts` `isUnsafeBroadSearchRoot()` refuses to
search `os.homedir()`, and this workspace's cwd IS the home directory, so the
indicator/routed/retry file searches return nothing. Candidate generation is
currently limited to explicit paths in the prompt.

## Rules
- Improvements must be general mechanisms (scoped search roots, better indicator
  extraction, filename matching), not per-path hardcoding.
- **Anti-gaming:** `retrieval_noise_rate` (fraction of human-labeled noise paths
  surfaced) and `retrieval_candidates_per_case` are tracked.
  Refined guard (2026-09-09, run #462): a recall gain is rejected if it is
  obtained by unbounded flooding. Concrete bounds: `retrieval_candidates_per_case`
  must stay within the downstream budget (postProcessCandidates caps the LLM pool
  at 12, so ≤~24/case) and `retrieval_noise_rate` must stay ≤~25%. Raw recall is
  a proxy; the next benchmark revision must add recall@12 after ranking so the
  flooding question is settled empirically.
- `.auto/checks.sh` must stay green: all `tests/*.test.ts` + `scripts/check-extension.ts`.
- Never edit `bench/retrieval-fixture.json` or `bench/fixture.json` to change a metric.
- Never tune on holdout data (see `.auto/ideas.md`).
