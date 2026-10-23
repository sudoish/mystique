import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { averageMetrics, parseJsonlMetrics } from "../src/metrics.ts";

const sample = readFileSync(fileURLToPath(new URL("../samples/sample-run.jsonl", import.meta.url)), "utf8");

test("parseJsonlMetrics sums per-turn usage and counts tool calls", () => {
  const m = parseJsonlMetrics(sample);
  assert.equal(m.turns, 3);
  assert.equal(m.totalTokens, 650); // 140 + 230 + 280
  assert.equal(m.inputTokens, 560); // 100 + 200 + 260
  assert.equal(m.outputTokens, 90); // 40 + 30 + 20
  assert.equal(m.cacheReadTokens, 150); // 0 + 50 + 100
  assert.ok(Math.abs(m.costUsd - 0.009) < 1e-9);
  assert.equal(m.totalToolCalls, 3);
  assert.deepEqual(m.toolCalls, { nvim_view: 1, nvim_ex: 1, nvim_check: 1 });
  assert.equal(m.errorToolCalls, 1);
  assert.equal(m.stopReason, "end_turn");
  assert.equal(m.aborted, false);
});

test("parseJsonlMetrics tolerates blank lines and non-JSON noise", () => {
  const noisy = `not json\n\n${sample}\n   \noops`;
  const m = parseJsonlMetrics(noisy);
  assert.equal(m.totalTokens, 650);
  assert.equal(m.totalToolCalls, 3);
});

test("parseJsonlMetrics falls back to input+output when totalTokens is absent", () => {
  const stream = [
    '{"type":"message_start","message":{"role":"assistant"}}',
    '{"type":"message_update","usage":{"input":7,"output":3},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"x"}}',
    '{"type":"message_end","message":{"role":"assistant","stopReason":"end_turn"}}',
  ].join("\n");
  const m = parseJsonlMetrics(stream);
  assert.equal(m.totalTokens, 10);
});

test("averageMetrics means tokens and tool calls across trials", () => {
  const a = parseJsonlMetrics(sample);
  const b = parseJsonlMetrics(sample);
  const avg = averageMetrics([a, b]);
  assert.equal(avg.totalTokens, 650);
  assert.equal(avg.toolCalls.nvim_view, 1);
});

test("averageMetrics of an empty set is zeroed", () => {
  const avg = averageMetrics([]);
  assert.equal(avg.totalTokens, 0);
  assert.equal(avg.totalToolCalls, 0);
});
