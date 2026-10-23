/**
 * Harness-agnostic tool bodies. Each function drives a connected NvimSession and
 * returns plain text — the same snapshot/result text the pi extension shows, minus
 * the pi-only TUI "details". The MCP server (mcp-nvim) wraps these as MCP tools; the
 * pi extension keeps its richer renderers but could delegate here too.
 */
import type { NvimSession, Snapshot } from "./nvim.ts";
import { shellQuote } from "./nvim.ts";

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
  out.push(s.ctx);
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

export async function grep(session: NvimSession, pattern: string, glob?: string): Promise<string> {
  const esc = (s: string) => shellQuote(s).replace(/[%#|]/g, (m) => `\\${m}`);
  await session.ex(`silent grep! ${esc(pattern)}${glob ? ` -g ${esc(glob)}` : ""}`);
  await session.lua(
    "if #vim.fn.getqflist() > 0 then vim.cmd('botright copen 8') vim.cmd('wincmd p') else vim.cmd('cclose') end",
  );
  const snap = await session.snapshot({ qf: 50 });
  delete snap.output;
  if (!snap.qf) snap.msg = "no matches";
  return snapshotToText(snap);
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
