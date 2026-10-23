# Evaluation results

Snapshots from `npm run run-eval`. `results/latest.md` (git-ignored) is the raw
output; this file is the curated record. Reproduce with:

```bash
cd eval
npm run run-eval -- --tasks fix-type-errors,rename-and-fix \
  --modes baseline,mystique --trials 3 --model anthropic/claude-haiku-4-5
```

## 2026-10-23 · anthropic/claude-haiku-4-5 · 3 trials/cell

Lower tokens / tool-calls is better; success should stay at 100%. Baseline is plain
pi (`--no-extensions`); it does not load Mystique, so prompt changes don't affect it.

| Task | Mode | Success | Tokens | Tool calls | Turns | Duration |
|---|---|---|--:|--:|--:|--:|
| fix-type-errors | baseline | 100% (3) | 34,920 | 7.3 | 6.7 | 26.2s |
| fix-type-errors | mystique | 100% (3) | 125,156 | 14.0 | 14.7 | 46.6s |
| rename-and-fix | baseline | 100% (3) | 44,645 | 9.3 | 8.3 | 32.0s |
| rename-and-fix | mystique | 100% (3) | 124,650 | 14.0 | 15.0 | 45.9s |

### Mystique vs baseline (Δ)

| Task | Tokens Δ | Tool calls Δ |
|---|--:|--:|
| fix-type-errors | +258% | +92% |
| rename-and-fix | +179% | +51% |

## Prompt-overhead optimization (before → after)

Almost all token cost is **cacheRead** = (context size) × (turns): every turn
re-reads the system prompt, the 11 tool schemas, and the growing transcript. So the
levers are a smaller fixed prompt *and* fewer round-trips. We cut the playbook
(`extension/prompt.md`) ~46% and added an explicit "be economical: trust the
snapshot, don't re-view, prefer one `:s`/`:cdo`/LSP action over many keystrokes"
directive. Baseline is unaffected (loads no extension).

| Task (mystique) | Tokens before | Tokens after | Δ | Turns before → after |
|---|--:|--:|--:|--:|
| fix-type-errors | 163,905 | 125,156 | −24% | 17.7 → 14.7 |
| rename-and-fix | 210,934 | 124,650 | −41% | 21.7 → 15.0 |

Success stayed at 100%. The rename task improved most — it previously spent many
turns re-viewing to confirm edits, which the "trust the snapshot" rule removes.

## Reading these numbers honestly

- **Correctness is on par: 100% in every cell**, before and after.
- **Mystique still costs more on these trivial single-file tasks** (+179–258%
  tokens), because its fixed per-turn context is larger (playbook + 11 tool
  schemas vs 4 builtin tools) and it takes more, smaller steps than one `edit`.
  These fixtures are Mystique's worst case — no multi-site refactor or navigation
  where LSP rename / `:cdo` / quickfix pay off, and no human-visibility value.

## Next

- Larger multi-file tasks (project-wide LSP rename, `:cdo` sweep, TDD loop) where
  editor power should narrow the gap further.
- Report cost (USD) alongside tokens; add a cheap/other-model column.
