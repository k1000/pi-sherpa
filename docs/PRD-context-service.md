# PRD — Sherpa as a measured context service

- Status: draft for review
- Author: Hermes, evidence from live transcripts and from this repo's source (2026-11-22)
- Scope: `index.ts` (3 100 lines) + `lib/` (8 367 lines total), 7 tools, 6 hooks

## 1. What exists today (verified in source, not assumed)

- `before_agent_start` (index.ts:1749) plans sources, builds a bundle within `frontDoor.tokenBudget` (default 1 200), filters already-seen items, and injects `bundleMarkdown`. Abstains via `shouldAbstain` when the best relevance is under 0.4 (front-door).
- Router: `isTrivial` (lib/text-utils.ts:5) — prompt shorter than 24 chars and no code/error keywords → skip.
- Relevance: `score()` (lib/text-utils.ts:12) is a substring hit ratio over focus words; `curateWithLlm` reorders/rejects on top of it; `confidence` is carried on every bundle.
- Guard: `tool_result` (index.ts:1810) compresses `bash`/`run_experiment` output longer than `summarization.maxToolResultChars` (12 000 chars) into a handle via `llmSummarize` with `replacementBudget` (1 500); `/sherpa:expand <handle>` restores raw. `read` is deliberately exempt: "hiding source code makes review harder".
- Route map: `lib/route-map.ts` + `catalog.csv`, rows `{name, triggers, read, docs, skip, score}`.
- Tools: `sherpa_request_context` (schema: focus, taskType, tokenBudget, sources, expandHandles, searchOtherProjects, includeTaxonomy), `sherpa_memory_search`, `sherpa_session_search`, `sherpa_scratchpad_read`, `sherpa_scratchpad_append`, `sherpa_run_automation`, `sherpa_nudge`.
- Web: `lib/*` fetches Brave when `web.enabled` (default false), `maxResults` 5, `cacheTtlMs` 6 h.

So the mechanisms this PRD needs mostly exist. The gap is that none of them is measured, three of them decide with heuristics that are too blunt, and none of the outputs can be consumed by a script.

## 2. Evidence (98 pi sessions, 11 334 rows, 4 681 assistant turns)

Input-side paid tokens: 399 543 121 = 12 918 165 fresh + 386 624 956 cache read.

- bash — 3 000 results, amortized 111.0 M → **27.8 %** of paid input; median **215** tokens, p90 1 222, max 14 664
- read — 386 results, amortized 69.5 M → **17.4 %**; median 1 399, p90 5 444, max 14 498
- j01n — 786 results, 6.2 %; median 40
- codemode — 175 results, 0.8 %; median 67; 12 of 98 sessions; `searchTools` used 0 times, `models.classify` 0 times
- Sherpa injections: **0**, detected from the transcript record (`customType: "sherpa-context"`, the value at index.ts:391) rather than from text. The detector fires on the same corpus for `j01n` (995), `j01n-peer-spawn-budget` (2) and `codemode-store` (1), so this is a real zero: the extension was not active on the measured host and there is no evidence yet that it saves anything

Two conclusions the numbers force:

1. **Threshold-based compression cannot fix bash.** With a median of 215 tokens, almost no bash result ever crosses 12 000 chars — the 111 M comes from 3 000 small results each re-read across following turns. The lever is fewer calls and shorter results, not summarisation of big ones.
2. **`llmSummarize` is itself a cost.** Every intercepted result currently buys a model call. A cheap redirect (spill to file, return head+tail+path) achieves the same context saving with zero model tokens.

## 3. Goals

- G1 every turn Sherpa touches is attributable to a token number, provable on real transcripts
- G2 decisions that are currently substring-or-length heuristics move to typed classifiers with probabilities
- G3 Sherpa's output is consumable by scripts (codemode), not only by the model as prose
- G4 compression costs no model calls

Non-goals: replacing the chat model that distils bundles; blocking reads; auto-promoting DSPy candidates without a human gate; any change to Obsidian memory layout.

## 4. Requirements

### P0-1 Measurement (ships first, changes no behaviour)

Per turn, append one JSONL row to `.pi-memory/sherpa/metrics/<date>.jsonl`: `ts, sessionId, hook (front-door|explicit|tool_result), plannedSources, planner, items, injectedTokens, confidence, abstainReason, guardInterceptions, guardTokensAvoided, curationModelTokens`. Aggregation script: `scripts/sherpa-metrics.mjs` already reports the transcript-side baseline; extend it with the per-turn file. It distinguishes an injection (`customType: "sherpa-context"`) from assistant prose mentioning Sherpa, and charges a tool result to the assistant turns that strictly follow it — a result in the final turn costs zero. Both rules are pinned by `scripts/sherpa-metrics.test.mjs`.
Acceptance: `bun run metrics` prints today's injected tokens, abstention rate and guard savings from real files.

