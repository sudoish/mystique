/**
 * Representative evaluation tasks. Each task copies its `initial` fixture into a
 * temp workspace, the agent is prompted, and `check(dir)` decides success against
 * the resulting files. A matching `solution` fixture lets the self-test verify the
 * check passes on a correct result and fails on the untouched initial state.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
];

export function getTask(id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}
