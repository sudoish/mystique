import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attach, type NeovimClient } from "neovim";
import { multiplexer, type Multiplexer } from "./mux.ts";

export type Speed = "demo" | "fast";

import { detectMode, type Mode } from "./detect.mjs";
export { detectMode };
export type { Mode };

// The neovim client defaults to a winston logger that monkey-patches `console`.
// Pass a silent logger so pi's own output stays intact.
const silentLogger = {
  level: "error",
  info() { },
  warn() { },
  error() { },
  debug() { },
} as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escape text so nvim_input types it literally. */
export function escapeKeys(s: string): string {
  return s.replace(/</g, "<lt>");
}

/** Split a key string into input tokens (`<C-w>`, `<lt>`, single chars). */
function tokenize(keys: string): string[] {
  // Key codes like <CR>, <C-w>, <C-\>, <lt>, <M-S-x>; anything else is one char.
  return keys.match(/<[^<>\s]+>|[\s\S]/g) ?? [];
}

export interface Snapshot {
  mode: string;
  file: string;
  cur: [number, number];
  lines: number;
  mod: boolean;
  ctx: string;
  diag: { E: number; W: number };
  changed: { file: string; ranges: [number, number][]; text?: string }[];
  blocking?: boolean;
  err?: string;
  msg?: string;
  output?: string;
  bufs?: string[];
  qf?: { total: number; items: string[] };
  screen?: string;
  synced?: boolean;
  floats?: string[];
}

/** The capability manifest returned by Mystique.capabilities() (see mystique.lua). */
export interface Caps {
  nvim: string;
  lsp?: { attached?: string[]; active?: string[] };
  format?: { backend: string; how?: string };
  test?: { backend: string; nearest?: string; file?: string; suite?: string };
  comment?: { backend: string; how?: string };
  treesitter?: { available?: boolean; textobjects?: boolean };
  grep?: { prg?: string; ripgrep?: boolean };
  commands?: string[];
}

/** Render the compact, token-light <nvim_capabilities> prompt section from a manifest. */
export function renderCapabilities(c: Caps): string {
  const lines: string[] = [];
  lines.push(`Neovim ${c.nvim}. This section is probed from the live config each turn; use it to pick tools.`);
  lines.push(`format: ${c.format?.backend ?? "builtin"}${c.format?.how ? ` (${c.format.how})` : ""} — use nvim_format`);
  if (c.test?.backend && c.test.backend !== "none") {
    lines.push(`test: ${c.test.backend} — use nvim_test (nearest/file/suite)`);
  } else {
    lines.push("test: none — no runner wired; run the project's test command via bash");
  }
  lines.push(`comment: ${c.comment?.backend ?? "none"}${c.comment?.how ? ` (${c.comment.how})` : ""}`);
  const attached = c.lsp?.attached ?? [];
  const activeLsp = c.lsp?.active ?? [];
  if (attached.length) {
    lines.push(`lsp: ${attached.join(",")} attached to the current buffer — use nvim_lsp for rename/refs/definition`);
  } else if (activeLsp.length) {
    lines.push(`lsp: none on the current buffer (active elsewhere: ${activeLsp.join(",")}); open a real source file before nvim_lsp`);
  } else {
    lines.push("lsp: none — rename/refs/definition unavailable; edit by hand");
  }
  lines.push(`grep: ${c.grep?.ripgrep ? "ripgrep" : c.grep?.prg || "vimgrep"} — use nvim_grep`);
  if (c.treesitter?.textobjects) {
    lines.push("treesitter text-objects: yes (daf/dif/]f etc. are optional shortcuts)");
  } else if (c.treesitter?.available) {
    lines.push("treesitter text-objects: no — use plain motions/text objects");
  } else {
    lines.push("treesitter: no — use plain motions");
  }
  // Surface config-defined commands relevant to editing workflows (format/test/lint/lsp/fix/etc.).
  const relevant = (c.commands ?? []).filter((n) =>
    /format|prettier|eslint|lint|test|jest|vitest|lsp|fix|organize|conform|rustfmt|gofmt|black|ruff/i.test(n),
  );
  if (relevant.length) lines.push(`notable :commands: ${relevant.slice(0, 12).join(" ")}`);
  return lines.join("\n");
}

