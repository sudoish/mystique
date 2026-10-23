/**
 * End-to-end smoke test: wire the MCP server to an in-memory client and drive a real
 * headless Neovim through it. Lists the tools, then runs nvim_ex + nvim_view and a
 * keystroke edit, asserting the returned text. Skips when `nvim` isn't on PATH.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NvimSession } from "../core/nvim.ts";
import { createServer } from "./index.ts";

function hasNvim(): boolean {
  try {
    execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const luaPath = fileURLToPath(new URL("../core/lua/mystique.lua", import.meta.url));

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("mcp-nvim server over MCP", { skip: hasNvim() ? false : "nvim not installed" }, () => {
  let proc: ChildProcess;
  let cwd: string;
  let socket: string;
  let session: NvimSession;
  let client: Client;
  const prevSocket = process.env.MYSTIQUE_SOCKET;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "mystique-mcp-"));
    writeFileSync(join(cwd, "sample.ts"), "export const greeting = 'hello';\n");
    socket = join(tmpdir(), `mystique-mcp-${process.pid}.sock`);
    if (existsSync(socket)) rmSync(socket);
    proc = spawn("nvim", ["--headless", "-n", "-u", "NONE", "--listen", socket], { cwd, stdio: "ignore" });
    const deadline = Date.now() + 15000;
    while (!existsSync(socket)) {
      if (Date.now() > deadline) throw new Error("nvim did not create its socket in time");
      await sleep(100);
    }
    process.env.MYSTIQUE_SOCKET = socket;

    session = new NvimSession(luaPath);
    session.speed = "fast";
    const server = createServer(session);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client?.close().catch(() => { });
    await session?.disconnect(false).catch(() => { });
    proc?.kill("SIGKILL");
    if (socket && existsSync(socket)) rmSync(socket, { force: true });
    if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
    if (prevSocket === undefined) delete process.env.MYSTIQUE_SOCKET;
    else process.env.MYSTIQUE_SOCKET = prevSocket;
  });

  test("lists the nvim_* tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const n of ["nvim_keys", "nvim_ex", "nvim_view", "nvim_grep", "nvim_lsp", "nvim_format", "nvim_test"]) {
      assert.ok(names.includes(n), `expected tool ${n}, got ${names.join(", ")}`);
    }
  });

  test("nvim_ex + nvim_view read a file", async () => {
    await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit sample.ts" } });
    const res = await client.callTool({ name: "nvim_view", arguments: {} });
    assert.match(textOf(res), /greeting/);
  });

  test("nvim_keys edits and the snapshot reflects it", async () => {
    await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit sample.ts" } });
    const res = await client.callTool({ name: "nvim_keys", arguments: { keys: "ggAconst added = 1;<Esc>" } });
    assert.match(textOf(res), /\[\+\]/); // modified flag in the status line
  });

  test("a structural :s edit applies", async () => {
    await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit sample.ts" } });
    await client.callTool({ name: "nvim_ex", arguments: { cmd: "%s/greeting/salutation/g" } });
    const res = await client.callTool({ name: "nvim_view", arguments: {} });
    assert.match(textOf(res), /salutation/);
  });
});
