/**
 * Is there a Neovim for Mystique to drive from this Claude Code session? Re-exports the
 * shared detection in core/detect.mjs (also used by core/nvim.ts detectMode() and the pi
 * extension's `active`): a global install must stay inert outside Neovim, so plain `claude`
 * keeps its builtin tools everywhere else.
 * MYSTIQUE_POLICY=off keeps the nvim_* tools but lifts enforcement.
 */
import { nvimActive } from "../../core/detect.mjs";

export { nvimActive };

export function policyActive(env = process.env) {
  return nvimActive(env) && env.MYSTIQUE_POLICY !== "off";
}