export class NvimSession {
  client: NeovimClient | undefined;
  socket: string | undefined;
  mode: Mode | undefined;
  paneId: string | undefined;
  mux: Multiplexer | undefined;
  ownsPane = false;
  speed: Speed = (process.env.MYSTIQUE_SPEED as Speed) === "fast" ? "fast" : "demo";
  private chan = 0;
  private seq = 0;
  private waiters = new Map<string, () => void>();
  private connecting: Promise<NeovimClient> | undefined;

  private luaPath: string;

  constructor(luaPath: string) {
    this.luaPath = luaPath;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  async ensure(cwd: string): Promise<NeovimClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.start(cwd).finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  /** Short human-readable description of the connection, for notifications. */
  describe(): string {
    if (this.mux && this.paneId) return this.mux.describe(this.paneId);
    if (this.mode === "embedded") return `inside the host Neovim (${this.socket})`;
    return `attached to ${this.socket}`;
  }

  private async start(cwd: string): Promise<NeovimClient> {
    const mode = detectMode();
    if (!mode) {
      throw new Error(
        "No Neovim to drive. Run pi inside a Neovim terminal (e.g. sidekick.nvim), inside herdr or Rex, " +
        "or start `nvim --listen <sock>` yourself and set MYSTIQUE_SOCKET=<sock>.",
      );
    }
    this.mode = mode;
    let socket: string;
    if (mode === "external") socket = process.env.MYSTIQUE_SOCKET!;
    else if (mode === "embedded") socket = process.env.NVIM!;
    else {
      socket = `/tmp/pi-nvim-${process.pid}-${Date.now().toString(36)}.sock`;
      const mux = multiplexer(mode)!;
      this.mux = mux;
      // Make project-local language servers (node_modules/.bin) visible to nvim.
      const localBin = join(cwd, "node_modules", ".bin");
      this.paneId = await mux.spawnEditor({ cwd, socket, localBin: existsSync(localBin) ? localBin : undefined });
      this.ownsPane = true;
      const deadline = Date.now() + 20000;
      while (!existsSync(socket)) {
        if (Date.now() > deadline) throw new Error(`nvim did not create socket ${socket} within 20s`);
        await sleep(100);
      }
    }
    this.socket = socket;

    const client = attach({ socket, options: { logger: silentLogger } });
    client.on("notification", (method: string, args: unknown[]) => {
      if (method === "pi_done") {
        const id = String(args?.[0]);
        const w = this.waiters.get(id);
        if (w) {
          this.waiters.delete(id);
          w();
        }
      }
    });
    client.on("disconnect", () => {
      if (this.client === client) this.client = undefined;
    });

    // Wait for startup (plugins, VimEnter) to finish before driving the editor.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const entered = await client.lua("return vim.v.vim_did_enter").catch(() => 0);
      if (entered === 1 || entered === true) break;
      await sleep(100);
    }
    this.chan = await client.channelId;
    await client.lua(readFileSync(this.luaPath, "utf8"));
    await client.lua("Mystique.setup(...)", [{ embedded: mode === "embedded" }]);
    await client.lua("Mystique.begin(...)", [this.chan]);
    this.client = client;
    await this.dismissPrompts();
    await this.loadKeymaps().catch(() => { });
    await this.loadCapabilities().catch(() => { });
    return client;
  }

  /** The user's leader key and an editing-relevant cheat sheet of their mappings. */
  leader = " ";
  cheatsheet: string | undefined;

  /** The structured capability manifest (see Mystique.capabilities()), and its rendered text. */
  caps: Caps | undefined;
  capabilities: string | undefined;

  /**
   * Probe the live config for capabilities and render the <nvim_capabilities> section.
   * Safe to call repeatedly: the per-buffer parts (attached LSP, treesitter) reflect whatever
   * buffer is current when it runs, so we refresh it each agent turn to avoid stale data.
   */
  async loadCapabilities(): Promise<void> {
    this.caps = await this.lua<Caps>("return Mystique.capabilities()", []);
    this.capabilities = renderCapabilities(this.caps);
  }

