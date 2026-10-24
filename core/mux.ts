import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Mode } from "./detect.mjs";

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the shell command that launches our nvim, making project-local LSPs (node_modules/.bin) visible. */
function nvimCommand(socket: string, localBin: string | undefined): string {
  const prefix = localBin ? `PATH=${shellQuote(localBin)}:"$PATH" ` : "";
  return `${prefix}exec nvim --listen ${shellQuote(socket)}`;
}

export interface SpawnOpts {
  cwd: string;
  socket: string;
  /** node_modules/.bin to prepend to PATH, when it exists. */
  localBin: string | undefined;
}

/** A terminal multiplexer we can split a pane/block in and drive a spawned nvim through. */
export interface Multiplexer {
  readonly mode: Extract<Mode, "herdr" | "rex">;
  /** Split next to the host pane, launch nvim listening on `socket`, return the new pane/block id. */
  spawnEditor(opts: SpawnOpts): Promise<string>;
  /** Send a real terminal key to the pane (used to unblock a prompt the RPC queue can't reach). */
  sendKey(pane: string, key: "enter" | "escape"): Promise<void>;
  /** Read the last `lines` lines visibly rendered in the pane (works even while nvim is blocked). */
  readScreen(pane: string, lines: number): Promise<string>;
  /** Close the pane/block we created. */
  close(pane: string): Promise<void>;
  /** Human-readable label for a pane, for notifications. */
  describe(pane: string): string;
}

const herdr: Multiplexer = {
  mode: "herdr",
  async spawnEditor({ cwd, socket, localBin }) {
    const split = JSON.parse(
      await run("herdr", ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]),
    );
    const paneId: string = split?.result?.pane?.pane_id;
    if (!paneId) throw new Error(`herdr pane split returned no pane id: ${JSON.stringify(split)}`);
    await run("herdr", ["pane", "run", paneId, nvimCommand(socket, localBin)]);
    await run("herdr", ["pane", "rename", paneId, "nvim (pi)"]).catch(() => {});
    return paneId;
  },
  async sendKey(pane, key) {
    await run("herdr", ["pane", "send-keys", pane, key === "enter" ? "enter" : "esc"]);
  },
  async readScreen(pane, lines) {
    const out = await run("herdr", ["pane", "read", pane, "--source", "visible", "--lines", String(lines)]);
    try {
      const json = JSON.parse(out);
      return json?.result?.read?.text ?? json?.result?.text ?? out;
    } catch {
      return out;
    }
  },
  async close(pane) {
    await run("herdr", ["pane", "close", pane]);
  },
  describe(pane) {
    return `herdr pane ${pane}`;
  },
};

/** The `rex` binary: $REX_BIN_DIR/rex when set, else `rex` on PATH. */
function rexBin(): string {
  const dir = process.env.REX_BIN_DIR;
  return dir ? join(dir, "rex") : "rex";
}

/** --autostart=false on every call so mystique never spawns a hidden Rex server. */
function rexRun(args: string[], timeoutMs?: number): Promise<string> {
  return run(rexBin(), ["--autostart=false", ...args], timeoutMs);
}

const rex: Multiplexer = {
  mode: "rex",
  async spawnEditor({ cwd, socket, localBin }) {
    // One call splits, runs and labels: block_ids[0] is the new block.
    const out = await rexRun([
      "split",
      "-b",
      process.env.REX_BLOCK!,
      "--split=right",
      "--focus=false",
      "--label",
      "nvim (pi)",
      "--cwd",
      cwd,
      "--json",
      "--",
      "sh",
      "-c",
      nvimCommand(socket, localBin),
    ]);
    let block: string | undefined;
    try {
      block = JSON.parse(out)?.block_ids?.[0];
    } catch {
      block = undefined;
    }
    if (!block) throw new Error(`rex split returned no block id: ${out}`);
    return block;
  },
  async sendKey(pane, key) {
    await rexRun(["send-key", "-b", pane, key === "enter" ? "enter" : "escape"]);
  },
  async readScreen(pane, lines) {
    const out = await rexRun(["capture", "-b", pane, "--trim"]);
    return out.split("\n").slice(-lines).join("\n");
  },
  async close(pane) {
    await rexRun(["block", "close", pane]);
  },
  describe(pane) {
    return `rex block ${pane}`;
  },
};

/** Pick the multiplexer implementation for a detected mode. */
export function multiplexer(mode: Mode): Multiplexer | undefined {
  if (mode === "herdr") return herdr;
  if (mode === "rex") return rex;
  return undefined;
}
