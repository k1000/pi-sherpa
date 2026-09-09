
## Deferred: out-of-sample holdout harness (built 2026-09-09, not yet viable)

Built and evaluated a holdout fixture from bundles absent from `bench/fixture.json`:
- `bench/build-holdout.py` — builds `bench/fixture-holdout.json` from traces+evaluations, excluding all main-fixture bundles.
- `bench/ranking-bench-holdout.ts` — imports `evaluate()` from `ranking-bench.ts`, prints `holdout_*` METRIC lines.
- Result: 23 cases, 73 missed labels, 0 noise labels; 70 of 73 labels were upstream misses; the 3 in-pool pairs scored 0/3 hit (holdout_label_loss = 1.0).

Why it is NOT a valid verification yet:
- Every one of the 23 holdout bundles was evaluated on 2026-09-09 (the same session that produced all 28 experiments) — labels are contaminated by this session.
- All 3 in-pool missed pairs are the same `.pi-memory/sherpa-traces` label on the repeated autoresearch instruction prompt, which `focusAllowsSherpaTraces` (run #456) deliberately filters. Tuning to it would be session-fitting.

Action when fresh data exists (any bundle evaluated after this session ends):
1. Re-create the two scripts above (they were reverted with the discard).
2. Run `python3 bench/build-holdout.py && bun bench/ranking-bench-holdout.ts`.
3. Require holdout_label_loss to stay near the main-fixture value before trusting the 80% gain.
4. Never select or tune a rule using holdout cases.

## Deferred: candidate-generation benchmark (the real bottleneck)

`upstream_miss_rate` is 0.93 on the main fixture and 0.96 on holdout: human-labeled missed paths almost never enter the candidate pool. Ranking cannot fix this. A retrieval-stage benchmark needs `init_experiment` with a new metric (baseline ≈ 0.07 recall) and a harness that replays candidate generation (file search, exact-path extraction, semble) against the same `missed` labels.

## Stage 2: recall@12 is the metric that matters (run #463, discarded)

Raw `retrieval_recall` over-counts: run #462 surfaced 101/950 labels (0.1063) with
19.15 candidates/case, but after `postProcessCandidates(...).slice(0,12)` only
37/950 (0.0389) survived into the pool the model actually sees. Most flooding is
filtered downstream, so raw recall rewards candidates that never reach the LLM.

Action for next iteration:
1. Re-run `init_experiment` with primary metric `retrieval_recall_at_12` (higher better).
2. Add to `bench/retrieval-bench.ts`: rank retrieved candidates through
   `postProcessCandidates(found.map(s => ({type:"file", source:s, summary:"", relevance:0.2})), focus, mode).slice(0,12)`
   and count labels present in that top-12 as `retrieval_recall_at_12`.
3. Keep the candidate cap (`topMatchesByQuality` in `lib/file-candidates.ts`, 8 indicator / 6 retry
   by indicator-hit count) — it cut candidates/case 19.15 → 5.69 and noise 0.135 → 0.124.
4. Optimize recall@12, not raw recall; volume and noise guards stay as secondary.

Baseline for recall@12 with the scoped Pi-agent search + cap: **0.0389** (37/950).
