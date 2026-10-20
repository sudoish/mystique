import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attach, type NeovimClient } from "neovim";

export type Speed = "demo" | "fast";

// The neovim client defaults to a winston logger that monkey-patches `console`.
// Pass a silent logger so pi's own output stays intact.
const silentLogger = {
	level: "error",
	info() {},
	warn() {},
	error() {},
	debug() {},
} as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
			else resolve(stdout);
		});
	});
}

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
}

export class NvimSession {
	client: NeovimClient | undefined;
	socket: string | undefined;
	paneId: string | undefined;
	ownsPane = false;
	speed: Speed = (process.env.PI_NVIM_SPEED as Speed) === "fast" ? "fast" : "demo";
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

	private async start(cwd: string): Promise<NeovimClient> {
		let socket = process.env.PI_NVIM_SOCKET;
		if (!socket || !existsSync(socket)) {
			if (process.env.HERDR_ENV !== "1") {
				throw new Error(
					"Not running inside herdr. Start pi inside herdr, or run `nvim --listen <sock>` yourself and set PI_NVIM_SOCKET=<sock>.",
				);
			}
			socket = `/tmp/pi-nvim-${process.pid}-${Date.now().toString(36)}.sock`;
			const split = JSON.parse(
				await run("herdr", ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]),
			);
			const paneId: string = split?.result?.pane?.pane_id;
			if (!paneId) throw new Error(`herdr pane split returned no pane id: ${JSON.stringify(split)}`);
			this.paneId = paneId;
			this.ownsPane = true;
			// Make project-local language servers (node_modules/.bin) visible to nvim.
			const localBin = join(cwd, "node_modules", ".bin");
			const prefix = existsSync(localBin) ? `PATH=${shellQuote(localBin)}:"$PATH" ` : "";
			await run("herdr", ["pane", "run", paneId, `${prefix}nvim --listen ${shellQuote(socket)}`]);
			await run("herdr", ["pane", "rename", paneId, "nvim (pi)"]).catch(() => {});
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
		await client.lua("PiAgent.begin(...)", [this.chan]);
		this.client = client;
		await this.loadKeymaps().catch(() => {});
		return client;
	}

	/** The user's leader key and an editing-relevant cheat sheet of their mappings. */
	leader = " ";
	cheatsheet: string | undefined;

	private async loadKeymaps(): Promise<void> {
		const deny =
			process.env.PI_NVIM_KEYMAP_DENY ??
			"\\c\\v(telescope|find|grep|theme|whichkey|cheatsheet|term|tmux|lazygit|git|<ai>|opencode|sidekick|claude|copilot|note|obsidian|strudel|dbui|<pr>|review|session|daily|template|scroll|navigate|quit|highlights|copy whole|line number|marks|edit suggestion|diff|add current buffer|peek|outline|float output|loclist)";
		const km = await this.lua<{ leader: string; lines: string[] }>("return PiAgent.keymaps(...)", [deny, 70]);
		this.leader = km.leader;
		const leaderName = km.leader === " " ? "<Space>" : km.leader;
		this.cheatsheet = [
			`Leader is ${leaderName}. You can write <leader> in nvim_keys and it is expanded.`,
			"lhs            mode description (n=normal o=operator-pending x=visual)",
			...km.lines,
		].join("\n");
	}

	/** Expand <leader>/<Leader> into the configured leader key. */
	expandLeader(keys: string): string {
		const leader = this.leader === " " ? "<Space>" : this.leader === "<" ? "<lt>" : this.leader;
		return keys.replace(/<leader>/gi, leader);
	}

	/** Mark a tool as running. Returns a description of human activity since the last tool, if any. */
	async startTool(label: string): Promise<string | undefined> {
		const activity = await this.lua<string | null>("return PiAgent.start_tool(...)", [label]);
		return typeof activity === "string" && activity ? activity : undefined;
	}

	async endTool(): Promise<void> {
		await this.lua("PiAgent.end_tool()").catch(() => {});
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
		await this.lua("PiAgent.begin(...)", [this.chan]);
		await this.type(keys);
		await this.client!.input(`<Cmd>lua PiAgent.done("${id}")<CR>`);
		return done;
	}

	/** Show an Ex command being typed on the cmdline row, then execute it with output capture. */
	async ex(cmd: string): Promise<boolean> {
		await this.lua("PiAgent.begin(...)", [this.chan]);
		if (this.speed === "demo") {
			const steps = Math.min(cmd.length, 25);
			for (let i = 1; i <= steps; i++) {
				await this.lua("PiAgent.show_cmdline(...)", [cmd.slice(0, Math.ceil((cmd.length * i) / steps))]);
				await sleep(25);
			}
			await sleep(200);
		}
		await this.lua("PiAgent.exec(...)", [cmd]);
		return true;
	}

	async put(lines: string[], kind: "l" | "c", after: boolean): Promise<void> {
		await this.lua("PiAgent.put(...)", [lines, kind, after]);
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

	/**
	 * Run Lua in nvim with a watchdog. If nvim stops answering (e.g. a prompt inside a request),
	 * press <Esc>/<CR> through the terminal (herdr), which bypasses the blocked RPC queue.
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
		if (!this.paneId) return;
		await run("herdr", ["pane", "send-keys", this.paneId, "enter"]).catch(() => {});
		await sleep(200);
		await run("herdr", ["pane", "send-keys", this.paneId, "esc"]).catch(() => {});
		await sleep(200);
	}

	async snapshot(opts: Record<string, unknown> = {}): Promise<Snapshot> {
		const snap = await this.lua<Snapshot>("return PiAgent.snapshot(...)", [opts]);
		if (snap.blocking) snap.screen = await this.screen(8).catch(() => undefined);
		return snap;
	}



	/** Read what is visibly rendered in the nvim pane (for floating UIs and prompts). */
	async screen(lines = 60): Promise<string> {
		if (!this.paneId) throw new Error("nvim pane is not managed by herdr in this session");
		const out = await run("herdr", [
			"pane",
			"read",
			this.paneId,
			"--source",
			"visible",
			"--lines",
			String(lines),
		]);
		try {
			const json = JSON.parse(out);
			return json?.result?.read?.text ?? json?.result?.text ?? out;
		} catch {
			return out;
		}
	}

	async saveAll(): Promise<void> {
		if (!this.client) return;
		// Mark busy so format-on-save edits aren't mistaken for the human's.
		await Promise.race([
			this.lua("PiAgent.busy = true; pcall(vim.cmd, 'silent! wall'); PiAgent.busy = false"),
			sleep(2000),
		]).catch(() => {});
	}

	async disconnect(closePane: boolean): Promise<void> {
		const client = this.client;
		this.client = undefined;
		if (client) {
			// `qa!` never answers (nvim exits), so fire it without waiting for a reply.
			if (closePane) await Promise.race([client.command("qa!").catch(() => {}), sleep(300)]);
			// Note: client.quit() sends `:qa!`. close() only detaches, leaving the editor open.
			await Promise.race([client.close().catch(() => {}), sleep(500)]);
		}
		if (closePane && this.ownsPane && this.paneId) {
			await run("herdr", ["pane", "close", this.paneId]).catch(() => {});
			this.paneId = undefined;
		}
	}
}
