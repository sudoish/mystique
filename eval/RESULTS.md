# Evaluation results

A snapshot from `npm run run-eval`. Reproduce with the command below; regenerate
this file from `results/latest.md` (which is git-ignored) when you re-run.

```bash
cd eval
npm run run-eval -- --tasks fix-type-errors,rename-and-fix \
  --modes baseline,mystique --trials 3 --model anthropic/claude-haiku-4-5
```

## 2026-10-23 · anthropic/claude-haiku-4-5 · 3 trials/cell

Lower tokens / tool-calls is better; success should stay at 100%.

| Task | Mode | Success | Tokens | Tool calls | Turns | Duration |
|---|---|---|--:|--:|--:|--:|
| fix-type-errors | baseline | 100% (3) | 34,920 | 7.3 | 6.7 | 26.2s |
| fix-type-errors | mystique | 100% (3) | 163,905 | 16.7 | 17.7 | 51.7s |
| rename-and-fix | baseline | 100% (3) | 44,645 | 9.3 | 8.3 | 32.0s |
| rename-and-fix | mystique | 100% (3) | 210,934 | 20.7 | 21.7 | 68.4s |

### Mystique vs baseline (Δ)

| Task | Tokens Δ | Tool calls Δ |
|---|--:|--:|
| fix-type-errors | +369% | +127% |
| rename-and-fix | +372% | +121% |

## Reading these numbers honestly

- **Correctness is on par: 100% success in every cell.** Driving a live Neovim
  solved both tasks as reliably as plain pi.
- **On these tiny tasks Mystique costs far more** — ~4.7× tokens and ~2.2× tool
  calls. Two effects dominate at this size:
  1. **Fixed prompt overhead.** Mystique injects `<nvim_playbook>`,
     `<nvim_keymaps>`, and `<nvim_capabilities>` on every turn; against a
     two-error file that overhead swamps the actual work.
  2. **More, smaller steps.** A view → motion/`:`-command → re-snapshot loop
     takes more turns than one `edit` call, and each extra turn re-sends context,
     which is superlinear in tokens.
- **These fixtures are the worst case for Mystique** (trivial, single-file,
  no navigation or multi-site refactor where LSP rename / `:cdo` / quickfix pay
  off, and no human-visibility value). They are a floor, not a verdict.

## What this tells us to do next

- Add larger, multi-file tasks (project-wide rename via `nvim_lsp`, a `:cdo`
  sweep, a TDD loop) where editor power should narrow or close the gap.
- Trim fixed prompt overhead: the keymap sheet and playbook are the biggest
  per-turn cost and are now "optional" — consider shortening them or gating the
  keymap sheet behind a capability signal.
- Report cost (USD) alongside tokens once multi-model runs are in.
