/**
 * mystique — let any coding agent shapeshift into a Neovim power user and drive a live, visible editor.
 * The Neovim is either the one pi runs inside (a :terminal split, e.g. sidekick.nvim),
 * one the user points us at (MYSTIQUE_SOCKET), or one we spawn in a herdr pane.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Caps, detectMode, NvimSession, renderCapabilities, type Snapshot } from "../core/nvim.ts";
import { findRun, grepRun, testDiagnosis } from "../core/tools.ts";


// Back-compat: the project used to be "pi-nvim-dev" with PI_NVIM_* env vars. Honor the old
// names when the new MYSTIQUE_* ones aren't set, before anything reads them.
for (const k of ["SOCKET", "SPEED", "POLICY", "CLOSE", "REFOCUS", "AUTOSTART", "KEYMAP_DENY"]) {
  const legacy = process.env[`PI_NVIM_${k}`];
  if (legacy !== undefined && process.env[`MYSTIQUE_${k}`] === undefined) {
    process.env[`MYSTIQUE_${k}`] = legacy;
  }
}
const here = dirname(fileURLToPath(import.meta.url));
const session = new NvimSession(join(here, "..", "core", "lua", "mystique.lua"));
const playbook = readFileSync(join(here, "..", "core", "prompt.md"), "utf8");
const cacheFile = join(homedir(), ".cache", "mystique", "keymaps.txt");
const capFile = join(homedir(), ".cache", "mystique", "capabilities.json");

// Without a reachable Neovim (not inside one, not in herdr, no MYSTIQUE_SOCKET) the extension stays
// inert: builtin tools and bash keep working, so a globally installed copy never cripples plain pi.
const active = detectMode() !== undefined;
const policyEnabled = active && process.env.MYSTIQUE_POLICY !== "off";
const DISABLED_BUILTINS = ["read", "edit", "write", "grep", "find", "ls"];

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/** Structured details for the TUI renderers (the model only sees `content`). */
interface NvimDetails {
  status?: string;
  changed?: string[];
  err?: string;
  notice?: string;
  extra?: string;
  summary?: string;
}

function statusLine(s: Snapshot): string {
  const flags = [s.mod ? "[+]" : "", s.diag.E ? `E${s.diag.E}` : "", s.diag.W ? `W${s.diag.W}` : ""]
    .filter(Boolean)
    .join(" ");
  return `[${s.mode}] ${s.file || "[No Name]"}:${s.cur[0]}:${s.cur[1]}/${s.lines} ${flags}`.trimEnd();
}

/** Render a snapshot as compact text for the model, plus details for the renderer. */
function snapResult(s: Snapshot, opts: { extra?: string; notice?: string } = {}) {
  const out: string[] = [];
  const details: NvimDetails = { status: statusLine(s), changed: [] };
  if (opts.notice) {
    out.push(opts.notice);
    details.notice = opts.notice;
  }
  if (opts.extra) {
    out.push(opts.extra);
    details.extra = opts.extra;
  }
  if (s.err) {
    out.push(`ERROR: ${s.err}`);
    details.err = s.err;
  }
  if (s.output) out.push(`output:\n${s.output}`);
  if (s.msg) out.push(`msg: ${s.msg}`);
  if (s.synced === false) out.push("warning: keys may still be pending (no sync within timeout)");
  if (s.blocking) out.push(`BLOCKING prompt. Screen:\n${s.screen ?? "(unavailable)"}`);
  for (const c of s.changed ?? []) {
    const ranges = c.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
    details.changed!.push(`${c.file} ${ranges}`);
    out.push(c.text ? `changed ${c.file} ${ranges}:\n${c.text}` : `changed ${c.file} ${ranges}`);
  }
  if (s.qf) out.push(`quickfix (${s.qf.total}):\n${s.qf.items.join("\n")}`);
  if (s.floats?.length) out.push(`floating windows:\n${s.floats.join("\n")}`);
  out.push(details.status!);
  if (s.ctx) out.push(s.ctx);
  if (s.bufs && s.bufs.length > 1) out.push(`buffers: ${s.bufs.join(" ")}`);
  return { content: [{ type: "text" as const, text: out.join("\n") }], details };
}