  private async loadKeymaps(): Promise<void> {
    const deny =
      process.env.MYSTIQUE_KEYMAP_DENY ??
      "\\c\\v(telescope|find|grep|theme|whichkey|cheatsheet|term|tmux|lazygit|git|<ai>|opencode|sidekick|claude|copilot|note|obsidian|strudel|dbui|<pr>|review|session|daily|template|scroll|navigate|quit|highlights|copy whole|line number|marks|edit suggestion|diff|add current buffer|peek|outline|float output|loclist)";
    const km = await this.lua<{ leader: string; lines: string[]; gotchas: string[] }>(
      "return Mystique.keymaps(...)",
      [deny, 70],
    );
    this.leader = km.leader;
    const leaderName = km.leader === " " ? "<Space>" : km.leader;
    this.cheatsheet = [
      `Leader is ${leaderName}. You can write <leader> in nvim_keys and it is expanded.`,
      "lhs            mode description (n=normal o=operator-pending x=visual)",
      ...km.lines,
      ...(km.gotchas?.length ? ["", "GOTCHAS in this config:", ...km.gotchas.map((g) => `- ${g}`)] : []),
    ].join("\n");
  }

  /** Expand <leader>/<Leader> into the configured leader key. */
  expandLeader(keys: string): string {
    const leader = this.leader === " " ? "<Space>" : this.leader === "<" ? "<lt>" : this.leader;
    return keys.replace(/<leader>/gi, leader);
  }

