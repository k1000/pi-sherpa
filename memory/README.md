# Sherpa Memory

Sherpa owns long-term agent memory.

## ContextSignal

Sherpa retrieval now uses a structured internal `ContextSignal` before rendering markdown. The signal separates retrieval/curation from presentation and records what Sherpa believes should happen next.

Minimal v1 shape:

```ts
type ContextSignalV1 = {
  version: "1";
  focus: string;
  taskType: string;
  confidence: number;
  disposition:
    | { kind: "answer_directly"; reason: string }
    | { kind: "small_edit"; reason: string; editPlan: SmallEditPlan }
    | { kind: "provide_context"; reason: string }
    | { kind: "abstain"; reason: string };
  proposedResponse?: {
    kind: "answer" | "edit_plan" | "context";
    content: string;
    citations: Array<{ source: string; handle?: string }>;
    caveats: string[];
  };
  items: Array<{
    handle: string;
    type: string;
    source: string; // canonical pointer, e.g. repo://src/file.ts:42
    relevance: number;
    summary: string;
    why: string;
    inline?: string;
  }>;
  risks: string[];
  missingInfo: string[];
  suggestedCommands: Array<{ command: string; reason: string }>;
  diagnostics: { sourcesSearched: string[]; candidateCount: number; selectedCount: number };
};
```

Rules:

- `source` is canonical; do not add redundant `path`, `lines`, or `url` fields in v1.
- `answer_directly` and `small_edit` are proposals for main-agent review.
- Sherpa should not silently edit files from front-door context injection.
- Use `provide_context` for complex tasks requiring main-agent tools or judgment.

## Task Lifecycle Classification

On `agent_end`, Sherpa classifies the recent task outcome as `completed`, `partial`, `blocked`, `failed`, `reverted`, or `unknown`. It records a concise lifecycle summary in the project scratchpad with changed files and minimal verification advice. This gives later sessions a compact working trail without dumping full conversations into context.

## Post-task Verification Advice

Sherpa maps changed files to likely verification commands, such as TypeScript typecheck, worker typecheck, Python tests, schema migration generation review, or Sherpa extension bundling. These are suggestions for the main agent; Sherpa should not automatically run expensive or mutating checks unless invoked through safe automation.

## Scratchpad Compaction

Sherpa keeps `.pi-memory/scratchpad` ephemeral. Oversized scratchpad section files are compacted by moving older content to `.pi-memory/scratchpad/archive/` and keeping the recent tail plus an archive pointer. Durable lessons must still be promoted to Obsidian rather than left in scratchpad.

## Automatic Documentation Audit

On `agent_end`, Sherpa checks `git status --short`. If source/config files changed but no documentation files changed, Sherpa:

1. records a repo-local scratchpad todo under `scratchpad/sections/todo.md`,
2. finds likely docs to review from `README.md` and `docs/`, and
3. sends a `sherpa-doc-audit` steer message so the main agent can update docs or explicitly decide no doc update is needed.

You can also run the same check manually with `/sherpa:docs:audit`.

This is intentionally review-based: Sherpa does not silently rewrite documentation from a lifecycle hook. It makes documentation drift visible and hands the update to the main agent.

## Automatic Automation Synthesis

On `agent_end`, Sherpa scans recent tool/session history for repeated commands and deterministic workflows. Repeated safe workflows become automation candidates in the project scratchpad. Sherpa prefers project-language-native automation:

- TypeScript/JavaScript projects: `scripts/*.ts`, `scripts/*.js`, or `package.json` scripts.
- Python projects: `scripts/*.py` or package-native CLI entrypoints.
- Shell scripts only as thin wrappers/glue unless the repo is shell-first.

Sherpa discovers runnable automations from root `package.json` scripts and repo-local `scripts/*.{sh,js,mjs,cjs,ts,tsx,py}`. Scripts may include `@sherpa-*` metadata (`purpose`, `timeout`, `env`, `side-effects`, `safe`) in their leading comment block. The `sherpa_run_automation` tool may run only automations classified as `safe`; deployment, git push/history mutation, DB mutation, deletion, and production/network operations require explicit approval and are refused by the tool. Sherpa records lightweight run telemetry (runs, failures, last status, duration, timestamp, short error) to prefer proven automations and expose flaky helpers.

