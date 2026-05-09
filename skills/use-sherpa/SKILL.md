---
name: use-sherpa
description: "Use Sherpa for all context retrieval. Sherpa is the session firewall: it finds, ranks, and distills context so only high-signal output enters the session. This keeps the session clean and small. Use before any non-trivial task. Only bypass Sherpa when you are certain of the exact file path and line number."
---

# Use Sherpa — Session Firewall

**Rule: Sherpa first. Direct reads are the exception.**

Sherpa is the gatekeeper between raw files and the session. The session only sees Sherpa's distilled output. Reading files directly bypasses the firewall and pollutes context.

## When to Use Sherpa (Default)

Always use `sherpa_request_context` before:

- Editing any file you haven't recently read
- Fixing a bug — especially without an obvious cause
- Understanding an unfamiliar module or package
- Refactoring or adding a feature to existing code
- Answering questions about the codebase, architecture, or project conventions
- Any task where you need to find things across multiple files

## When Direct Tools Are OK (Exception)

You may use `read`, `grep`, or `bash` directly **only** when:

1. You already know the exact file path and line numbers (e.g. "fix line 42 of src/auth.ts")
2. You need one specific, small file whose content you know is relevant
3. Sherpa already returned a precise pointer with path + line range — then use `read` on exactly that range
4. You need to run a specific known command, not search for files

**You may NOT use direct tools to:**
- "Read all files in this directory to understand the structure"
- "Grep for all usages of X to understand how it's used"
- "Find files that contain Y"
- "Explore the codebase to understand it"

These are Sherpa's job.

## Delegating Simple Tasks to Sherpa

Use `sherpa_delegate` when the main session needs small support information without spending context/tool budget on rote inspection.

Good delegation tasks:

- route lookup: `kind: "routes"`
- safe automation inventory: `kind: "automations"`
- post-change verification advice: `kind: "verification"`
- documentation drift check: `kind: "documentation"`
- scratchpad summary: `kind: "scratchpad"`
- task outcome classification: `kind: "outcome"`

Example:

```json
{
  "task": "Suggest verification for current changed files",
  "kind": "verification"
}
```

Use `sherpa_request_context` for broader retrieval. Use `sherpa_run_automation` only for safe registered automations.

## How to Call Sherpa

```json
{
  "focus": "what you need to know",
  "taskType": "bugfix|feature|refactor|analysis",
  "tokenBudget": 2000,
  "sources": ["files", "docs", "git"]
}
```

After getting the context, expand only handles you actually need:

```json
{
  "focus": "details for ctx-2",
  "expandHandles": ["ctx-2"],
  "tokenBudget": 2000
}
```

For memory queries, Sherpa returns current-project matches first and research matches second. Search other projects only when useful, and include the global taxonomy only when you need canonical labels/tags/relationships:

```json
{
  "focus": "read-side write-side memory split",
  "sources": ["project_memory"],
  "searchOtherProjects": true,
  "includeTaxonomy": true
}
```

## Retrieval Precision

- **Small context** (<900 chars): Sherpa returns it inline — use it directly
- **Large context**: Sherpa returns a pointer — use `read` only on that exact range
- **Never dump raw file contents into the session** without Sherpa distilling it first

## Sherpa's Memory Sources

Sherpa searches across all memory layers:

| Source | What's there |
|---|---|
| `files` | Codebase grep, file contents |
| `git` | Changed files, status, blame |
| `docs` | READMEs, AGENTS.md, project docs |
| `Obsidian` | `/Users/kamil/Documents/articles/pi-memory/` — cross-project insights |
| `reflect` | Recent captures from `~/.pi/reflect/index.jsonl` |

## Abstention

If Sherpa abstains (no useful context found):

- Narrow the focus — be more specific about what you need
- If still nothing: use direct tools but be disciplined about what you read
- Do not read large portions of the codebase without Sherpa distillation

## Anti-Patterns

These break the session firewall:

- ❌ `read` all files in a directory to "get context"
- ❌ `grep` the whole codebase then dump results into the session
- ❌ Running `find . -name "*.py" | xargs read` to explore
- ❌ "Let me just read this file to understand it" without Sherpa

These are fine:

- ✅ `sherpa_request_context` before starting a task
- ✅ `read` a file that Sherpa pointed to with exact line numbers
- ✅ Running a specific command Sherpa recommended
- ✅ `read` a single file you already know is relevant

## After Tasks

Sherpa is read-side plus scratchpad. Durable write-side memory is owned by Archivist.

After completing tasks with useful learnings, call `archivist_distill` to preserve lessons:

```
archivist_distill({
  trigger: "failure",
  task: "fix YAML frontmatter parsing",
  outcome: "Nested mappings with colons in YAML require double-quotes on the parent string...",
  domain: "python"
})
```

After `reflect_capture`, call `archivist_preserve` to route the lesson to the right memory destination:

```
archivist_preserve({
  refId: "ref_abc123",
  type: "pattern",
  title: "YAML descriptions with colons must be quoted",
  summary: "...",
  importance: "high",
  tags: ["yaml", "parsing"]
})
```
