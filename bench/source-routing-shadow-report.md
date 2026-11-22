# Laya source-routing shadow — 2026-09-30

**Decision: do not enable Laya on Sherpa's entry path yet.** This is an offline, synthetic, author-labelled diagnostic, not an independent holdout or a deployment gate. No live sources, Oracle settings, or web settings were changed.

- Runtime: `laya-mlx==0.1.0` in `~/.venvs/laya-mlx`; pinned cached `aac6fef/laya-mlx` checkpoint snapshot `20aed815fc6acde75733882e7ec0e3f28aeb9717` (FP16). The previous editable install pointed to a missing external-drive directory; reinstalling the packaged release restored `import laya_mlx`.
- Fixture: `source-routing-fixture.json` (`source-routing-shadow-v1`, 18 synthetic cases, SHA-256 `a65c78bccfc537768f8c4768a89752c48bab454a9a8bc0277c498efc7d5ed720`). Eight one-of route labels: web, repo code, repo docs, git, local project memory, Oracle Inquirer, session, mixed. Laya saw only the prompt and the fixed choice descriptions; it did not query any source.
- Model accuracy: **13/18**. Web-only misroute: **1/4** (`web-release` → `repo_code`, probability 0.3641). Oracle/local-memory cross-confusions: **0/4**, but `oracle-lesson` → `session` at **0.9151** probability. Two mixed-source prompts were both misclassified as single-source. At a predeclared 0.65 selected-choice-probability threshold, **12/18** would be accepted, with **one incorrect accepted route** (Oracle → session).
- Warm per-case inference: p50 **63–86 ms**, p95 **116–117 ms** across two runs; model load ~0.75 s. Latencies are local benchmark figures, not Pi front-door latency.
- Heuristic fallback reference, with all sources simulated enabled: **20/24** labelled required-source hits, **6** extra-source selections, and **1/4** web-only prompts with a local-source leak. This is **not** a comparison with the live Qwen source planner. Missing labels include the bare URL case and session history; some `semble` requirements are author choices rather than independently verified necessities.

Run offline (from `extensions/pi-sherpa`):

```sh
LAYA_PYTHON="$HOME/.venvs/laya-mlx/bin/python" \
LAYA_MODEL_PATH="$HOME/.cache/huggingface/hub/models--aac6fef--laya-mlx/snapshots/20aed815fc6acde75733882e7ec0e3f28aeb9717" \
bun bench/laya-source-routing.ts
```

Next evidence needed: independently labelled, representative real prompts, including multilingual/ambiguous requests and explicit external-only + Oracle/local-memory comparisons; measure live-planner baselines and end-to-end latency. Keep deterministic privacy, web-only, and explicit-source constraints regardless of any model score. The installed model classifies a **primary** source; a `mixed` label alone cannot specify which two sources to query.
