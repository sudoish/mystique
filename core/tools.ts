/**
 * Harness-agnostic tool bodies. Each function drives a connected NvimSession and
 * returns plain text — the same snapshot/result text the pi extension shows, minus
 * the pi-only TUI "details". The MCP server (mcp-nvim) wraps these as MCP tools; the
 * pi extension keeps its richer renderers but could delegate here too.
 */
import type { NvimSession, Snapshot } from "./nvim.ts";

function statusLine(s: Snapshot): string {
  const flags = [s.mod ? "[+]" : "", s.diag.E ? `E${s.diag.E}` : "", s.diag.W ? `W${s.diag.W}` : ""]
    .filter(Boolean)
    .join(" ");
  return `[${s.mode}] ${s.file || "[No Name]"}:${s.cur[0]}:${s.cur[1]}/${s.lines} ${flags}`.trimEnd();
}

/** Render a snapshot as the compact text block the model reads. */
export function snapshotToText(s: Snapshot, opts: { extra?: string } = {}): string {
  const out: string[] = [];
  if (opts.extra) out.push(opts.extra);
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
  if (s.floats?.length) out.push(`floating windows:\n${s.floats.join("\n")}`);
  out.push(statusLine(s));
  if (s.ctx) out.push(s.ctx);
  if (s.bufs && s.bufs.length > 1) out.push(`buffers: ${s.bufs.join(" ")}`);
  return out.join("\n");
}

export async function keys(session: NvimSession, k: string): Promise<string> {
  const synced = await session.keys(session.expandLeader(k));
  const snap = await session.snapshot();
  snap.synced = synced;
  return snapshotToText(snap);
}

export async function ex(session: NvimSession, cmd: string): Promise<string> {
  await session.ex(cmd);
  return snapshotToText(await session.snapshot());
}

export async function insert(session: NvimSession, text: string, where = "below"): Promise<string> {
  const lines = text.replace(/\n$/, "").split("\n");
  const linewise = where === "below" || where === "above";
  if (linewise) await session.keys("<C-\\><C-n>");
  await session.put(lines, linewise ? "l" : "c", where === "below" || where === "after");
  return snapshotToText(await session.snapshot({ max_changed: 12 }));
}

export async function view(session: NvimSession, path = "", start = 1, end = 0): Promise<string> {
  const v = await session.lua<{ file: string; lines: number; range: [number, number]; text: string }>(
    "return Mystique.view(...)",
    [path, start, end],
  );
  return `${v.file} (${v.range[0]}-${v.range[1]} of ${v.lines})\n${v.text}`;
}

export interface GrepArgs {
  pattern: string;
  /** Directory or file to search; keeps .gitignore in effect (unlike a glob). */
  path?: string;
  /** File filter, e.g. '*.ts'. Note: ripgrep globs override ignore rules. */
  glob?: string;
  /** Max hits to list line by line; above it the result is per-file counts (default 40). */
  limit?: number;
  /** Whole-word matches only (rg --word-regexp). */
  word?: boolean;
  /** Treat the pattern as a literal string, not a regex (rg --fixed-strings). */
  literal?: boolean;
  /** Case matching: smart (default: insensitive unless the pattern has uppercase), sensitive, ignore. */
  case?: "smart" | "sensitive" | "ignore";
  /** Lines of context around each listed hit (0-5, default 0). */
  context?: number;
}

export interface GrepResult {
  total: number;
  files: number;
  /** What the model reads: grouped hits, per-file counts, or "no matches". */
  text: string;
}

/**
 * Run Mystique.grep (ripgrep argv → quickfix) and return its compact report. No editor
 * snapshot: a search changes nothing, and the cursor context would be an unrelated file.
 */
export async function grepRun(session: NvimSession, a: GrepArgs): Promise<GrepResult> {
  const r = await session.lua<{ total: number; files: number; text: string }>("return Mystique.grep(...)", [
    a.pattern,
    {
      path: a.path ?? "",
      glob: a.glob ?? "",
      limit: a.limit ?? 40,
      context: a.context ?? 0,
      word: a.word ?? false,
      literal: a.literal ?? false,
      case: a.case ?? "smart",
    },
  ]);
  const head = r.total
    ? `${r.total} match${r.total === 1 ? "" : "es"} in ${r.files} file${r.files === 1 ? "" : "s"}`
    : `no matches for ${a.pattern}${a.path ? ` in ${a.path}` : ""}`;
  return { total: r.total, files: r.files, text: r.text ? `${head}\n${r.text}` : head };
}

export async function grep(session: NvimSession, a: GrepArgs): Promise<string> {
  return (await grepRun(session, a)).text;
}

