/**
 * End-to-end integration test: drive a real headless Neovim through NvimSession in
 * "external" mode (MYSTIQUE_SOCKET), exercising the full RPC + Lua-helper path that
 * the unit tests can't reach. Skips automatically when `nvim` isn't on PATH.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { NvimSession } from "./nvim.ts";

function hasNvim(): boolean {
  try {
    execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const luaPath = fileURLToPath(new URL("./lua/mystique.lua", import.meta.url));

describe("NvimSession against a headless Neovim", { skip: hasNvim() ? false : "nvim not installed" }, () => {
  let proc: ChildProcess;
  let cwd: string;
  let socket: string;
  let session: NvimSession;
  const prevSocket = process.env.MYSTIQUE_SOCKET;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "mystique-it-"));
    writeFileSync(join(cwd, "sample.ts"), "export const greeting = 'hello';\n");
    socket = join(tmpdir(), `mystique-it-${process.pid}.sock`);
    if (existsSync(socket)) rmSync(socket);
    proc = spawn("nvim", ["--headless", "-n", "-u", "NONE", "--listen", socket], {
      cwd,
      stdio: "ignore",
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(socket)) {
      if (Date.now() > deadline) throw new Error("nvim did not create its socket in time");
      await sleep(100);
    }
    process.env.MYSTIQUE_SOCKET = socket;
    session = new NvimSession(luaPath);
    session.speed = "fast";
    await session.ensure(cwd);
  });

  after(async () => {
    await session?.disconnect(false).catch(() => { });
    proc?.kill("SIGKILL");
    if (socket && existsSync(socket)) rmSync(socket, { force: true });
    if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
    if (prevSocket === undefined) delete process.env.MYSTIQUE_SOCKET;
    else process.env.MYSTIQUE_SOCKET = prevSocket;
  });

  test("connects in external mode and probes capabilities", () => {
    assert.equal(session.connected, true);
    assert.equal(session.mode, "external");
    assert.ok(session.caps, "capabilities manifest was probed on connect");
    assert.match(session.caps!.nvim, /^\d+\.\d+\.\d+$/);
    assert.match(session.capabilities ?? "", /Neovim \d+\.\d+\.\d+/);
  });

  test("opens a file and reports it in the snapshot", async () => {
    await session.ex("edit sample.ts");
    const snap = await session.snapshot();
    assert.match(snap.file, /sample\.ts$/);
    assert.equal(snap.lines, 1);
    assert.equal(snap.mode, "n");
  });

  test("edits through keystrokes and tracks the change", async () => {
    await session.ex("edit sample.ts");
    // Mirror the real tool lifecycle: start_tool marks edits as the agent's so they
    // land in the snapshot's changed[] (unmarked edits are attributed to the human).
    await session.startTool("edit");
    await session.keys("ggAconst added = 1;<Esc>", 8000);
    const snap = await session.snapshot();
    await session.endTool();
    assert.equal(snap.mod, true, "buffer is modified after typing");
    assert.ok(snap.changed.length >= 1, "a changed-line range was reported");
  });

  test("structural :s edit via ex is applied", async () => {
    await session.ex("edit sample.ts");
    await session.ex("%s/greeting/salutation/g");
    const snap = await session.snapshot();
    assert.match(snap.ctx, /salutation/);
  });
});
