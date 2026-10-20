/**
 * pi-nvim-dev — drive a live, visible Neovim (in a herdr pane) as the only way to edit code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NvimSession, shellQuote, type Snapshot } from "./nvim.ts";

const here = dirname(fileURLToPath(import.meta.url));
const session = new NvimSession(join(here, "lua", "pi_agent.lua"));
const playbook = readFileSync(join(here, "prompt.md"), "utf8");

const policyEnabled = process.env.PI_NVIM_POLICY !== "off";
const DISABLED_BUILTINS = ["read", "edit", "write", "grep", "find", "ls"];

/** Render a snapshot as compact text for the model. */
function formatSnap(s: Snapshot, extra?: string): string {
	const out: string[] = [];
	if (extra) out.push(extra);
	if (s.err) out.push(`ERROR: ${s.err}`);
	if (s.output) out.push(`output:\n${s.output}`);
	if (s.msg) out.push(`msg: ${s.msg}`);
	if (s.synced === false) out.push("warning: keys may still be pending (no sync within timeout)");
	if (s.blocking) out.push(`BLOCKING prompt. Screen:\n${s.screen ?? "(unavailable)"}`);
	for (const c of s.changed ?? []) {
		const ranges = c.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
		out.push(c.text ? `changed ${c.file} ${ranges}:\n${c.text}` : `changed ${c.file} ${ranges}`);
	}
	if (s.qf) out.push(`quickfix (${s.qf.total}):\n${s.qf.items.join("\n")}`);
	const flags = [s.mod ? "[+]" : "", s.diag.E ? `E${s.diag.E}` : "", s.diag.W ? `W${s.diag.W}` : ""]
		.filter(Boolean)
		.join(" ");
	out.push(`[${s.mode}] ${s.file || "[No Name]"}:${s.cur[0]}:${s.cur[1]}/${s.lines} ${flags}`.trimEnd());
	out.push(s.ctx);
	if (s.bufs && s.bufs.length > 1) out.push(`buffers: ${s.bufs.join(" ")}`);
	return out.join("\n");
}

function text(t: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: t }], details };
}

async function withNvim<T>(ctx: ExtensionContext, label: string, fn: () => Promise<T>): Promise<T> {
	await session.ensure(ctx.cwd);
	await session.status(label);
	try {
		return await fn();
	} finally {
		await session.status(undefined);
	}
}

const truncLabel = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const keysTool = defineTool({
	name: "nvim_keys",
	label: "nvim keys",
	description:
		"Type keystrokes into the live Neovim, using Vim key notation (<CR>, <Esc>, <C-w>, <lt> for a literal '<'). " +
		"Use it for motions, text objects, operators, counts, macros, registers and search (/pat<CR>). Returns a compact editor snapshot.",
	promptSnippet: "Type Vim keystrokes into the live Neovim (motions, text objects, macros)",
	parameters: Type.Object({
		keys: Type.String({ description: "Keys in Vim notation, e.g. `ciwnewName<Esc>` or `/foo<CR>cgnbar<Esc>..`" }),
	}),
	executionMode: "sequential",
	async execute(_id, p, _signal, _onUpdate, ctx) {
		return withNvim(ctx, `⌨ ${truncLabel(p.keys)}`, async () => {
			const synced = await session.keys(p.keys);
			const snap = await session.snapshot();
			snap.synced = synced;
			return text(formatSnap(snap), { keys: p.keys });
		});
	},
});

const exTool = defineTool({
	name: "nvim_ex",
	label: "nvim :",
	description:
		"Type and run an Ex command on the Neovim cmdline (without the leading ':'). Examples: `e src/a.ts`, `%s/\\<foo\\>/bar/g`, " +
		"`g/TODO/d`, `cdo s/a/b/g | update`, `10,20norm A;`, `w`. Returns the command output and a snapshot.",
	promptSnippet: "Run an Ex command in Neovim (:e, :s, :g, :norm, :cdo, :w …)",
	parameters: Type.Object({ cmd: Type.String({ description: "Ex command without the leading ':'" }) }),
	executionMode: "sequential",
	async execute(_id, p, _signal, _onUpdate, ctx) {
		return withNvim(ctx, `:${truncLabel(p.cmd)}`, async () => {
			const synced = await session.ex(p.cmd);
			const snap = await session.snapshot();
			snap.synced = synced;
			return text(formatSnap(snap), { cmd: p.cmd });
		});
	},
});

