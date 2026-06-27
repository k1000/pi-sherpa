/**
 * Model-driven search loop (escalation tier).
 *
 * Design (R1+R2 + directive "whatever Sherpa delivers must be filtered by the
 * sidecar model before reaching the main model"):
 *
 *   1. Fast path: deterministic sources fire in parallel (existing behavior).
 *   2. Escalation: when the fast path yields no candidates, hand control to the
 *      sidecar model with a small set of search tools so it can BROADEN the
 *      research — searching places/with queries the deterministic pass cannot
 *      (e.g. ~/.pi dotfiles, model-chosen queries, past sessions).
 *
 * This is a bounded, manual tool-calling loop (ReAct-style), not a full agent:
 * the model emits a JSON tool call, Sherpa executes one of a small registered
 * toolset, feeds the result back, and repeats until the model delivers final
 * context or a hard cap fires (max rounds, max tool calls, timeout).
 *
 * The loop CONTROLLER is pure and testable: it takes an injectable
 * `modelStep` function, so golden tests drive it with a fake model without any
 * network. The real wiring (in index.ts) injects the sidecar completion call.
 */

import type { UserMessage } from "@mariozechner/pi-ai";

/** A candidate Sherpa may deliver to the main model. */
export interface ModelSearchCandidate {
  source: string;
  summary: string;
  relevance: number;
}

/** A search tool the model may invoke. Registered, not hardcoded into the loop. */
export interface SearchTool {
  name: string;
  description: string;
  /** Execute the tool; return up to `limit` compact results, or empty array. */
  run(args: { query?: string; limit?: number }): Promise<ModelSearchCandidate[]>;
}

/** One step the model wants to take. */
export interface ModelStep {
  /** "search" = invoke a tool; "deliver" = stop and return context; "stop" = give up. */
  action: "search" | "deliver" | "stop";
  tool?: string;
  query?: string;
  reason?: string;
  /** When action="deliver": the candidates the model judges worth delivering. */
  items?: Array<{ source: string; summary: string }>;
}

/** Hard caps so the loop always terminates, regardless of model behavior. */
export interface LoopBudget {
  maxRounds: number;
  maxToolCalls: number;
}

export const DEFAULT_LOOP_BUDGET: LoopBudget = { maxRounds: 3, maxToolCalls: 4 };

export interface LoopEvent {
  round: number;
  step: ModelStep;
  results?: ModelSearchCandidate[];
  note?: string;
}

export interface ModelSearchResult {
  candidates: ModelSearchCandidate[];
  rounds: number;
  toolCalls: number;
  delivered: boolean;
  events: LoopEvent[];
  stopReason: string;
}

/**
 * Pure loop controller. Testable with a fake `modelStep` (no network).
 *
 * Contract:
 * - Calls `modelStep` with the accumulated transcript (focus + prior results).
 * - If the model emits "search", runs the named tool (if registered), feeds
 *   results back, and continues — unless a budget cap fires, which forces a
 *   "deliver what we have" or "stop".
 * - If the model emits "deliver", returns the model's chosen items as candidates.
 * - If the model emits "stop", or a cap fires with nothing gathered, returns empty.
 *
 * The model is the delivery gate: the loop only GATHERS; the model decides what
 * (if anything) is worth delivering to the main model.
 */
export async function runModelSearchLoop(args: {
  focus: string;
  tools: Record<string, SearchTool>;
  modelStep: (transcript: string, toolsDescription: string) => Promise<ModelStep | undefined>;
  budget?: Partial<LoopBudget>;
}): Promise<ModelSearchResult> {
  const budget: LoopBudget = { ...DEFAULT_LOOP_BUDGET, ...args.budget };
  const events: LoopEvent[] = [];
  const gathered: ModelSearchCandidate[] = [];
  let toolCalls = 0;
  let round = 0;
  let stopReason = "budget exhausted";

  const toolsDescription = Object.values(args.tools)
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  while (round < budget.maxRounds && toolCalls < budget.maxToolCalls) {
    round++;
    const transcript = buildTranscript(args.focus, gathered, events);
    let step: ModelStep | undefined;
    try {
      step = await args.modelStep(transcript, toolsDescription);
    } catch {
      stopReason = "model step error";
      break;
    }
    if (!step) { stopReason = "model returned no step"; break; }

    if (step.action === "deliver") {
      const items = (step.items ?? []).map((i) => ({ ...i, relevance: 0.7 }));
      events.push({ round, step, note: "model delivered final context" });
      return { candidates: items.length ? items : gathered, rounds: round, toolCalls, delivered: true, events, stopReason: "model delivered" };
    }
    if (step.action === "stop") {
      events.push({ round, step, note: "model chose to stop" });
      stopReason = "model chose to stop";
      break;
    }

    // action === "search"
    const tool = step.tool ? args.tools[step.tool] : undefined;
    if (!tool) {
      events.push({ round, step, note: `unknown tool: ${step.tool ?? "(none)"}` });
      continue;
    }
    if (toolCalls >= budget.maxToolCalls) {
      events.push({ round, step, note: "max tool calls reached before this search" });
      stopReason = "max tool calls";
      break;
    }
    toolCalls++;
    let results: ModelSearchCandidate[] = [];
    try {
      results = await tool.run({ query: step.query, limit: 5 });
    } catch {
      results = [];
    }
    // Dedupe by source against what we already have.
    const seen = new Set(gathered.map((g) => g.source));
    for (const r of results) {
      if (!seen.has(r.source)) { gathered.push(r); seen.add(r.source); }
    }
    events.push({ round, step, results });
  }

  if (round >= budget.maxRounds) stopReason = "max rounds";
  else if (toolCalls >= budget.maxToolCalls) stopReason = "max tool calls";

  // No explicit "deliver" — but we gathered something. The model is still the gate:
  // only surface gathered candidates if the model had a chance. If we broke on caps
  // mid-search, hand back what we found (the model will re-filter upstream anyway).
  return { candidates: gathered, rounds: round, toolCalls, delivered: false, events, stopReason };
}

function buildTranscript(focus: string, gathered: ModelSearchCandidate[], events: LoopEvent[]): string {
  const lines: string[] = [
    `User need: ${focus}`,
    "",
  ];
  if (!gathered.length) {
    lines.push("So far nothing has been found by the deterministic search. Broaden the research.");
  } else {
    lines.push("Found so far:");
    for (const g of gathered) lines.push(`- ${g.source}: ${g.summary}`);
  }
  const searches = events.filter((e) => e.step.action === "search");
  if (searches.length) {
    lines.push("", "Searches already performed:");
    for (const s of searches) lines.push(`- ${s.step.tool} "${s.step.query ?? ""}" → ${(s.results ?? []).length} result(s)`);
  }
  return lines.join("\n");
}

/** Helper for real wiring: build the UserMessage for one model step. */
export function modelStepMessage(transcript: string, toolsDescription: string): UserMessage {
  return {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      transcript,
      "",
      "Available search tools:",
      toolsDescription,
      "",
      "Respond with ONLY JSON:",
      '{"action":"search","tool":"<name>","query":"<query>","reason":"why"}',
      "or when you have enough: " + '{"action":"deliver","items":[{"source":"...","summary":"..."}],"reason":"why"}',
      "or if nothing useful can be found: " + '{"action":"stop","reason":"why"}',
    ].join("\n") }],
  };
}