### P0-2 Capability detection instead of assumption

At load, detect `codemode` in `ctx.tools` and a `classifier` in `ctx.modelRegistry`. Every integration below degrades to current behaviour when missing and reports the degradation once per session — never throws into the transcript.
Acceptance: on a host without codemode and without a classifier, a full turn produces today's output plus one info line.

### P0-3 Route decisions move from implicit to explicit

`catalog.csv` gains an `action` column: `inject | script | skip`, default `skip` for unknown. `before_agent_start` only injects for `inject` rows; `script` rows contribute tool names plus pointers to the injected block; `skip` contributes nothing.
Acceptance: a unit test rejects rows missing `action`; a bundle built from a `script`-only route contains no page text and names `sherpa_request_context` verbatim.

### P0-4 `sherpa_request_context` becomes script-callable

Register with exposure `codemode` and add `mode: "inject" | "bundle"`. `bundle` returns `{sources: [{url, title, lines, confidence, handle}], tokens}` so a script can fan out, dedupe and trim before anything reaches the model. `inject` keeps today's markdown.
Rationale for `codemode` over `deferred`: in 175 historical scripts `searchTools` was called zero times, so a tool the model cannot see is a tool it will not find.
Acceptance: a codemode script calling `tools.sherpa_request_context({mode:"bundle"})` returns the structured bundle; with the tool absent the script fails with `isError` and a readable message.

### P1-1 Rework the existing guard (index.ts:1810)

- replace `llmSummarize` with spill-to-file plus bounded head+tail (no model call), keeping the handle and `/sherpa:expand` contract
- threshold in tokens (`chars / 3.5`, start 1 500) via `SHERPA_GUARD_TOKENS`, not chars
- keep `read` exempt — the current comment is right; the number that matters for read is amortisation, not size
- add per-turn result-volume cap: at most N tool results per turn above threshold get a handle, the rest spill silently with a path
Acceptance: replaying 200 historical results shows guard savings with zero added model tokens; a sliced sequential read still works after spill.

### P1-2 Classifier replaces the relevance heuristic

One `models.classify` call over candidates: per-source `relevant` with a short criterion, plus `bestSource` as a choice. `score()` stays only as a pre-filter to cut candidate count. `shouldAbstain` takes `probability` as input instead of a 0.4 constant on a hit-ratio score.
Acceptance: ≥ 85 % agreement with human labels on 100 cached pages; classifier tokens ≤ 10 % of the tokens saved by dropping sources; precision/recall per threshold recorded.

### P1-3 Classifier replaces `isTrivial`

`isTrivial` (lib/text-utils.ts:5) skips only prompts under 24 chars. Replace with one classify question on the prompt: `needsContext` (bool) + `kind` (choice: code, docs, web, session, none). False → abstain, one-line block.
Acceptance: on 100 historical prompts, correct abstention ≥ 90 %, false abstention on context-needing prompts < 5 %.

### P1-4 Confidence everywhere

No bundle without a confidence value; `bundleMarkdown` prints it; below the floor the block reads "no confident source" rather than a plausible digest. Codemode scripts get the same capability through `models.classify`, so policy lives in one place.
Acceptance: abstention rate and its correctness reported weekly from P0-1 metrics.

### P2-1 Cache becomes the eval set

`.pi` web cache already holds fetched pages. Use it as the fixture set for relevance and abstention evaluation; run in CI on prompt or threshold changes.
Acceptance: eval reports accuracy, token cost and a diff against the previous run; threshold changes without an eval diff fail review.

### P2-2 `dspy promote` gates on cost

Promotion requires quality not worse **and** injected tokens lower, from recorded P0-1 metrics. `dspy eval` alone measures prompt quality and says nothing about cost.
Acceptance: promote refuses a candidate without a metrics window and names the missing artefact.

## 5. Design decisions