function plain(text: string, details: NvimDetails = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Run a tool body with the status indicator and human-activity guard.
 * Cursor-sensitive tools (guard=true) don't run if the human touched the editor since the
 * last tool; the model gets a report of what changed and re-plans.
 */
async function withNvim(
  ctx: ExtensionContext,
  label: string,
  guard: boolean,
  fn: (notice?: string) => Promise<ReturnType<typeof plain>>,
) {
  await session.ensure(ctx.cwd);
  const activity = await session.startTool(label);
  try {
    const notice = activity ? `The user interacted with Neovim since your last action:\n${activity}` : undefined;
    if (activity && guard) {
      return snapResult(await session.snapshot(), {
        notice: `${notice}\nYour action was NOT executed. Re-check the state below and re-plan.`,
      });
    }
    return await fn(notice);
  } finally {
    await session.endTool();
  }
}

const trunc = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

function title(theme: Theme, icon: string, name: string) {
  return theme.fg("toolTitle", theme.bold(`${icon} ${name} `));
}

function renderKeys(keys: string, theme: Theme) {
  return (keys.match(/<[^<>\s]+>|[^<]+|</g) ?? [])
    .map((t) => (t.length > 1 && t.startsWith("<") ? theme.fg("muted", t) : theme.fg("accent", t)))
    .join("");
}

function renderNvimResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  opts: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  if (opts.isPartial) return new Text(theme.fg("warning", "…"), 0, 0);
  const d = (result.details ?? {}) as NvimDetails;
  const full = result.content.find((c) => c.type === "text")?.text ?? "";
  const lines: string[] = [];
  if (d.notice) lines.push(theme.fg("warning", `⚠ ${d.notice.split("\n").slice(0, 3).join(" · ")}`));
  if (d.err) lines.push(theme.fg("error", `✗ ${d.err.split("\n")[0]}`));
  if (d.extra) lines.push(theme.fg("toolOutput", trunc(d.extra.split("\n").slice(0, 2).join(" · "), 120)));
  if (d.summary) lines.push(theme.fg("success", d.summary));
  for (const c of d.changed ?? []) lines.push(theme.fg("success", `~ ${c}`));
  if (d.status) lines.push(theme.fg("dim", d.status));
  if (lines.length === 0) lines.push(theme.fg("dim", trunc(full.split("\n")[0] ?? "", 120)));
  if (opts.expanded) {
    for (const l of full.split("\n").slice(0, 40)) lines.push(theme.fg("dim", l));
  }
  return new Text(lines.join("\n"), 0, 0);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const keysTool = defineTool({
  name: "nvim_keys",
  label: "nvim keys",
  description:
    "Type keystrokes into the live Neovim using Vim key notation (<CR>, <Esc>, <C-w>, <leader>, <lt> for a literal '<'). " +
    "Use it for motions, text objects, operators, counts, macros, registers, search (/pat<CR>) and the user's own mappings. Returns a compact editor snapshot.",
  promptSnippet: "Type Vim keystrokes into the live Neovim (motions, text objects, macros, mappings)",
  parameters: Type.Object({
    keys: Type.String({ description: "Keys in Vim notation, e.g. `ciwnewName<Esc>` or `/foo<CR>cgnbar<Esc>..`" }),
  }),
  executionMode: "sequential",
  renderCall: (args, theme) => new Text(title(theme, "⌨", "keys") + renderKeys(args.keys ?? "", theme), 0, 0),
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    return withNvim(ctx, `⌨ ${trunc(p.keys)}`, true, async () => {
      const synced = await session.keys(session.expandLeader(p.keys));
      const snap = await session.snapshot();
      snap.synced = synced;
      return snapResult(snap);
    });
  },
});

