/** Copy a task fixture variant (initial|solution) into a fresh temp workspace. */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturesDir, type Task } from "./tasks.ts";

export async function makeWorkspace(task: Task, variant: "initial" | "solution"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mystique-eval-${task.id}-`));
  await cp(join(fixturesDir, task.fixture, variant), dir, { recursive: true });
  return dir;
}
