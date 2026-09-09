# Sherpa deterministic-selection research loop

## Goal
Raise the quality of Sherpa's **deterministic** candidate ranking/selection stage
(`lib/candidate-postprocess.ts`, `lib/noise-filter.ts`, `lib/source-guards.ts`,
`lib/context-selection.ts`), because that path runs on ~54% of real traces
(heuristic curator) and gates everything the LLM curator sees.

## Benchmark
`bun bench/ranking-bench.ts` — replays frozen real candidate pools
(`bench/fixture.json`, built by `bench/build-fixture.py` from
`/Users/kamil/.pi-memory/sherpa-traces` + `projects/kamil/wiki/evidence/sherpa-evaluations`)
through `postProcessCandidates` and scores top-3 against human labels:
`missed[]` (should have surfaced) and `noise[]` (should not have surfaced).

## Primary metric
`label_loss = (1 - missed_hit_rate) + noise_leak_rate` — **lower is better**.
Baseline (2026-09-09): 0.7503 (missed_hit 0.7241, noise_leak 0.4745).

## Rules
- Improvements must be **general rules**, not fixture-specific hardcoding.
  No new regex that matches one exact fixture path.
- `noise_leak_rate` alone is trivially gamed by returning nothing; it is only
  scored together with `missed_hit_rate` in `label_loss`.
- `upstream_miss_rate` (0.93) is out of scope: those labels never reached the
  candidate pool, so ranking cannot recover them.
- `label_loss_dev` is a ~20% hold-out; if it degrades while `label_loss`
  improves, suspect overfitting.
- `.auto/checks.sh` must stay green: all `tests/*.test.ts` + `scripts/check-extension.ts`.
- Never touch `bench/fixture.json` to change the metric.