const exTool = defineTool({
  name: "nvim_ex",
  label: "nvim :",
  description:
    "Run an Ex command in Neovim (without the leading ':'). It is shown on the cmdline for the human. Examples: `e src/a.ts`, `%s/\\<foo\\>/bar/g`, " +
    "`g/TODO/d`, `cdo s/a/b/g | update`, `10,20norm A;`, `w`. Returns the command output and a snapshot.",
  promptSnippet: "Run an Ex command in Neovim (:e, :s, :g, :norm, :cdo, :w …)",
  parameters: Type.Object({ cmd: Type.String({ description: "Ex command without the leading ':'" }) }),
  executionMode: "sequential",
  renderCall: (args, theme) => new Text(title(theme, ":", "ex") + theme.fg("accent", args.cmd ?? ""), 0, 0),
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    return withNvim(ctx, `:${trunc(p.cmd)}`, true, async () => {
      await session.ex(p.cmd);
      return snapResult(await session.snapshot());
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
  renderCall: (args, theme) => {
    const lines = (args.text ?? "").split("\n");
    const first = lines.find((l) => l.trim()) ?? "";
    return new Text(
      title(theme, "⇣", "paste") +
      theme.fg("dim", `${lines.length} line(s) ${args.where ?? "below"} `) +
      theme.fg("muted", trunc(first.trim(), 60)),
      0,
      0,
    );
  },
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    const where = p.where ?? "below";
    const lines = p.text.replace(/\n$/, "").split("\n");
    return withNvim(ctx, `paste ${lines.length} line(s) ${where}`, true, async () => {
      const linewise = where === "below" || where === "above";
      if (linewise) await session.keys("<C-\\><C-n>");
      await session.put(lines, linewise ? "l" : "c", where === "below" || where === "after");
      if (session.speed === "demo") await new Promise((r) => setTimeout(r, 150));
      return snapResult(await session.snapshot({ max_changed: 12 }));
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
  renderCall: (args, theme) =>
    new Text(
      title(theme, "👁", "view") +
      theme.fg("accent", args.path ?? "(current buffer)") +
      theme.fg("dim", args.start || args.end ? ` ${args.start ?? 1}-${args.end ?? ""}` : ""),
      0,
      0,
    ),
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    return withNvim(ctx, `view ${p.path ?? "buffer"}`, false, async (notice) => {
      const v = await session.lua<{ file: string; lines: number; range: [number, number]; text: string }>(
        "return Mystique.view(...)",
        [p.path ?? "", p.start ?? 1, p.end ?? 0],
      );
      const head = `${v.file} (${v.range[0]}-${v.range[1]} of ${v.lines})`;
      return plain([notice, head, v.text].filter(Boolean).join("\n"), {
        summary: `${v.range[1] - v.range[0] + 1} lines of ${v.file}`,
        notice,
      });
    });
  },
});

const grepTool = defineTool({
  name: "nvim_grep",
  label: "nvim grep",
  description:
    "Search the project with ripgrep (smart-case regex); scope with `path`. Returns hits grouped by file (or per-file counts when there are many); all hits fill the quickfix list, which opens visibly. " +
    "Follow up with `nvim_ex` commands like `cdo s/a/b/g | update`, `cfirst` or `cnext`.",
  promptSnippet: "Project search (ripgrep) into the quickfix list",
  parameters: Type.Object({
    pattern: Type.String({ description: "ripgrep regex" }),
    path: Type.Optional(
      Type.String({ description: "Directory or file to search, e.g. 'src' (keeps .gitignore in effect)" }),
    ),
    glob: Type.Optional(
      Type.String({ description: "File filter: '*.ts' matches names anywhere, 'src/**/*.ts' paths, '!*.md' excludes (.gitignore still applies)" }),
    ),
    limit: Type.Optional(Type.Number({ description: "Max hits listed line by line (default 40); above it you get per-file counts" })),
    word: Type.Optional(Type.Boolean({ description: "Whole-word matches only (e.g. `id` won't match `userId`)" })),
    literal: Type.Optional(Type.Boolean({ description: "Pattern is a literal string, not a regex (no escaping needed)" })),
    case: Type.Optional(
      StringEnum(["smart", "sensitive", "ignore"] as const, {
        description: "Default smart: case-insensitive unless the pattern has uppercase",
      }),
    ),
    context: Type.Optional(
      Type.Number({ description: "Lines of context around each listed hit (0-5); saves a follow-up nvim_view" }),
    ),
  }),
  executionMode: "sequential",
  renderCall: (args, theme) =>
    new Text(
      title(theme, "🔍", "grep") +
      theme.fg("accent", args.pattern ?? "") +
      theme.fg("dim", [args.path, args.glob, args.word && "word", args.literal && "literal", args.case && args.case !== "smart" && args.case].filter(Boolean).map((s) => `  ${s}`).join("")),
      0,
      0,
    ),
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    return withNvim(ctx, `grep ${trunc(p.pattern, 30)}`, false, async (notice) => {
      const r = await grepRun(session, p);
      const summary = r.total ? `${r.total} match(es) in ${r.files} file(s), quickfix` : "no matches";
      return plain(notice ? `${notice}\n${r.text}` : r.text, { notice, summary });
    });
  },
});

const findTool = defineTool({
  name: "nvim_find",
  label: "nvim find",
  description:
    "Find files by name: fuzzy-match a query against the project's file paths (rg --files, .gitignore applies), " +
    "best matches first, like a picker's find_files. Then open one with `nvim_ex` `e <path>`.",
  promptSnippet: "Fuzzy file-name search (find_files without the picker UI)",
  parameters: Type.Object({
    query: Type.String({ description: "Fuzzy query, e.g. 'tools', 'ext/index', 'nvimtest'" }),
    path: Type.Optional(Type.String({ description: "Directory to search (default: project root)" })),
    limit: Type.Optional(Type.Number({ description: "Max paths returned (default 20)" })),
  }),
  executionMode: "sequential",
  renderCall: (args, theme) =>
    new Text(
      title(theme, "📄", "find") + theme.fg("accent", args.query ?? "") + theme.fg("dim", args.path ? `  ${args.path}` : ""),
      0,
      0,
    ),
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    return withNvim(ctx, `find ${trunc(p.query, 30)}`, false, async (notice) => {
      const r = await findRun(session, p);
      const summary = r.total ? `${r.total} file(s)` : "no files";
      return plain(notice ? `${notice}\n${r.text}` : r.text, { notice, summary });
    });
  },
});

const LSP_ACTIONS = [
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
] as const;

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
    action: StringEnum(LSP_ACTIONS),
    arg: Type.Optional(Type.String({ description: "New name, query, action index/title, or 'workspace'" })),
  }),
  executionMode: "sequential",
  renderCall: (args, theme) =>
    new Text(
      title(theme, "λ", "lsp") +
      theme.fg("accent", args.action ?? "") +
      (args.arg ? theme.fg("muted", args.action === "rename" ? ` → ${args.arg}` : ` ${args.arg}`) : ""),
      0,
      0,
    ),
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    const cursorFree = p.action === "workspace_symbol" || p.action === "diagnostics";
    return withNvim(ctx, `lsp ${p.action}${p.arg ? ` ${trunc(p.arg, 20)}` : ""}`, !cursorFree, async (notice) => {
      const res = await session.lua<Record<string, unknown>>("return Mystique.lsp(...)", [p.action, p.arg ?? ""]);
      const parts: string[] = [];
      for (const [k, v] of Object.entries(res ?? {})) {
        if (Array.isArray(v)) parts.push(`${k} (${v.length}):\n${v.join("\n")}`);
        else if (v && typeof v === "object") parts.push(`${k}: ${JSON.stringify(v)}`);
        else parts.push(`${k}: ${v}`);
      }
      const snap = await session.snapshot({ max_changed: p.action === "rename" ? 10 : 30 });
      return snapResult(snap, { extra: parts.join("\n"), notice });
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
  renderCall: (_args, theme) => new Text(title(theme, "✓", "check") + theme.fg("dim", "save all + LSP diagnostics"), 0, 0),
  renderResult: (result, opts, theme) => {
    if (opts.isPartial) return new Text(theme.fg("warning", "waiting for diagnostics…"), 0, 0);
    const d = (result.details ?? {}) as NvimDetails;
    const full = (result.content[0] as { text?: string })?.text ?? "";
    const ok = d.summary?.includes("E0 W0");
    let text = theme.fg(ok ? "success" : "error", d.summary ?? full.split("\n")[0]);
    const body = full.split("\n").slice(1, opts.expanded ? 40 : 6);
    for (const l of body) text += `\n${theme.fg(l.startsWith("E ") ? "error" : "dim", l)}`;
    return new Text(text, 0, 0);
  },
  async execute(_id, _p, _signal, _onUpdate, ctx) {
    return withNvim(ctx, "checking diagnostics", false, async (notice) => {
      const r = await session.lua<{ counts: Record<string, number>; items: string[]; lsp: string[] }>(
        "return Mystique.check()",
        [],
        40000,
      );
      const c = r.counts;
      const head = `lsp: ${r.lsp.join(", ") || "(none attached)"} | E${c.E ?? 0} W${c.W ?? 0} I${c.I ?? 0} H${c.H ?? 0}`;
      const body = r.items.length ? `${head}\n${r.items.join("\n")}` : `${head}\nno errors or warnings`;
      return plain(notice ? `${notice}\n${body}` : body, { summary: head, notice });
    });
  },
});

