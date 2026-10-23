/**
 * Representative evaluation tasks. Each task copies its `initial` fixture into a
 * temp workspace, the agent is prompted, and `check(dir)` decides success against
 * the resulting files. A matching `solution` fixture lets the self-test verify the
 * check passes on a correct result and fails on the untouched initial state.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface Task {
  id: string;
  title: string;
  /** Fixture folder under eval/fixtures/<id> with initial/ and solution/ subtrees. */
  fixture: string;
  prompt: string;
  check: (dir: string) => Promise<CheckResult>;
}

/** Run `tsc --noEmit` on a copied fixture using eval's own TypeScript. */
async function tscPasses(dir: string): Promise<CheckResult> {
  try {
    await execFileAsync("npx", ["--no-install", "tsc", "--noEmit", "-p", join(dir, "tsconfig.json")], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    return { pass: true, detail: "tsc clean" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    return { pass: false, detail: out.split("\n").slice(0, 4).join(" · ") || "tsc failed" };
  }
}

async function fileText(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), "utf8").catch(() => "");
}

export const tasks: Task[] = [
  {
    id: "fix-type-errors",
    title: "Fix the two type errors",
    fixture: "fix-type-errors",
    prompt:
      "src/main.ts has two TypeScript type errors. Fix them so `tsc --noEmit` passes. " +
      "Do not change the public API of src/cart.ts.",
    check: tscPasses,
  },
  {
    id: "rename-and-fix",
    title: "Rename calc → cartTotal everywhere and fix the type errors",
    fixture: "rename-and-fix",
    prompt:
      "Rename the function `calc` to `cartTotal` everywhere (its definition in src/cart.ts and all " +
      "usages), then fix the two existing type errors so `tsc --noEmit` passes.",
    check: async (dir) => {
      const tsc = await tscPasses(dir);
      if (!tsc.pass) return tsc;
      const cart = await fileText(dir, "src/cart.ts");
      const main = await fileText(dir, "src/main.ts");
      if (/\bcalc\b/.test(cart) || /\bcalc\b/.test(main)) {
        return { pass: false, detail: "old name `calc` still present" };
      }
      if (!/\bcartTotal\b/.test(cart) || !/\bcartTotal\b/.test(main)) {
        return { pass: false, detail: "`cartTotal` not found in both files" };
      }
      return { pass: true, detail: "tsc clean and rename complete" };
    },
  },
  {
    id: "multi-file-rename",
    title: "Rename getUser → fetchUser across the whole project",
    fixture: "multi-file-rename",
    prompt:
      "Rename the function `getUser` to `fetchUser` across the entire project — its definition in " +
      "src/user.ts and every import and call site in the other files. `tsc --noEmit` must stay clean.",
    check: async (dir) => {
      const tsc = await tscPasses(dir);
      if (!tsc.pass) return tsc;
      const srcDir = join(dir, "src");
      const files = (await readdir(srcDir, { recursive: true })).filter((f) => String(f).endsWith(".ts"));
      let stale = 0;
      let renamedDef = false;
      for (const f of files) {
        const text = await readFile(join(srcDir, String(f)), "utf8");
        if (/\bgetUser\b/.test(text)) stale += 1;
        if (/export function fetchUser\b/.test(text)) renamedDef = true;
      }
      if (stale > 0) return { pass: false, detail: `old name getUser still in ${stale} file(s)` };
      if (!renamedDef) return { pass: false, detail: "fetchUser definition not found" };
      return { pass: true, detail: `tsc clean and getUser renamed across ${files.length} files` };
    },
  },
  {
    id: "tdd-loop",
    title: "Make the failing classify() tests pass",
    fixture: "tdd-loop",
    prompt:
      "classify.test.mjs has failing tests for `classify(n)` in classify.mjs (it should return " +
      '"positive", "negative" or "zero"). Implement classify so `node --test` passes. Do not edit the test file.',
    check: async (dir) => {
      // Strip NODE_TEST_CONTEXT so a child `node --test` prints a normal summary even
      // when this check runs inside node's own test runner (the self-test).
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      let out: string;
      try {
        const res = await execFileAsync("node", ["--test"], { cwd: dir, env });
        out = `${res.stdout}${res.stderr}`;
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
      // node --test uses the spec reporter ("ℹ pass N") or TAP ("# pass N") depending on
      // context; match the count regardless of prefix.
      const pass = Number(out.match(/pass (\d+)/)?.[1] ?? 0);
      const fail = Number(out.match(/fail (\d+)/)?.[1] ?? 1);
      if (pass >= 3 && fail === 0) return { pass: true, detail: `node --test: ${pass} passing` };
      return { pass: false, detail: `node --test: ${pass} pass / ${fail} fail` };
    },
  },
];

export function getTask(id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}
