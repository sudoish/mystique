/**
 * Parse a `pi --mode json` JSONL event stream into run metrics: billed tokens
 * (summed per assistant turn), tool-call counts by name, and the stop reason.
 * Pure and dependency-free so it can be unit-tested against recorded streams.
 * Event shapes: see pi docs/json.md.
 */

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface RunMetrics {
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  toolCalls: Record<string, number>;
  totalToolCalls: number;
  errorToolCalls: number;
  stopReason?: string;
  aborted: boolean;
}

export function emptyMetrics(): RunMetrics {
  return {
    turns: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    toolCalls: {},
    totalToolCalls: 0,
    errorToolCalls: 0,
    aborted: false,
  };
}

type Json = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function addUsage(m: RunMetrics, u: Usage): void {
  m.inputTokens += num(u.input);
  m.outputTokens += num(u.output);
  m.cacheReadTokens += num(u.cacheRead);
  m.cacheWriteTokens += num(u.cacheWrite);
  // Fall back to input+output when the provider omits a total.
  m.totalTokens += num(u.totalTokens) || num(u.input) + num(u.output);
  m.costUsd += num(u.cost?.total);
}

/** Compute metrics from already-parsed JSONL records. */
export function metricsFromEvents(events: Json[]): RunMetrics {
  const m = emptyMetrics();
  // The wire `usage` is cumulative per assistant response, so keep only the last
  // one seen within a response and bank it when that assistant message ends.
  let pendingRole: string | undefined;
  let lastUsage: Usage | undefined;

  for (const e of events) {
    switch (e.type) {
      case "message_start": {
        const role = (e.message as Json | undefined)?.role;
        if (role === "assistant") {
          pendingRole = "assistant";
          lastUsage = undefined;
        }
        break;
      }
      case "message_update": {
        if (pendingRole === "assistant" && e.usage) lastUsage = e.usage as Usage;
        break;
      }
      case "message_end": {
        const msg = e.message as Json | undefined;
        if (msg?.role === "assistant") {
          m.turns += 1;
          const usage = (msg.usage as Usage | undefined) ?? lastUsage;
          if (usage) addUsage(m, usage);
          if (typeof msg.stopReason === "string") m.stopReason = msg.stopReason;
          pendingRole = undefined;
          lastUsage = undefined;
        }
        break;
      }
      case "tool_execution_end": {
        const name = typeof e.toolName === "string" ? e.toolName : "unknown";
        m.toolCalls[name] = (m.toolCalls[name] ?? 0) + 1;
        m.totalToolCalls += 1;
        if (e.isError === true) m.errorToolCalls += 1;
        break;
      }
      case "agent_settled": {
        if (e.aborted === true) m.aborted = true;
        break;
      }
    }
  }
  return m;
}

/** Parse raw JSONL text (one JSON object per LF-delimited line). */
export function parseJsonlMetrics(jsonl: string): RunMetrics {
  const events: Json[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as Json);
    } catch {
      // Ignore non-JSON noise (pi reserves stdout for JSONL, but be defensive).
    }
  }
  return metricsFromEvents(events);
}

/** Average a set of per-trial metrics into mean token/tool/cost figures. */
export function averageMetrics(runs: RunMetrics[]): RunMetrics {
  const avg = emptyMetrics();
  if (runs.length === 0) return avg;
  const toolNames = new Set<string>();
  for (const r of runs) {
    avg.turns += r.turns;
    avg.totalTokens += r.totalTokens;
    avg.inputTokens += r.inputTokens;
    avg.outputTokens += r.outputTokens;
    avg.cacheReadTokens += r.cacheReadTokens;
    avg.cacheWriteTokens += r.cacheWriteTokens;
    avg.costUsd += r.costUsd;
    avg.totalToolCalls += r.totalToolCalls;
    avg.errorToolCalls += r.errorToolCalls;
    for (const k of Object.keys(r.toolCalls)) toolNames.add(k);
  }
  const n = runs.length;
  avg.turns /= n;
  avg.totalTokens /= n;
  avg.inputTokens /= n;
  avg.outputTokens /= n;
  avg.cacheReadTokens /= n;
  avg.cacheWriteTokens /= n;
  avg.costUsd /= n;
  avg.totalToolCalls /= n;
  avg.errorToolCalls /= n;
  for (const name of toolNames) {
    avg.toolCalls[name] = runs.reduce((s, r) => s + (r.toolCalls[name] ?? 0), 0) / n;
  }
  return avg;
}