const testsTool = defineTool({
  name: "nvim_tests",
  label: "nvim tests",
  description:
    "Read the results of the most recent test run (waits for in-flight runs to finish) and return pass/fail " +
    "counts and failure messages with locations. To start a run, prefer nvim_test.",
  promptSnippet: "Wait for neotest runs and read pass/fail counts and failures",
  parameters: Type.Object({
    timeout: Type.Optional(Type.Number({ description: "Max seconds to wait for running tests (default 60)" })),
  }),
  executionMode: "sequential",
  renderCall: (_args, theme) => new Text(title(theme, "🧪", "tests") + theme.fg("dim", "wait for neotest results"), 0, 0),
  renderResult: (result, opts, theme) => {
    if (opts.isPartial) return new Text(theme.fg("warning", "tests running…"), 0, 0);
    const d = (result.details ?? {}) as NvimDetails & { failed?: number };
    const full = (result.content[0] as { text?: string })?.text ?? "";
    let text = theme.fg(d.failed ? "error" : "success", d.summary ?? full.split("\n")[0]);
    if (d.failed || opts.expanded) {
      for (const l of full.split("\n").slice(1, opts.expanded ? 60 : 8)) text += `\n${theme.fg("dim", l)}`;
    }
    return new Text(text, 0, 0);
  },
  async execute(_id, p, _signal, _onUpdate, ctx) {
    const timeout = Math.max(5, p.timeout ?? 60);
    return withNvim(ctx, "waiting for tests", false, async (notice) => {
      const r = await session.lua<TestResult>("return Mystique.tests(...)", [timeout * 1000], (timeout + 15) * 1000);
      return formatTests(r, notice);
    });
  },
});

