import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyMetrics, type RunMetrics } from "../src/metrics.ts";
import { aggregate, renderReport, type TrialResult } from "../src/report.ts";

function metrics(tokens: number, tools: number): RunMetrics {
  return { ...emptyMetrics(), totalTokens: tokens, totalToolCalls: tools, turns: 2 };
}

const results: TrialResult[] = [
  { task: "fix-type-errors", mode: "baseline", trial: 1, metrics: metrics(1000, 10), pass: true, detail: "", durationMs: 4000, exitCode: 0 },
  { task: "fix-type-errors", mode: "baseline", trial: 2, metrics: metrics(1200, 12), pass: true, detail: "", durationMs: 4000, exitCode: 0 },
  { task: "fix-type-errors", mode: "mystique", trial: 1, metrics: metrics(800, 6), pass: true, detail: "", durationMs: 5000, exitCode: 0 },
  { task: "fix-type-errors", mode: "mystique", trial: 2, metrics: metrics(900, 8), pass: false, detail: "", durationMs: 5000, exitCode: 0 },
];

test("aggregate averages trials and computes success rate", () => {
  const rows = aggregate(results);
  const base = rows.find((r) => r.mode === "baseline")!;
  const myst = rows.find((r) => r.mode === "mystique")!;
  assert.equal(base.avg.totalTokens, 1100);
  assert.equal(base.successRate, 1);
  assert.equal(myst.avg.totalTokens, 850);
  assert.equal(myst.successRate, 0.5);
});

test("renderReport produces a comparison table with a token delta", () => {
  const md = renderReport(results, { model: "test-model" });
  assert.match(md, /# Mystique evaluation/);
  assert.match(md, /model: test-model/);
  assert.match(md, /\| fix-type-errors \| baseline \|/);
  assert.match(md, /\| fix-type-errors \| mystique \|/);
  // 850 vs 1100 baseline ≈ -23%
  assert.match(md, /-23%/);
});