const insertTool = defineTool({
	name: "nvim_insert",
	label: "nvim insert",
	description:
		"Paste literal text into the current buffer as one undo step, bypassing auto-pairs and completion. " +
		"where: below/above the cursor line (linewise), or before/after the cursor (charwise). Use it only for new text.",
	promptSnippet: "Paste a block of new text into the current Neovim buffer",
	parameters: Type.Object({
		text: Type.String({ description: "Text to insert (no trailing newline needed for linewise)" }),
		where: Type.Optional(StringEnum(["below", "above", "before", "after"] as const, { description: "Default: below" })),
	}),
	executionMode: "sequential",
	async execute(_id, p, _signal, _onUpdate, ctx) {
		const where = p.where ?? "below";
		const nLines = p.text.split("\n").length;
		return withNvim(ctx, `paste ${nLines} line(s) ${where}`, async () => {
			if (where === "below" || where === "above") await session.keys("<C-\\><C-n>");
			const lines = p.text.replace(/\n$/, "").split("\n");
			const linewise = where === "below" || where === "above";
			const after = where === "below" || where === "after";
			await session.put(lines, linewise ? "l" : "c", after);
			if (session.speed === "demo") await new Promise((r) => setTimeout(r, 150));
			return text(formatSnap(await session.snapshot({ max_changed: 12 })));
		});
	},
});

const viewTool = defineTool({
	name: "nvim_view",
	label: "nvim view",
	description:
		"Read numbered lines from a Neovim buffer (live, unsaved content included). Defaults to the current buffer. " +
		"A path loads the file into a hidden buffer without switching to it. Read narrow ranges.",
	promptSnippet: "Read numbered lines from a Neovim buffer",
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "File path (default: current buffer)" })),
		start: Type.Optional(Type.Number({ description: "First line (1-based)" })),
		end: Type.Optional(Type.Number({ description: "Last line (default start+199)" })),
	}),
	executionMode: "sequential",
	async execute(_id, p, _signal, _onUpdate, ctx) {
		await session.ensure(ctx.cwd);
		const v = await session.lua<{ file: string; lines: number; range: [number, number]; text: string }>(
			"return PiAgent.view(...)",
			[p.path ?? "", p.start ?? 1, p.end ?? 0],
		);
		return text(`${v.file} (${v.range[0]}-${v.range[1]} of ${v.lines})\n${v.text}`);
	},
});