type TestCounts = { total: number; passed: number; failed: number; skipped: number; running: number };
type TestResult = {
  counts: TestCounts;
  failures: string[];
  timed_out: boolean;
  unsaved?: string[];
  output?: string;
  errors?: string[];
  hint?: string;
};

function formatTests(r: TestResult, notice?: string, prefix?: string) {
  const c = r.counts;
  const summary = `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (${c.total} total)${r.timed_out ? ", still running" : ""}`;
  const body = [
    notice,
    prefix,
    summary,
    // Adapter errors or an empty fresh run: say so and name the command that works (don't imply success).
    ...testDiagnosis(r, !!prefix),
    r.unsaved?.length
      ? `WARNING: unsaved buffers (${r.unsaved.join(", ")}): tests ran against the files on disk. Run \`wa\` and re-run.`
      : "",
    ...(r.failures.length ? ["failures:", ...r.failures] : []),
    r.output ? `runner output (tail):\n${r.output}` : "",
  ].filter(Boolean);
  return { content: [{ type: "text" as const, text: body.join("\n") }], details: { summary, failed: c.failed, notice } };
}

const testTool = defineTool({
  name: "nvim_test",
  label: "nvim test",
  description:
    "Run tests and wait for results, config-agnostic (neotest, else vim-test). scope: 'nearest' (cursor in a test), " +
    "'file' (current file), or 'suite'. Saves all buffers first. Returns pass/fail counts and failures. No keymap needed.",
  promptSnippet: "Run tests (neotest/vim-test) and wait for results (scope: nearest|file|suite)",
  parameters: Type.Object({
    scope: Type.Optional(StringEnum(["nearest", "file", "suite"], { description: "What to run (default nearest)" })),
    timeout: Type.Optional(Type.Number({ description: "Max seconds to wait (default 60)" })),
  }),
  executionMode: "sequential",
  renderCall: (args, theme) =>
    new Text(title(theme, "🧪", "test") + theme.fg("dim", `run ${args.scope ?? "nearest"}`), 0, 0),
  renderResult: (result, opts, theme) => {
    if (opts.isPartial) return new Text(theme.fg("warning", "tests running…"), 0, 0);
    const d = (result.details ?? {}) as NvimDetails & { failed?: number };
    const full = (result.content[0] as { text?: string })?.text ?? "";
    let text = theme.fg(d.failed ? "error" : "success", d.summary ?? full.split("\n")[0]);
    if (d.failed || opts.expanded) {
      for (const l of full.split("\n").slice(1, opts.expanded ? 60 : 8)) text += `\n${theme.fg("dim", l)}`;
    }
    return new Text(text, 0, 0);
  },
  async execute(_id, p, _signal, _onUpdate, ctx) {
    const scope = p.scope ?? "nearest";
    const timeout = Math.max(5, p.timeout ?? 60);
    return withNvim(ctx, `running ${scope} tests`, false, async (notice) => {
      await session.ex("silent! wall");
      const run = await session.lua<{ backend: string; started: boolean; err?: string }>(
        "return Mystique.test_run(...)",
        [scope],
        15000,
      );
      if (!run.started) {
        return plain(`${notice ? `${notice}\n` : ""}could not start tests (${run.backend}): ${run.err ?? "unknown"}`, {
          notice,
        });
      }
      const r = await session.lua<TestResult>("return Mystique.tests(...)", [timeout * 1000], (timeout + 15) * 1000);
      return formatTests(r, notice, `ran ${scope} via ${run.backend}`);
    });
  },
});

