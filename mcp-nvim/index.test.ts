/**
 * End-to-end smoke test: wire the MCP server to an in-memory client and drive a real
 * headless Neovim through it. Lists the tools, then runs nvim_ex + nvim_view and a
 * keystroke edit, asserting the returned text. Skips when `nvim` isn't on PATH.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function hasRg(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
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
    for (const n of ["nvim_keys", "nvim_ex", "nvim_view", "nvim_grep", "nvim_find", "nvim_lsp", "nvim_format", "nvim_test"]) {
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

  test("a rewrite with identical text (formatter on save) reports no change", async () => {
    await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit sample.ts" } });
    const text = textOf(await client.callTool({ name: "nvim_ex", arguments: { cmd: "%s/e/e/g" } }));
    assert.doesNotMatch(text, /changed/, text);
  });

  test("a real edit reports exactly the lines whose text changed", async () => {
    writeFileSync(join(cwd, "multi.ts"), "one\ntwo\nthree\n");
    await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit multi.ts" } });
    // Rewrites every line, but only line 2 ends up different.
    const text = textOf(await client.callTool({ name: "nvim_ex", arguments: { cmd: "%s/$//e | 2s/$/ tail/" } }));
    assert.match(text, /changed multi\.ts 2:\n 2│two tail\n/, text);
    assert.doesNotMatch(text, /changed multi\.ts (1|3|1-3)/, text);
  });

  test("the buffer list is sent only when it changes", async () => {
    const ex = async (cmd: string) => textOf(await client.callTool({ name: "nvim_ex", arguments: { cmd } }));
    await ex("echo 1"); // settle: whatever list exists now has been sent
    assert.doesNotMatch(await ex("echo 2"), /buffers:/);
    assert.match(await ex("badd extra.ts"), /buffers: .*extra\.ts/);
    assert.doesNotMatch(await ex("echo 3"), /buffers:/);
  });

  describe("nvim_grep", { skip: hasRg() ? false : "rg not installed" }, () => {
    const grep = async (args: Record<string, unknown>) =>
      textOf(await client.callTool({ name: "nvim_grep", arguments: args }));

    before(async () => {
      await client.callTool({ name: "nvim_ex", arguments: { cmd: "silent! %bwipeout!" } }); // drop earlier tests' unsaved edits
      mkdirSync(join(cwd, "src"), { recursive: true });
      mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
      // rg honors .ignore even outside a git repo (the temp dir isn't one).
      writeFileSync(join(cwd, ".ignore"), "node_modules/\n");
      writeFileSync(
        join(cwd, "src", "a.ts"),
        [
          "    const needle = 1; const needle2 = needle; // a|b 50% #tag",
          `const long = "${"x".repeat(5000)} needle";`,
          `const mid = "${"y".repeat(600)} needle";`,
          "",
        ].join("\n"),
      );
      writeFileSync(join(cwd, "src", "b.ts"), "export const needle = 'b';\n");
      writeFileSync(join(cwd, "node_modules", "dep", "index.js"), "module.exports = 'needle';\n");
    });

    test("path scopes the search without un-ignoring node_modules", async () => {
      const text = await grep({ pattern: "needle", path: "src" });
      assert.match(text, /^4 matches in 2 files/);
      assert.doesNotMatch(text, /node_modules/);
    });

    test("hits are grouped by file: path once, one `lnum:col text` per line", async () => {
      await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit sample.ts" } });
      const text = await grep({ pattern: "needle", path: "src" });
      assert.match(text, /^src\/a\.ts \(3\)\n {2}1:11 const needle = 1;/m); // indentation dropped
      assert.match(text, /^src\/b\.ts\n {2}1:14 export const needle/m);
      assert.equal(text.match(/^ {2}1:/gm)?.length, 2, text); // one entry per line, not per match
      assert.doesNotMatch(text, /changed|quickfix \(/); // no echoed quickfix buffer or raw list
      assert.doesNotMatch(text, /salutation|greeting/); // no unrelated cursor context
    });

    test("long lines are windowed around the match", async () => {
      const text = await grep({ pattern: "needle", path: "src" });
      for (const line of text.split("\n")) assert.ok(line.length < 200, `line of ${line.length} chars`);
      assert.match(text, /3:\d+ …y+ needle";/);
    });

    test("over the limit it returns per-file counts instead of lines", async () => {
      const text = await grep({ pattern: "needle", path: "src", limit: 2 });
      assert.match(text, /^4 matches in 2 files\nover the 2-hit listing limit; hits per file:\n {2}3 src\/a\.ts\n {2}1 src\/b\.ts/);
      assert.doesNotMatch(text, /const needle/);
    });

    test("regex and Ex-special characters pass through literally", async () => {
      assert.match(await grep({ pattern: "zzz|needle2" }), /^src\/a\.ts\n {2}1:/m);
      assert.match(await grep({ pattern: "50% #tag" }), /^src\/a\.ts\n {2}1:/m);
      assert.match(await grep({ pattern: "a\\|b" }), /^src\/a\.ts\n {2}1:/m);
    });

    test("no matches is reported", async () => {
      assert.match(await grep({ pattern: "definitely_not_here_42", path: "src" }), /^no matches for definitely_not_here_42 in src$/);
    });

    test("word matches whole words only", async () => {
      assert.match(await grep({ pattern: "needl", path: "src" }), /^4 matches in 2 files/);
      assert.match(await grep({ pattern: "needl", path: "src", word: true }), /^no matches/);
    });

    test("literal takes regex metacharacters at face value", async () => {
      assert.match(await grep({ pattern: "a|b", path: "src", literal: true }), /^1 match in 1 file\nsrc\/a\.ts\n {2}1:/);
    });

    test("case: smart is sensitive with uppercase; ignore overrides", async () => {
      assert.match(await grep({ pattern: "NEEDLE", path: "src" }), /^no matches/);
      assert.match(await grep({ pattern: "NEEDLE", path: "src", case: "ignore" }), /^4 matches in 2 files/);
      assert.match(await grep({ pattern: "Needle", path: "src", case: "sensitive" }), /^no matches/);
    });

    test("context shows surrounding lines rg-style, indentation kept", async () => {
      const text = await grep({ pattern: "needle2", path: "src", context: 1 });
      assert.match(text, /^src\/a\.ts\n {2}1:\d+ {5}const needle = 1;.*\n {2}2- const long = "x+…$/m, text);
    });

    test("a single file as path still yields file names", async () => {
      assert.match(await grep({ pattern: "needle", path: "src/b.ts" }), /^1 match in 1 file\nsrc\/b\.ts\n {2}1:14 /);
    });

    test("glob filters hits but never brings ignored files back", async () => {
      assert.match(await grep({ pattern: "needle", glob: "*.js" }), /^no matches/); // node_modules/dep/index.js
      assert.match(await grep({ pattern: "needle", glob: "*.ts" }), /^4 matches in 2 files/);
      assert.match(await grep({ pattern: "needle", glob: "src/**" }), /^4 matches in 2 files/);
      assert.match(await grep({ pattern: "needle", path: "src", glob: "!b.ts" }), /^3 matches in 1 file\nsrc\/a\.ts/);
    });

    test("many files roll up by directory plus the busiest files", async () => {
      for (const [dir, n] of [["many/x", 20], ["other/y", 10]] as const) {
        mkdirSync(join(cwd, dir), { recursive: true });
        for (let i = 0; i < n; i++) writeFileSync(join(cwd, dir, `f${i}.txt`), "rollup\n");
      }
      const text = await grep({ pattern: "rollup", limit: 5 });
      assert.match(text, /^30 matches in 30 files\nover the 5-hit listing limit; hits by directory:\n {2}20 many\/x\/\n {2}10 other\/y\/\nbusiest files:\n/);
      assert.equal(text.match(/^ {2}1 /gm)?.length, 10, text); // top 10 files, not all 30
    });

    test("warns when buffers hold unsaved edits grep can't see", async () => {
      await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit src/b.ts | s/needle/pin/" } });
      const text = await grep({ pattern: "needle", path: "src" });
      assert.match(text, /\nnote: unsaved edits in src\/b\.ts; grep reads files on disk$/);
      await client.callTool({ name: "nvim_ex", arguments: { cmd: "edit! src/b.ts" } });
      assert.doesNotMatch(await grep({ pattern: "needle", path: "src" }), /unsaved/);
    });
  });

  describe("nvim_find", { skip: hasRg() ? false : "rg not installed" }, () => {
    const find = async (args: Record<string, unknown>) =>
      textOf(await client.callTool({ name: "nvim_find", arguments: args }));

    test("fuzzy-ranks project files, best first, ignoring node_modules", async () => {
      const text = await find({ query: "srca" });
      assert.match(text, /^\d+ files? match srca.*:\nsrc\/a\.ts(\n|$)/, text);
      assert.doesNotMatch(text, /node_modules/);
    });

    test("limit caps the list and says so", async () => {
      assert.match(await find({ query: "ts", limit: 1 }), /^\d+ files match ts, top 1:\n[^\n]+/);
    });

    test("no match is reported with the searched count", async () => {
      assert.match(await find({ query: "zzzqqq" }), /^no files match zzzqqq \(\d+ searched\)$/);
    });

    test("name matches outrank scattered path matches, which are hidden but counted", async () => {
      writeFileSync(join(cwd, "src", "tools.ts"), "export {};\n");
      mkdirSync(join(cwd, "docs", "the", "odd", "old"), { recursive: true });
      writeFileSync(join(cwd, "docs", "the", "odd", "old", "list.md"), "t-o-o-l-s across the path\n");
      assert.equal(
        await find({ query: "tools" }),
        "1 file match tools:\nsrc/tools.ts\n(+1 weaker matches with the letters scattered across the path)",
      );
      // Nothing better? The scattered matches are the answer.
      assert.match(await find({ query: "dtool" }), /^1 file match dtool:\ndocs\/the\/odd\/old\/list\.md$/);
    });
  });
});
