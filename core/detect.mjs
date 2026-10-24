/**
 * Shared Neovim-reachability detection, in plain Node (no deps, no tsx) so it can be
 * imported by core/nvim.ts, bin/mystique.mjs and claude/hooks/active.mjs alike.
 *
 * Where the Neovim we drive comes from, in priority order:
 * - external: `MYSTIQUE_SOCKET` points at an `nvim --listen` the user started
 * - embedded: pi/claude runs inside a `:terminal` of the user's Neovim; `$NVIM` is its socket
 * - herdr:    we split a herdr pane and spawn our own instance
 * - rex:      we split a Rex block and spawn our own instance
 *
 * Among the multiplexers HERDR_ENV wins over Rex: herdr is the inner one when it runs
 * inside a Rex terminal, and there REX_BLOCK names the herdr host block — splitting it
 * would land outside herdr.
 */
import { existsSync } from "node:fs";

/** @typedef {"embedded" | "external" | "herdr" | "rex"} Mode */

/**
 * Which mode a connection would use from this process, or undefined when there is no
 * Neovim to drive.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Mode | undefined}
 */
export function detectMode(env = process.env) {
  const sock = env.MYSTIQUE_SOCKET;
  if (sock && existsSync(sock)) return "external";
  const host = env.NVIM;
  if (host && existsSync(host)) return "embedded";
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.REX_SESSION && env.REX_BLOCK) return "rex";
  return undefined;
}

/**
 * Is there a Neovim for Mystique to drive from this process?
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function nvimActive(env = process.env) {
  return detectMode(env) !== undefined;
}

/**
 * Short human-readable description of how Neovim is reachable now, for the doctor.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function reachLabel(env = process.env) {
  if (env.MYSTIQUE_SOCKET && existsSync(env.MYSTIQUE_SOCKET)) return `MYSTIQUE_SOCKET=${env.MYSTIQUE_SOCKET}`;
  if (env.NVIM && existsSync(env.NVIM)) return "inside a Neovim terminal ($NVIM)";
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.REX_SESSION && env.REX_BLOCK) return "Rex";
  return undefined;
}
