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

**Primary metric: `retrieval_recall` = surfaced_existing_missed / existing_missed (higher better).**
Baseline (2026-09-09): **0.0053** (5/950) — the stage that explains the ranking
benchmark's `upstream_miss_rate` of 0.93.

Root cause already identified: `lib/rg.ts` `isUnsafeBroadSearchRoot()` refuses to
search `os.homedir()`, and this workspace's cwd IS the home directory, so the
indicator/routed/retry file searches return nothing. Candidate generation is
currently limited to explicit paths in the prompt.

## Rules
- Improvements must be general mechanisms (scoped search roots, better indicator
  extraction, filename matching), not per-path hardcoding.
- **Anti-gaming:** `retrieval_noise_rate` (fraction of human-labeled noise paths
  surfaced) and `retrieval_candidates_per_case` are tracked. A recall gain that
  floods candidates (noise_rate or candidates/case spiking) must be rejected.
- `.auto/checks.sh` must stay green: all `tests/*.test.ts` + `scripts/check-extension.ts`.
- Never edit `bench/retrieval-fixture.json` or `bench/fixture.json` to change a metric.
- Never tune on holdout data (see `.auto/ideas.md`).
