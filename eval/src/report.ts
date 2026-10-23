/** Build a Markdown comparison report from aggregated per-task, per-mode results. */
import { averageMetrics, type RunMetrics } from "./metrics.ts";

export type Mode = "baseline" | "mystique";

export interface TrialResult {
  task: string;
  mode: Mode;
  trial: number;
  metrics: RunMetrics;
  pass: boolean;
  detail: string;
  durationMs: number;
  exitCode: number | null;
}

export interface AggregateRow {
  task: string;
  mode: Mode;
  trials: number;
  successRate: number;
  avg: RunMetrics;
  avgDurationMs: number;
}

export function aggregate(results: TrialResult[]): AggregateRow[] {
  const rows: AggregateRow[] = [];
  const keys = [...new Set(results.map((r) => `${r.task}\u0000${r.mode}`))];
  for (const key of keys) {
    const [task, mode] = key.split("\u0000") as [string, Mode];
    const group = results.filter((r) => r.task === task && r.mode === mode);
    rows.push({
      task,
      mode,
      trials: group.length,
      successRate: group.filter((r) => r.pass).length / group.length,
      avg: averageMetrics(group.map((r) => r.metrics)),
      avgDurationMs: group.reduce((s, r) => s + r.durationMs, 0) / group.length,
    });
  }
  return rows;
}

const n0 = (x: number) => Math.round(x).toLocaleString();

function pct(from: number, to: number): string {
  if (from === 0) return to === 0 ? "0%" : "n/a";
  const d = ((to - from) / from) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
}

export function renderReport(results: TrialResult[], meta: { model?: string; when?: string } = {}): string {
  const rows = aggregate(results);
  const tasks = [...new Set(rows.map((r) => r.task))];
  const out: string[] = [];
  out.push("# Mystique evaluation", "");
  out.push(`- when: ${meta.when ?? new Date().toISOString()}`);
  if (meta.model) out.push(`- model: ${meta.model}`);
  out.push(`- tasks: ${tasks.length}`, "");
  out.push("Lower tokens / tool-calls is better; success rate should stay at 100%.", "");
  out.push("| Task | Mode | Success | Tokens | Tool calls | Turns | Cost ($) | Duration |");
  out.push("|---|---|---|--:|--:|--:|--:|--:|");
  for (const task of tasks) {
    for (const mode of ["baseline", "mystique"] as Mode[]) {
      const r = rows.find((x) => x.task === task && x.mode === mode);
      if (!r) continue;
      out.push(
        `| ${task} | ${mode} | ${(r.successRate * 100).toFixed(0)}% (${r.trials}) | ` +
        `${n0(r.avg.totalTokens)} | ${r.avg.totalToolCalls.toFixed(1)} | ` +
        `${r.avg.turns.toFixed(1)} | $${r.avg.costUsd.toFixed(4)} | ${(r.avgDurationMs / 1000).toFixed(1)}s |`,
      );
    }
  }
  out.push("", "## Mystique vs baseline (Δ)", "");
  out.push("| Task | Tokens Δ | Tool calls Δ |");
  out.push("|---|--:|--:|");
  for (const task of tasks) {
    const b = rows.find((x) => x.task === task && x.mode === "baseline");
    const m = rows.find((x) => x.task === task && x.mode === "mystique");
    if (!b || !m) continue;
    out.push(`| ${task} | ${pct(b.avg.totalTokens, m.avg.totalTokens)} | ${pct(b.avg.totalToolCalls, m.avg.totalToolCalls)} |`);
  }
  out.push("");
  return out.join("\n");
}