1. Sherpa keeps the front door; its default payload shrinks to a plan and pointers. Injection is opt-in per route.
2. The cache stays in Sherpa: codemode scripts have no filesystem or network access, so a 6 h TTL cache cannot live in a script.
3. Classifier and chat model keep separate jobs — selection/routing/abstention versus distillation into prose.
4. Tokens, not chars or lines, define "too big": median read is 1 399 tokens and median bash 215, so a char threshold set for the first never fires for the second.
5. Redirect over block: a blocked legitimate read costs a debugging session; a redirected one costs one tool call.
6. `codemode.mode` stays `on`, never `only`: with `only` every trivial read becomes a script and our median read (1 399 tokens) does not repay the script overhead.
7. At most one nested Sherpa call per turn — codemode runs two workers with a 60 s queue and `before_agent_start` must never wait on it.

## 6. Risks

- classifier credentials do not exist on the metering host (auth.json providers: kimi-coding, zai, nvidia, qwen-token-plan, cheaperinference, openai empty, deepseek; `--list-models jev|clef|luna|decision` returns nothing) → P1-2..P1-4 blocked on a provider decision; P0 ships without them
- spill files accumulate → prune on session_shutdown, cap directory size
- classifier bias on Polish technical text is unmeasured → eval set must include PL pages before any threshold is frozen
- route-map `action` default `skip` can silently starve a project → first release logs every skip with its reason

## 7. Phasing

1. P0-1 metrics + P0-2 capability detection — no behaviour change, produces the baseline
2. P1-1 guard rework — independent, ships with replay evidence
3. P0-3 + P0-4 route actions and script-callable tool — behaviour change, gated by the baseline
4. P1-2..P1-4 classifiers — after a provider exists and the eval set is labelled
5. P2-1 + P2-2 eval and promotion gate

## 8. Open questions

1. Classifier provider: TypeSafe direct (`jev-latest`, tokens reported at no cost — best for a spike), OpenRouter (`typesafe/jev-1.14`, one key), Cloudflare Workers AI (`@cf/cloudflare/clef*`, needs an account token; ours is zone-scoped to byit.pl), or OpenAI (`gpt-6-luna`, API key, not a `/login` session).
2. Guard threshold: is 1 500 tokens a starting value anyone may raise, or does it need approval per repo?
3. `docs/` layout: this repo has none; PRD and baseline live in `docs/` unless they should go into `SHERPA_SYSTEM.md`.

## 9. State after #3 (`main@aecb7f2`)

Every line citation above was re-pinned to this commit. The refactor in #3 moved helpers out of `index.ts` (3 100 → 2 588 lines, 68 modules under `lib/`): `isTrivial` is `lib/text-utils.ts:5`, `score()` is `lib/text-utils.ts:12`, `SHERPA_CONTEXT_TYPE` is `index.ts:391`, `before_agent_start` is `index.ts:1749`, the `tool_result` guard is `index.ts:1810`.

Delivered by #3, so no longer this PRD's work:

- **Source planning.** `lib/source-planning.ts` returns a plan with `planner: heuristic | llm | override | fallback`, a confidence and the chosen sources (`files, git, docs, session, web, logs, project_memory, semble, graphify, inquirer`). An explicit, reasoned route decision now exists — for a retrieval call, not for the front door.
- **Retrieval feedback and novelty.** `lib/retrieval-feedback.ts` re-ranks from recorded evaluations; session novelty suppresses what the session already saw. This is the mechanism P2-1 would otherwise have had to invent.
- **Planner visibility.** The transcript UI prints `Planner: <x>; indicators: …`, a working precedent for P0-3's "log every skip with its reason".

Still open, checked against the same commit:

- **P0-2** — no `ctx.tools` or `ctx.modelRegistry` probe exists; the code assumes codemode where it matters.
- **P0-3** — `routes.csv` (in repo, 11 lines) has `name,triggers,read,docs,skip`; `catalog.csv` is read from the project memory root (`index.ts:273`, `lib/memory-index.ts:196`). Neither carries an `action` column.
- **P0-4** — `sherpa_request_context` (`index.ts:1840`) takes `focus, tokenBudget, sources, expandHandles`, with no `mode` and no `exposure`, so a codemode script cannot call it and cannot ask for structured refs.
- **P1-2..P1-4** — `lib/query-classifier.ts` is five boolean predicates over the prompt (`isCodePrompt`, `isSourceLookupPrompt`, `isTraceLogMetricsPrompt`, `isPiSherpaMetaDebugPrompt`, `allowsRepeatedMetaDebugContext`). Routing is still heuristic: no probability, no classifier model, no stored regression set.

In short: P0-1 (the reporter in this repo) and the retrieval half of P0-3 are done; the front door, the guard and the classifier are unchanged by #3.

