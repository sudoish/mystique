/**
 * Shared bash policy — the same escape hatches the pi extension blocks, so Claude
 * Code edits/reads/searches through the nvim_* MCP tools instead of the shell.
 * Pure and dependency-free so it can be unit-tested.
 */

/** @type {[RegExp, string][]} */
export const BASH_BLOCKS = [
  [/\bsed\b[^|;&]*\s-i/, "in-place sed"],
  [/\bperl\b[^|;&]*\s-[a-z]*i/, "in-place perl"],
  [/(^|[^0-9&>])>>?\s*(?!\/dev\/null|&|\/tmp\/)[^\s|;&]/, "redirecting output into a file"],
  [/(^|[|;&]\s*)tee\b/, "tee into files"],
  [/(^|;|&&|\|\|)\s*(cat|head|tail|bat|less|more|nl)\s+(-\S+\s+)*[^-\s|<]/, "reading files via shell"],
  [/(^|;|&&|\|\|)\s*(rg|grep|ag|ack|find)\b/, "searching via shell"],
  [/\b(python3?|node|ruby)\b\s+-[ce]\b.*\b(write|open|writeFile)/, "scripted file writes"],
];

/**
 * Classify a bash command. Returns a reason string when it bypasses the editor
 * (and should be blocked), or null when it is allowed.
 * @param {string} command
 * @returns {string | null}
 */
export function classifyBash(command) {
  for (const [re, what] of BASH_BLOCKS) {
    if (re.test(command)) return what;
  }
  return null;
}

/** Message shown to the model when a bash command is blocked. */
export function blockMessage(what) {
  return (
    `Blocked (${what}). Read, search and edit through the nvim_* MCP tools: ` +
    "nvim_view, nvim_grep, nvim_lsp, nvim_keys, nvim_ex, nvim_insert."
  );
}
