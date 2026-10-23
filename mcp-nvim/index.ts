/**
 * mcp-nvim — an MCP server exposing Mystique's nvim_* tools, backed by @mystique/core,
 * so any MCP-capable agent (Claude Code, etc.) can drive a live, visible Neovim.
 *
 * It reaches Neovim exactly like the pi extension: embedded ($NVIM), external
 * (MYSTIQUE_SOCKET), or a herdr pane. With none reachable the tools return a clear
 * error instead of hanging.
 *
 *   claude mcp add nvim -- node --import tsx /path/to/mystique/mcp-nvim/index.ts
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { detectMode, NvimSession } from "../core/nvim.ts";
import * as tools from "../core/tools.ts";
import { loadCapabilities, loadCheatsheet, saveCapabilities, saveCheatsheet } from "../core/cache.ts";

const luaPath = fileURLToPath(new URL("../core/lua/mystique.lua", import.meta.url));

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

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): TextResult => ({ content: [{ type: "text", text: text || "(no output)" }] });
const fail = (text: string): TextResult => ({ content: [{ type: "text", text }], isError: true });
/** The <nvim_capabilities> + <nvim_keymaps> context block, from the live session or the cache. */
export function contextBlock(session: NvimSession): string {
  const caps = session.capabilities ?? loadCapabilities();
  const sheet = session.cheatsheet ?? loadCheatsheet();
  const parts: string[] = [];
  if (caps) parts.push(`<nvim_capabilities>\n${caps}\n</nvim_capabilities>`);
  if (sheet) parts.push(`<nvim_keymaps>\n${sheet}\n</nvim_keymaps>`);
  return parts.join("\n\n");
}

/**
 * Server instructions (Claude Code adds them to the system prompt). They are fixed at
 * startup, before Neovim is connected, so they carry the last cached manifest and point
 * at nvim_capabilities for a live refresh.
 */
function instructions(session: NvimSession): string {
  const intro =
    "These tools drive a live, visible Neovim shared with the human. Read and edit only through them. " +
    "The capabilities say which format/test/LSP backends this config has; call nvim_capabilities for a live " +
    "refresh (it is per buffer: attached LSP, treesitter) and whenever the sections below are missing.";
  const ctx = contextBlock(session);
  return ctx ? `${intro}\n\nLast known editor context (cached):\n${ctx}` : intro;
}

/** Persist the session's keymaps/capabilities so hooks and later sessions see them. */
function persist(session: NvimSession): void {
  if (session.cheatsheet) saveCheatsheet(session.cheatsheet);
  if (session.caps) saveCapabilities(session.caps);
}

