/**
 * Is there a Neovim for Mystique to drive from this Claude Code session? Mirrors
 * core/nvim.ts detectMode() (and the pi extension's `active`): a global install must
 * stay inert outside Neovim, so plain `claude` keeps its builtin tools everywhere else.
 * MYSTIQUE_POLICY=off keeps the nvim_* tools but lifts enforcement.
 */
import { existsSync } from "node:fs";

export function nvimActive(env = process.env) {
  if (env.MYSTIQUE_SOCKET && existsSync(env.MYSTIQUE_SOCKET)) return true;
  if (env.NVIM && existsSync(env.NVIM)) return true;
  return env.HERDR_ENV === "1";
}

export function policyActive(env = process.env) {
  return nvimActive(env) && env.MYSTIQUE_POLICY !== "off";
}