const screenTool = defineTool({
  name: "nvim_screen",
  label: "nvim screen",
  description:
    "Read the visible Neovim screen as text. Only use it for floating UIs or prompts that snapshots can't describe.",
  parameters: Type.Object({}),
  executionMode: "sequential",
  renderCall: (_args, theme) => new Text(title(theme, "▢", "screen"), 0, 0),
  renderResult: renderNvimResult,
  async execute(_id, _p, _signal, _onUpdate, ctx) {
    await session.ensure(ctx.cwd);
    const screen = await session.screen();
    return plain(screen, { summary: `${screen.split("\n").length} screen rows` });
  },
});

const formatTool = defineTool({
  name: "nvim_format",
  label: "nvim format",
  description:
    "Format the current buffer (or a line range) using whatever the config provides: conform, else LSP formatting, " +
    "else the built-in 'gq'. Config-agnostic — no personal keymap needed. Returns the changed lines in a snapshot.",
  promptSnippet: "Format the current buffer via conform/LSP/gq (no keymap needed)",
  parameters: Type.Object({
    first: Type.Optional(Type.Number({ description: "First line of a range to format (1-based)" })),
    last: Type.Optional(Type.Number({ description: "Last line of a range to format (1-based)" })),
  }),
  executionMode: "sequential",
  renderCall: (args, theme) =>
    new Text(
      title(theme, "⟳", "format") +
      theme.fg("dim", args.first && args.last ? `lines ${args.first}-${args.last}` : "buffer"),
      0,
      0,
    ),
  renderResult: renderNvimResult,
  async execute(_id, p, _signal, _onUpdate, ctx) {
    return withNvim(ctx, "formatting", true, async (notice) => {
      const r = await session.lua<{ backend: string; ok: boolean; err?: string }>(
        "return Mystique.format(...)",
        [p.first ?? null, p.last ?? null],
        15000,
      );
      const snap = await session.snapshot();
      const extra = r.ok ? `formatted via ${r.backend}` : `format failed (${r.backend}): ${r.err ?? "unknown"}`;
      return snapResult(snap, { notice, extra });
    });
  },
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

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

function loadCachedCheatsheet(): string | undefined {
  try {
    return readFileSync(cacheFile, "utf8");
  } catch {
    return undefined;
  }
}

function saveCheatsheet(text: string) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, text);
  } catch { }
}

/** The cached capability manifest, rendered from the structured JSON so reconnects stay consistent. */
function loadCachedCapabilities(): string | undefined {
  try {
    return renderCapabilities(JSON.parse(readFileSync(capFile, "utf8")) as Caps);
  } catch {
    return undefined;
  }
}