/** Build the MCP server with all nvim_* tools bound to `session`. Exported for tests. */
export function createServer(session: NvimSession): McpServer {
  const server = new McpServer({ name: "mystique-mcp-nvim", version: "0.1.0" }, { instructions: instructions(session) });

  // Run a tool body with the shared-editor activity guard (mirrors the pi extension's
  // withNvim): detect what the human did since the last tool; for cursor-sensitive
  // tools, skip and report the new state so the agent re-plans; otherwise run and
  // prepend any human-activity notice.
  const run = async (label: string, guard: boolean, fn: () => Promise<string>): Promise<TextResult> => {
    if (detectMode() === undefined) {
      return fail(
        "No Neovim to drive. Start `nvim --listen <sock>` and set MYSTIQUE_SOCKET=<sock>, run inside a Neovim " +
        "terminal ($NVIM), or inside herdr.",
      );
    }
    try {
      await session.ensure(process.cwd());
      const activity = await session.startTool(label);
      try {
        const notice = activity ? `The user interacted with Neovim since your last action:\n${activity}` : "";
        if (activity && guard) {
          const snap = tools.snapshotToText(await session.snapshot());
          return ok(`${notice}\nYour action was NOT executed. Re-check the state below and re-plan.\n${snap}`);
        }
        const text = await fn();
        // Capabilities drift per buffer (attached LSP, treesitter); keep the cache the hooks read current.
        await session.loadCapabilities().then(() => persist(session), () => { });
        return ok(notice ? `${notice}\n${text}` : text);
      } finally {
        await session.endTool();
      }
    } catch (e) {
      return fail(`ERROR: ${(e as Error).message}`);
    }
  };

  server.registerTool(
    "nvim_keys",
    {
      description:
        "Type keystrokes into the live Neovim in Vim notation (<CR>, <Esc>, <C-w>, <leader>, <lt> for '<'). " +
        "Motions, text objects, operators, counts, macros, registers, search. Returns a compact editor snapshot.",
      inputSchema: { keys: z.string().describe("Keys in Vim notation, e.g. ciwnewName<Esc>") },
    },
    (a) => run("keys", true, () => tools.keys(session, a.keys)),
  );

  server.registerTool(
    "nvim_ex",
    {
      description:
        "Run an Ex command (no leading ':'). Examples: e src/a.ts, %s/\\<foo\\>/bar/g, g/TODO/d, " +
        "cdo s/a/b/g | update, 10,20norm A;, w. Returns command output and a snapshot.",
      inputSchema: { cmd: z.string().describe("Ex command without the leading ':'") },
    },
    (a) => run("ex", true, () => tools.ex(session, a.cmd)),
  );

  server.registerTool(
    "nvim_insert",
    {
      description:
        "Paste literal text into the current buffer as one undo step, bypassing auto-pairs and completion. " +
        "Use only for new text. where: below/above (linewise) or before/after (charwise) the cursor.",
      inputSchema: {
        text: z.string(),
        where: z.enum(["below", "above", "before", "after"]).optional().describe("Default: below"),
      },
    },
    (a) => run("insert", true, () => tools.insert(session, a.text, a.where)),
  );

  server.registerTool(
    "nvim_view",
    {
      description:
        "Read numbered lines from a Neovim buffer (live, unsaved content included). Defaults to the current buffer; " +
        "a path loads the file into a hidden buffer. Read narrow ranges.",
      inputSchema: {
        path: z.string().optional().describe("File path (default: current buffer)"),
        start: z.number().optional().describe("First line (1-based)"),
        end: z.number().optional().describe("Last line (default start+199)"),
      },
    },
    (a) => run("view", false, () => tools.view(session, a.path, a.start, a.end)),
  );

  server.registerTool(
    "nvim_grep",
    {
      description:
        "Search the project with ripgrep (smart-case regex). Returns hits grouped by file, or per-file counts when there are many; all hits fill the quickfix list. Follow up with nvim_ex `cdo s/a/b/g | update`.",
      inputSchema: {
        pattern: z.string().describe("ripgrep regex"),
        path: z.string().optional().describe("Directory or file to search, e.g. 'src' (keeps .gitignore in effect)"),
        glob: z.string().optional().describe("File filter: '*.ts' matches names anywhere, 'src/**/*.ts' paths, '!*.md' excludes (.gitignore still applies)"),
        limit: z.number().int().positive().optional().describe("Max hits listed line by line (default 40); above it you get per-file counts"),
        word: z.boolean().optional().describe("Whole-word matches only (e.g. `id` won't match `userId`)"),
        literal: z.boolean().optional().describe("Pattern is a literal string, not a regex (no escaping needed)"),
        case: z.enum(["smart", "sensitive", "ignore"]).optional().describe("Default smart: case-insensitive unless the pattern has uppercase"),
        context: z.number().int().min(0).max(5).optional().describe("Lines of context around each listed hit; saves a follow-up nvim_view"),
      },
    },
    (a) => run("grep", false, () => tools.grep(session, a)),
  );

  server.registerTool(
    "nvim_find",
    {
      description:
        "Find files by name: fuzzy-match a query against the project's file paths (rg --files, .gitignore applies), best first, like a picker's find_files. Open one with nvim_ex `e <path>`.",
      inputSchema: {
        query: z.string().describe("Fuzzy query, e.g. 'tools', 'ext/index', 'nvimtest'"),
        path: z.string().optional().describe("Directory to search (default: project root)"),
        limit: z.number().int().positive().optional().describe("Max paths returned (default 20)"),
      },
    },
    (a) => run("find", false, () => tools.find(session, a)),
  );

  server.registerTool(
    "nvim_lsp",
    {
      description:
        "Run LSP actions at the cursor: definition/references/implementation/type_definition (jump; many fill " +
        "quickfix), hover, rename (arg = new name), symbols, workspace_symbol (arg = query), code_actions, " +
        "apply_code_action (arg = index/title), diagnostics (arg 'workspace' for all).",
      inputSchema: {
        action: z.enum(LSP_ACTIONS),
        arg: z.string().optional().describe("New name, query, action index/title, or 'workspace'"),
      },
    },
    (a) => run(`lsp ${a.action}`, a.action !== "workspace_symbol" && a.action !== "diagnostics", () => tools.lsp(session, a.action, a.arg)),
  );

  server.registerTool(
    "nvim_check",
    {
      description: "Save all buffers, wait for LSP diagnostics to settle, and return workspace errors and warnings.",
      inputSchema: {},
    },
    () => run("check", false, () => tools.check(session)),
  );

  server.registerTool(
    "nvim_tests",
    {
      description: "Read the results of the most recent test run (waits for in-flight runs). Prefer nvim_test to start one.",
      inputSchema: { timeout: z.number().optional().describe("Max seconds to wait (default 60)") },
    },
    (a) => run("tests", false, () => tools.tests(session, a.timeout)),
  );

  server.registerTool(
    "nvim_test",
    {
      description:
        "Run tests and wait for results, config-agnostic (neotest, else vim-test). scope: nearest (cursor in a " +
        "test), file, or suite. Saves all buffers first.",
      inputSchema: {
        scope: z.enum(["nearest", "file", "suite"]).optional().describe("Default nearest"),
        timeout: z.number().optional().describe("Max seconds to wait (default 60)"),
      },
    },
    (a) => run("test", false, () => tools.testRun(session, a.scope, a.timeout)),
  );

  server.registerTool(
    "nvim_screen",
    {
      description: "Read the visible Neovim screen as text. Only for floating UIs or prompts a snapshot can't describe.",
      inputSchema: {},
    },
    () => run("screen", false, () => tools.screen(session)),
  );

  server.registerTool(
    "nvim_format",
    {
      description:
        "Format the current buffer (or a line range) using whatever the config provides: conform, else LSP, else gq.",
      inputSchema: {
        first: z.number().optional().describe("First line of a range (1-based)"),
        last: z.number().optional().describe("Last line of a range (1-based)"),
      },
    },
    (a) => run("format", true, () => tools.format(session, a.first, a.last)),
  );


  server.registerTool(
    "nvim_capabilities",
    {
      description:
        "Probe the live Neovim config: format/test/comment backends, LSP attached to the current buffer, grep, " +
        "treesitter, and the user's keymap cheat sheet. Call it at the start of a session and after opening a " +
        "different kind of file, then pick tools from it (no LSP attached → edit by hand, test: none → bash).",
      inputSchema: {},
    },
    () =>
      run("capabilities", false, async () => {
        await session.loadCapabilities();
        persist(session);
        return contextBlock(session) || "(capabilities unavailable)";
      }),
  );

  return server;
}

async function main(): Promise<void> {
  const session = new NvimSession(luaPath);
  session.speed = "fast";
  const server = createServer(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run only when executed directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`mcp-nvim failed to start: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