const grepTool = defineTool({
	name: "nvim_grep",
	label: "nvim grep",
	description:
		"Search the project with :grep (ripgrep, smart-case regex). Results fill the quickfix list, which opens visibly. " +
		"Follow up with `nvim_ex` commands like `cdo s/a/b/g | update`, `cfirst` or `cnext`.",
	promptSnippet: "Project search via :grep into the quickfix list",
	parameters: Type.Object({
		pattern: Type.String({ description: "ripgrep regex" }),
		glob: Type.Optional(Type.String({ description: "Optional file glob, e.g. '*.ts' or 'src/**'" })),
	}),
	executionMode: "sequential",
	async execute(_id, p, _signal, _onUpdate, ctx) {
		return withNvim(ctx, `grep ${truncLabel(p.pattern, 30)}`, async () => {
			const esc = (s: string) => shellQuote(s).replace(/[%#|]/g, (m) => `\\${m}`);
			const cmd = `silent grep! ${esc(p.pattern)}${p.glob ? ` -g ${esc(p.glob)}` : ""}`;
			await session.ex(cmd);
			await session.lua(
				"if #vim.fn.getqflist() > 0 then vim.cmd('botright copen 8') vim.cmd('wincmd p') else vim.cmd('cclose') end",
			);
			const snap = await session.snapshot({ qf: 50 });
			delete snap.output; // the `:!rg … | tee` echo; quickfix carries the results
			if (!snap.qf) snap.msg = "no matches";
			return text(formatSnap(snap));
		});
	},
});

const lspTool = defineTool({
	name: "nvim_lsp",
	label: "nvim lsp",
	description:
		"Run LSP actions at the cursor in Neovim. definition/references/implementation/type_definition jump to the result " +
		"(several results fill quickfix). hover returns docs. rename renames across the workspace (arg = new name). " +
		"symbols lists document symbols; workspace_symbol searches (arg = query). code_actions lists actions; apply_code_action " +
		"applies one (arg = index or title substring). diagnostics lists buffer diagnostics (arg 'workspace' for all).",
	promptSnippet: "LSP actions in Neovim: definition, references, rename, hover, symbols, code actions, diagnostics",
	parameters: Type.Object({
		action: StringEnum([
			"definition",
			"references",
			"implementation",
			"type_definition",
			"hover",
			"rename",
			"symbols",
			"workspace_symbol",
			"code_actions",
			"apply_code_action",
			"diagnostics",
		] as const),
		arg: Type.Optional(Type.String({ description: "New name, query, action index/title, or 'workspace'" })),
	}),
	executionMode: "sequential",
	async execute(_id, p, _signal, _onUpdate, ctx) {
		return withNvim(ctx, `lsp ${p.action}${p.arg ? ` ${truncLabel(p.arg, 20)}` : ""}`, async () => {
			const res = await session.lua<Record<string, unknown>>("return PiAgent.lsp(...)", [p.action, p.arg ?? ""]);
			const parts: string[] = [];
			for (const [k, v] of Object.entries(res ?? {})) {
				if (Array.isArray(v)) parts.push(`${k} (${v.length}):\n${v.join("\n")}`);
				else if (v && typeof v === "object") parts.push(`${k}: ${JSON.stringify(v)}`);
				else parts.push(`${k}: ${v}`);
			}
			const snap = await session.snapshot({ max_changed: p.action === "rename" ? 10 : 30 });
			return text(formatSnap(snap, parts.join("\n")));
		});
	},
});

const checkTool = defineTool({
	name: "nvim_check",
	label: "nvim check",
	description:
		"Save all buffers, wait for LSP diagnostics to settle, and return workspace errors and warnings. Use it to verify edits before running tests.",
	promptSnippet: "Save all and return settled LSP diagnostics",
	parameters: Type.Object({}),
	executionMode: "sequential",
	async execute(_id, _p, _signal, _onUpdate, ctx) {
		return withNvim(ctx, "checking diagnostics", async () => {
			const r = await session.lua<{ counts: Record<string, number>; items: string[]; lsp: string[] }>(
				"return PiAgent.check()",
			);
			const c = r.counts;
			const head = `lsp: ${r.lsp.join(", ") || "(none attached)"} | E${c.E ?? 0} W${c.W ?? 0} I${c.I ?? 0} H${c.H ?? 0}`;
			return text(r.items.length ? `${head}\n${r.items.join("\n")}` : `${head}\nno errors or warnings`);
		});
	},
});

const screenTool = defineTool({
	name: "nvim_screen",
	label: "nvim screen",
	description:
		"Read the visible Neovim screen from the herdr pane. Only use it for floating UIs or prompts that snapshots can't describe.",
	parameters: Type.Object({}),
	executionMode: "sequential",
	async execute(_id, _p, _signal, _onUpdate, ctx) {
		await session.ensure(ctx.cwd);
		return text(await session.screen());
	},
});

// Bash commands that bypass the editor.
const BASH_BLOCKS: [RegExp, string][] = [
	[/\bsed\b[^|;&]*\s-i/, "in-place sed"],
	[/\bperl\b[^|;&]*\s-[a-z]*i/, "in-place perl"],
	[/(^|[^0-9&>])>>?\s*(?!\/dev\/null|&|\/tmp\/)[^\s|;&]/, "redirecting output into a file"],
	[/(^|[|;&]\s*)tee\b/, "tee into files"],
	[/(^|;|&&|\|\|)\s*(cat|head|tail|bat|less|more|nl)\s+(-\S+\s+)*[^-\s|<]/, "reading files via shell"],
	[/(^|;|&&|\|\|)\s*(rg|grep|ag|ack|find)\b/, "searching via shell"],
	[/\b(python3?|node|ruby)\b\s+-[ce]\b.*\b(write|open|writeFile)/, "scripted file writes"],
];

export default function (pi: ExtensionAPI) {
	for (const t of [keysTool, exTool, insertTool, viewTool, grepTool, lspTool, checkTool, screenTool]) {
		pi.registerTool(t as any);
	}

	pi.on("session_start", async () => {
		if (!policyEnabled) return;
		pi.setActiveTools(pi.getActiveTools().filter((t) => !DISABLED_BUILTINS.includes(t)));
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.nvim_playbook = playbook;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: string }).command ?? "");
		if (policyEnabled) {
			for (const [re, what] of BASH_BLOCKS) {
				if (re.test(command)) {
					return {
						block: true,
						reason: `Blocked (${what}). Read, search and edit through the nvim_* tools: nvim_view, nvim_grep, nvim_lsp, nvim_keys, nvim_ex, nvim_insert.`,
					};
				}
			}
		}
		if (session.connected) await session.saveAll();
		void ctx;
	});

	pi.on("session_shutdown", async () => {
		await session.disconnect(process.env.PI_NVIM_CLOSE === "1");
	});

	pi.registerCommand("nvim", {
		description: "Open (or attach to) the agent's Neovim pane",
		handler: async (_args, ctx) => {
			try {
				await session.ensure(ctx.cwd);
				ctx.ui.notify(`nvim ready (${session.paneId ?? session.socket})`, "info");
			} catch (e) {
				ctx.ui.notify(String((e as Error).message), "error");
			}
		},
	});

	pi.registerCommand("nvim-speed", {
		description: "Set typing speed: demo (paced, watchable) or fast",
		handler: async (args, ctx) => {
			const v = args.trim();
			if (v === "demo" || v === "fast") session.speed = v;
			ctx.ui.notify(`nvim speed: ${session.speed}`, "info");
		},
	});

	pi.registerCommand("nvim-close", {
		description: "Quit the agent's Neovim and close its pane",
		handler: async (_args, ctx) => {
			await session.disconnect(true);
			ctx.ui.notify("nvim closed", "info");
		},
	});
}
