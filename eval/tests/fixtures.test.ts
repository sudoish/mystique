/**
 * Validates the eval wiring without any LLM: every task's check must fail on the
 * untouched `initial` fixture and pass on the `solution` fixture. This guards the
 * fixtures and check functions so a real run's pass/fail signal is trustworthy.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { tasks } from "../src/tasks.ts";
import { makeWorkspace } from "../src/workspace.ts";

for (const task of tasks) {
  test(`[${task.id}] check FAILS on the initial fixture`, async () => {
    const dir = await makeWorkspace(task, "initial");
    try {
      const r = await task.check(dir);
      assert.equal(r.pass, false, `expected initial to fail the check, got: ${r.detail}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${task.id}] check PASSES on the solution fixture`, async () => {
    const dir = await makeWorkspace(task, "solution");
    try {
      const r = await task.check(dir);
      assert.equal(r.pass, true, `expected solution to pass the check, got: ${r.detail}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