Documentation paths include README/CHANGELOG/CONTRIBUTING/architecture/design/ADR/PRD files, `docs/` or `documentation/` trees, and markdown-like files. Source/config paths include common code and config extensions but exclude docs, build outputs, node_modules, git internals, and Sherpa memory artifacts.

## Layers

- `memory/.l2_facts/` — global fallback facts bundled with the Sherpa extension.
- `memory/.l3_skills/` — global fallback reusable patterns/SOPs bundled with the Sherpa extension.
- `/Users/kamil/Documents/articles/projects/<ProjectName>/` — project long-term memory in Obsidian using the semantic ontology:
  - `schema.md` — operating contract for maintenance.
  - `catalog.csv` — human-and-machine readable page registry, routes, aliases, tags, and typed relationships.
  - `journal/` — append-only idea development, session narrative, and maintenance history.
  - `wiki/systems/` — long-lived components and subsystems.
  - `wiki/procedures/` — repeatable workflows, verification steps, and reusable operational skills.
  - `wiki/decisions/` — ADR-style choices, rationale, and consequences.
  - `wiki/concepts/` — stable concepts, invariants, and mental models.
  - `wiki/evidence/` — experiments, reports, and proof supporting other pages.
  - `journal/` — dated development of ideas and chronological session narrative.
  - `inbox/` — uncertain auto-candidates awaiting promotion into `wiki/`.
  - `sources/` — source snapshots or mirrored source truth when useful.
- `<repo>/.pi-memory/scratchpad/` — repo-local transient scratchpad notes and distillation candidates.
- Legacy repo-local `.pi-memory/.l2_facts`, `.l3_skills`, `.l4_sessions` and Obsidian buckets (`facts/`, `skills/`, `sessions/`, `artifacts/`, `decisions/`, `scratchpad/`) are not part of the new project memory structure. Sherpa should not create, redirect to, or retrieve durable project memory from them by default.
- `<repo>/routes.csv` — repo-root Sherpa router mapping task triggers to important code/docs/knowledge artifacts.

## Router

Sherpa creates `routes.csv` at the repository root on project initialization when missing. The router is intentionally project-owned and editable. It should be reviewed like documentation: when important docs, apps, package roots, generated reports, or knowledge artifacts move or appear, update `routes.csv` so future retrieval starts in the right place.

It contains CSV rows with this shape:

```csv
name,triggers,read,docs,skip
Workers and scheduler,worker|scheduler|queue,apps/workers/src|packages/domains/workers,docs/clearworkers-services-report.md,node_modules|.next
```

Use `|` inside cells for lists.

Retrieval uses matching route triggers to prioritize high-signal roots before generic search.

Router rules:

- Keep it at `<repo>/routes.csv`.
- Do not store long-term facts there; route to where facts live.
- Prefer stable directories and canonical docs over transient files.
- Include skip paths for generated/noisy folders.
- Route-specific `Docs:` should list the most useful knowledge artifacts for that domain.

## Commands

```bash
/sherpa:docs:audit
/sherpa:memory:status
/sherpa:recall <query>
/sherpa:sync-reflect [--dry-run] [--destination obsidian|project|scratchpad]
```

## TypeScript backend

Sherpa memory no longer depends on Python subprocesses. Runtime memory operations live in TypeScript modules:

- `lib/memory.ts` — recall and Reflect sync.
- `lib/project-kb.ts` — repo-local scratchpad/scaffold initialization; legacy `.l2/.l3/.l4` layers are compatibility-only.
- `lib/route-map.ts` — root `routes.csv` generation and parsing; markdown route maps are still parseable for old repos.
- `prompts/DOCUMENTATION.md` — documentation drift audit and maintenance policy.

Legacy Python scripts were removed from the runtime path. Do not add new Python memory backends; keep Sherpa single-runtime under Node/TypeScript.

## Migration

This directory supersedes `skills/generic-agent/memory/`. The old skill is retained only as a compatibility wrapper during migration.