  /** Dismiss hit-enter / more prompts (e.g. wrapped startup messages) so they can't stall the agent. */
  async dismissPrompts(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const mode = (await this.client!.mode) as { mode: string; blocking: boolean };
      if (!mode.mode.startsWith("r")) return;
      await this.client!.input("<CR>");
      await sleep(100);
    }
  }

  /** Mark a tool as running. Returns a description of human activity since the last tool, if any. */
  async startTool(label: string): Promise<string | undefined> {
    await this.dismissPrompts();
    const activity = await this.lua<string | null>("return Mystique.start_tool(...)", [label]);
    return typeof activity === "string" && activity ? activity : undefined;
  }

  async endTool(): Promise<void> {
    await this.lua("Mystique.end_tool()").catch(() => { });
  }

  /** Type keys into nvim like a human (paced in demo mode). */
  private async type(keys: string): Promise<void> {
    const client = this.client!;
    if (this.speed === "fast") {
      await client.input(keys);
      return;
    }
    const tokens = tokenize(keys);
    const delay = Math.max(4, Math.min(35, Math.floor(2500 / Math.max(1, tokens.length))));
    // Group a few tokens per write so long sequences stay snappy.
    const chunk = tokens.length > 60 ? 3 : 1;
    for (let i = 0; i < tokens.length; i += chunk) {
      await client.input(tokens.slice(i, i + chunk).join(""));
      await sleep(delay);
    }
  }

  /** Type keys, then wait until nvim has processed all of them (via a <Cmd> sentinel). */
  async keys(keys: string, timeoutMs = 4000): Promise<boolean> {
    const id = `k${++this.seq}`;
    const done = this.waitFor(id, timeoutMs);
    await this.lua("Mystique.begin(...)", [this.chan]);
    await this.type(keys);
    await this.client!.input(`<Cmd>lua Mystique.done("${id}")<CR>`);
    return done;
  }

  /** Show an Ex command being typed on the cmdline row, then execute it with output capture. */
  async ex(cmd: string): Promise<boolean> {
    await this.lua("Mystique.begin(...)", [this.chan]);
    if (this.speed === "demo") {
      const steps = Math.min(cmd.length, 25);
      for (let i = 1; i <= steps; i++) {
        await this.lua("Mystique.show_cmdline(...)", [cmd.slice(0, Math.ceil((cmd.length * i) / steps))]);
        await sleep(25);
      }
      await sleep(200);
    }
    await this.lua("Mystique.exec(...)", [cmd]);
    return true;
  }

  async put(lines: string[], kind: "l" | "c", after: boolean): Promise<void> {
    await this.lua("Mystique.put(...)", [lines, kind, after]);
  }

  private waitFor(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(false);
      }, timeoutMs);
      this.waiters.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** The agent loop ended: give focus back to the terminal it was taken from (embedded mode). */
  async endRun(): Promise<boolean> {
    if (!this.client || process.env.MYSTIQUE_REFOCUS === "0") return false;
    return this.lua<boolean>("return Mystique.end_run()", [], 3000).catch(() => false);
  }

  /**
   * Run Lua in nvim with a watchdog. If nvim stops answering (e.g. a prompt inside a request),
   * press <CR>/<Esc> through a path that bypasses the blocked RPC queue.
   */
  async lua<T = any>(code: string, args: unknown[] = [], timeoutMs = 20000): Promise<T> {
    const call = this.client!.lua(code, args as any) as Promise<T>;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("nvim did not respond")), timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } catch (e) {
      if ((e as Error).message === "nvim did not respond") {
        await this.unblock();
        throw new Error(
          `nvim was blocked for ${timeoutMs / 1000}s (probably a prompt) and was sent <CR><Esc>. Check its state with nvim_keys('<Esc>') before continuing.`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async unblock(): Promise<void> {
    // nvim_input is a "fast" API call: nvim handles it even while another request sits in a prompt.
    for (const key of ["<CR>", "<Esc>"]) {
      await Promise.race([this.client?.input(key), sleep(500)]).catch(() => { });
      await sleep(200);
    }
    if (!this.mux || !this.ownsPane || !this.paneId) return;
    // Belt and braces for our own herdr/Rex pane: real terminal keystrokes.
    await this.mux.sendKey(this.paneId, "enter").catch(() => { });
    await sleep(200);
    await this.mux.sendKey(this.paneId, "escape").catch(() => { });
    await sleep(200);
  }

  async snapshot(opts: Record<string, unknown> = {}): Promise<Snapshot> {
    const snap = await this.lua<Snapshot>("return Mystique.snapshot(...)", [opts]);
    if (snap.blocking) snap.screen = await this.screen(8).catch(() => undefined);
    return snap;
  }



  /**
   * Read what is visibly rendered in Neovim (for floating UIs and prompts). Our own herdr/Rex pane is
   * read through the multiplexer (works even while nvim is blocked); otherwise nvim renders its screen
   * to text for us.
   */
  async screen(lines = 60): Promise<string> {
    if (!this.mux || !this.ownsPane || !this.paneId) {
      const text = await this.lua<string>("return Mystique.screen()", [], 10000);
      return text.split("\n").slice(-lines).join("\n");
    }
    return this.mux.readScreen(this.paneId, lines);
  }

  async saveAll(): Promise<void> {
    if (!this.client) return;
    // Mark busy so format-on-save edits aren't mistaken for the human's.
    await Promise.race([
      this.lua("Mystique.busy = true; pcall(vim.cmd, 'silent! wall'); Mystique.busy = false"),
      sleep(2000),
    ]).catch(() => { });
  }

  /**
   * Detach from Neovim. Only an instance we spawned ourselves is ever quit (`closePane`);
   * the user's own editor (embedded/external) is cleaned up and left open.
   */
  async disconnect(closePane: boolean): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      if (closePane && this.ownsPane) {
        // `qa!` never answers (nvim exits), so fire it without waiting for a reply.
        await Promise.race([client.command("qa!").catch(() => { }), sleep(300)]);
      } else {
        await Promise.race([client.lua("Mystique.detach()").catch(() => { }), sleep(1000)]);
      }
      // Note: client.quit() sends `:qa!`. close() only detaches, leaving the editor open.
      await Promise.race([client.close().catch(() => { }), sleep(500)]);
    }
    if (closePane && this.mux && this.ownsPane && this.paneId) {
      await this.mux.close(this.paneId).catch(() => { });
      this.paneId = undefined;
    }
  }
}