export interface FindArgs {
  /** Fuzzy query matched against file paths, e.g. 'tools' or 'ext/index'. */
  query: string;
  /** Directory to search (default: the project root). */
  path?: string;
  /** Max paths returned (default 20). */
  limit?: number;
}

/** Fuzzy file-name search (rg --files ranked by matchfuzzy): the best paths first. */
export async function findRun(session: NvimSession, a: FindArgs): Promise<{ total: number; text: string }> {
  const r = await session.lua<{ total: number; searched: number; items: string[] }>("return Mystique.find(...)", [
    a.query,
    { path: a.path ?? "", limit: a.limit ?? 20 },
  ]);
  if (!r.total) return { total: 0, text: `no files match ${a.query} (${r.searched} searched)` };
  const shown = r.items.length < r.total ? `, top ${r.items.length}` : "";
  return { total: r.total, text: `${r.total} file${r.total === 1 ? "" : "s"} match ${a.query}${shown}:\n${r.items.join("\n")}` };
}

export async function find(session: NvimSession, a: FindArgs): Promise<string> {
  return (await findRun(session, a)).text;
}

export async function lsp(session: NvimSession, action: string, arg?: string): Promise<string> {
  const res = await session.lua<Record<string, unknown>>("return Mystique.lsp(...)", [action, arg ?? ""]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(res ?? {})) {
    if (Array.isArray(v)) parts.push(`${k} (${v.length}):\n${v.join("\n")}`);
    else if (v && typeof v === "object") parts.push(`${k}: ${JSON.stringify(v)}`);
    else parts.push(`${k}: ${v}`);
  }
  const snap = await session.snapshot({ max_changed: action === "rename" ? 10 : 30 });
  return snapshotToText(snap, { extra: parts.join("\n") });
}

export async function check(session: NvimSession): Promise<string> {
  const r = await session.lua<{ counts: Record<string, number>; items: string[]; lsp: string[] }>(
    "return Mystique.check()",
    [],
    40000,
  );
  const c = r.counts;
  const head = `lsp: ${r.lsp.join(", ") || "(none attached)"} | E${c.E ?? 0} W${c.W ?? 0} I${c.I ?? 0} H${c.H ?? 0}`;
  return r.items.length ? `${head}\n${r.items.join("\n")}` : `${head}\nno errors or warnings`;
}

interface TestCounts { total: number; passed: number; failed: number; skipped: number; running: number }
interface TestResult {
  counts: TestCounts;
  failures: string[];
  timed_out: boolean;
  unsaved?: string[];
  output?: string;
}

function formatTests(r: TestResult, prefix?: string): string {
  const c = r.counts;
  const summary = `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (${c.total} total)${r.timed_out ? ", still running" : ""}`;
  return [
    prefix,
    summary,
    prefix && c.total === 0 && !r.timed_out
      ? "NOTE: 0 tests collected — no test runner adapter matched this file/scope. Run the project's test command directly via bash."
      : "",
    r.unsaved?.length
      ? `WARNING: unsaved buffers (${r.unsaved.join(", ")}): tests ran against the files on disk. Save and re-run.`
      : "",
    ...(r.failures.length ? ["failures:", ...r.failures] : []),
    r.output ? `runner output (tail):\n${r.output}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function tests(session: NvimSession, timeoutS = 60): Promise<string> {
  const r = await session.lua<TestResult>("return Mystique.tests(...)", [timeoutS * 1000], (timeoutS + 15) * 1000);
  return formatTests(r);
}

export async function testRun(session: NvimSession, scope = "nearest", timeoutS = 60): Promise<string> {
  await session.ex("silent! wall");
  const run = await session.lua<{ backend: string; started: boolean; err?: string }>(
    "return Mystique.test_run(...)",
    [scope],
    15000,
  );
  if (!run.started) return `could not start tests (${run.backend}): ${run.err ?? "unknown"}`;
  const r = await session.lua<TestResult>("return Mystique.tests(...)", [timeoutS * 1000], (timeoutS + 15) * 1000);
  return formatTests(r, `ran ${scope} via ${run.backend}`);
}

export async function screen(session: NvimSession): Promise<string> {
  return session.screen();
}

export async function format(session: NvimSession, first?: number, last?: number): Promise<string> {
  const r = await session.lua<{ backend: string; ok: boolean; err?: string }>(
    "return Mystique.format(...)",
    [first ?? null, last ?? null],
    15000,
  );
  const snap = await session.snapshot();
  const extra = r.ok ? `formatted via ${r.backend}` : `format failed (${r.backend}): ${r.err ?? "unknown"}`;
  return snapshotToText(snap, { extra });
}
