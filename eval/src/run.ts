/**
 * Evaluation harness. For each task × mode × trial it copies the fixture into a
 * temp workspace, runs pi non-interactively (`pi --mode json`) against it, parses
 * the JSONL event stream for token/tool metrics, then runs the task's success
 * check on the resulting files. Baseline = plain pi (built-in file tools);
 * Mystique = pi with only the extension loaded, driving a headless Neovim.
 *
 *   npx tsx src/run.ts --model <pattern> --trials 3 --tasks fix-type-errors
 *
 * Requires a configured pi + model (real API calls) and, for the Mystique mode,
 * `nvim` on PATH. Writes results/latest.json and results/latest.md.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlMetrics } from "./metrics.ts";
import { type Mode, renderReport, type TrialResult } from "./report.ts";
import { type Task, tasks as allTasks } from "./tasks.ts";
import { makeWorkspace } from "./workspace.ts";

const piBin = process.env.PI_BIN ?? "pi";
const extensionPath = fileURLToPath(new URL("../../extension/index.ts", import.meta.url));
const resultsDir = fileURLToPath(new URL("../results", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  tasks: string[];
  modes: Mode[];
  trials: number;
  model?: string;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { tasks: [], modes: ["baseline", "mystique"], trials: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tasks") o.tasks = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--modes") o.modes = (argv[++i] ?? "").split(",").filter(Boolean) as Mode[];
    else if (a === "--trials") o.trials = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--model") o.model = argv[++i];
  }
  return o;
}

/** Spawn a dedicated headless Neovim for a Mystique-mode run; returns its socket + cleanup. */
async function startNvim(cwd: string): Promise<{ socket: string; stop: () => void }> {
  const socket = join(tmpdir(), `mystique-eval-${process.pid}-${Date.now().toString(36)}.sock`);
  const proc = spawn("nvim", ["--headless", "-n", "-u", "NONE", "--listen", socket], { cwd, stdio: "ignore" });
  const deadline = Date.now() + 15000;
  while (!existsSync(socket)) {
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("headless nvim did not create its socket in time");
    }
    await sleep(100);
  }
  return {
    socket,
    stop: () => {
      proc.kill("SIGKILL");
      if (existsSync(socket)) rmSync(socket, { force: true });
    },
  };
}

function runPi(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 300000): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(piBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", () => { });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, code }); });
    child.on("error", () => { clearTimeout(timer); resolve({ stdout, code: -1 }); });
  });
}

async function runTrial(task: Task, mode: Mode, trial: number, model?: string): Promise<TrialResult> {
  const dir = await makeWorkspace(task, "initial");
  let nvim: { socket: string; stop: () => void } | undefined;
  const started = Date.now();
  try {
    const args = ["--mode", "json", "--no-session", "--no-extensions", "--approve"];
    if (model) args.push("--model", model);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (mode === "mystique") {
      nvim = await startNvim(dir);
      env.MYSTIQUE_SOCKET = nvim.socket;
      env.MYSTIQUE_SPEED = "fast";
      args.push("-e", extensionPath);
    }
    args.push(task.prompt);
    const { stdout, code } = await runPi(dir, args, env);
    const metrics = parseJsonlMetrics(stdout);
    const check = await task.check(dir);
    return {
      task: task.id,
      mode,
      trial,
      metrics,
      pass: check.pass,
      detail: check.detail,
      durationMs: Date.now() - started,
      exitCode: code,
    };
  } finally {
    nvim?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const selected = opts.tasks.length ? allTasks.filter((t) => opts.tasks.includes(t.id)) : allTasks;
  if (selected.length === 0) {
    console.error(`No matching tasks. Available: ${allTasks.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }
  const results: TrialResult[] = [];
  for (const task of selected) {
    for (const mode of opts.modes) {
      for (let trial = 1; trial <= opts.trials; trial++) {
        process.stderr.write(`▶ ${task.id} / ${mode} / trial ${trial}…\n`);
        const r = await runTrial(task, mode, trial, opts.model);
        process.stderr.write(
          `  ${r.pass ? "✓" : "✗"} ${r.detail} · ${Math.round(r.metrics.totalTokens)} tok · ${r.metrics.totalToolCalls} tools · ${(r.durationMs / 1000).toFixed(1)}s\n`,
        );
        results.push(r);
      }
    }
  }
  await mkdir(resultsDir, { recursive: true });
  const md = renderReport(results, { model: opts.model });
  await writeFile(join(resultsDir, "latest.json"), JSON.stringify(results, null, 2));
  await writeFile(join(resultsDir, "latest.md"), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