function saveCapabilities(caps: Caps) {
  try {
    mkdirSync(dirname(capFile), { recursive: true });
    writeFileSync(capFile, JSON.stringify(caps));
  } catch { }
}

export default function(pi: ExtensionAPI) {
  for (const t of [keysTool, exTool, insertTool, viewTool, grepTool, findTool, lspTool, checkTool, testsTool, screenTool, testTool, formatTool]) {
    pi.registerTool(t as any);
  }

  async function start(ctx: ExtensionContext) {
    await session.ensure(ctx.cwd);
    if (session.cheatsheet) saveCheatsheet(session.cheatsheet);
    if (session.caps) saveCapabilities(session.caps);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!active && ctx.mode === "tui") {
      ctx.ui.notify("mystique: no Neovim detected (run pi inside Neovim, herdr, or set MYSTIQUE_SOCKET); inactive", "warning");
    }
    if (policyEnabled) {
      pi.setActiveTools(pi.getActiveTools().filter((t) => !DISABLED_BUILTINS.includes(t)));
    }
    // In the interactive TUI, connect right away so the editor is visible next to (or around) pi.
    if (ctx.mode === "tui" && active && process.env.MYSTIQUE_AUTOSTART !== "0") {
      start(ctx).catch((e) => ctx.ui.notify(`nvim: ${(e as Error).message}`, "error"));
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!active) return;
    if (!session.connected) await start(ctx).catch(() => { });
    event.systemPromptOptions.sections.nvim_playbook = playbook;
    const sheet = session.cheatsheet ?? loadCachedCheatsheet();
    if (sheet) event.systemPromptOptions.sections.nvim_keymaps = sheet;
    // Capabilities drift per buffer (attached LSP, treesitter), so refresh them live each turn
    // when connected; otherwise fall back to the cached manifest.
    if (session.connected) {
      await session.loadCapabilities().catch(() => { });
      if (session.caps) saveCapabilities(session.caps);
    }
    const caps = session.capabilities ?? loadCachedCapabilities();
    if (caps) event.systemPromptOptions.sections.nvim_capabilities = caps;
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: string }).command ?? "");
    if (policyEnabled) {
      for (const [re, what] of BASH_BLOCKS) {
        if (re.test(command)) {
          return {
            block: true,
            reason: `Blocked (${what}). Read, search and edit through the nvim_* tools: nvim_view, nvim_grep, nvim_find, nvim_lsp, nvim_keys, nvim_ex, nvim_insert.`,
          };
        }
      }
    }
    if (session.connected) await session.saveAll();
  });

  // When pi lives inside the editor, the run took the cursor away from the pi terminal; give it back.
  pi.on("agent_end", async () => {
    await session.endRun();
  });

  pi.on("session_shutdown", async () => {
    await session.disconnect(process.env.MYSTIQUE_CLOSE === "1");
  });

  pi.registerCommand("nvim", {
    description: "Connect to Neovim: the host editor, MYSTIQUE_SOCKET, or a new herdr pane",
    handler: async (_args, ctx) => {
      try {
        await start(ctx);
        ctx.ui.notify(`nvim ready: ${session.describe()}`, "info");
      } catch (e) {
        ctx.ui.notify(String((e as Error).message), "error");
      }
    },
  });

  pi.registerCommand("nvim-keymaps", {
    description: "Show the keymap cheat sheet given to the agent",
    handler: async (_args, ctx) => {
      ctx.ui.notify(session.cheatsheet ?? loadCachedCheatsheet() ?? "(not loaded yet; run /nvim)", "info");
    },
  });

  pi.registerCommand("nvim-capabilities", {
    description: "Show the capability manifest given to the agent",
    handler: async (_args, ctx) => {
      ctx.ui.notify(session.capabilities ?? loadCachedCapabilities() ?? "(not loaded yet; run /nvim)", "info");
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
    description: "Close the agent's Neovim pane, or detach from the host editor",
    handler: async (_args, ctx) => {
      const owned = session.ownsPane;
      await session.disconnect(true);
      ctx.ui.notify(owned ? "nvim closed" : "detached from nvim (editor left open)", "info");
    },
  });
}
