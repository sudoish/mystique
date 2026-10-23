# Evaluation suite

Measures Mystique against **plain pi** on representative coding tasks: billed
tokens, tool-call count, task success, and wall time. The goal is to show whether
driving a live Neovim is competitive on tokens/tool-calls while keeping success at
100%.

**Latest results: [RESULTS.md](RESULTS.md).**

## How it works

For each **task × mode × trial** the harness (`src/run.ts`):

1. copies the task's `fixtures/<id>/initial` tree into a temp workspace;
2. runs pi non-interactively against it with `pi --mode json` and captures the
   JSONL [event stream](https://github.com/earendil-works/pi) on stdout;
3. parses the stream for metrics (`src/metrics.ts`): tokens summed per assistant
   turn, tool calls by name, stop reason;
4. runs the task's `check(dir)` on the resulting files for a pass/fail;
5. aggregates trials and writes `results/latest.json` and `results/latest.md`
   (`src/report.ts`).

**Modes**

- `baseline` — plain pi with its built-in file tools (`--no-extensions`).
- `mystique` — pi with only the extension loaded (`-e extension/index.ts`),
  driving a dedicated headless `nvim --listen` the harness spawns per run.

## Tasks

| id | what the agent must do | success check |
|---|---|---|
| `fix-type-errors` | fix two TS type errors | `tsc --noEmit` clean |
| `rename-and-fix` | rename `calc`→`cartTotal` everywhere and fix the errors | `tsc` clean + old name gone |
| `multi-file-rename` | rename `getUser`→`fetchUser` across 6 files | `tsc` clean + old name gone everywhere |
| `tdd-loop` | implement `classify()` so the failing tests pass | `node --test` green |

Each task has a `solution/` fixture used only by the self-test to prove the check
passes on a correct result and fails on the untouched `initial/`.

## Running

```bash
cd eval && npm install

# Real A/B run (makes live API calls; needs a configured pi + model,
# and `nvim` on PATH for the mystique mode):
npm run run-eval -- --model <pattern> --trials 3
npm run run-eval -- --tasks fix-type-errors --modes baseline,mystique --trials 5
# --lsp starts ts_ls in the eval's nvim (via nvim-lsp-init.lua) so the agent can
# use nvim_lsp (rename/definition) instead of a :cdo sweep. Needs typescript-language-server on PATH.
npm run run-eval -- --tasks multi-file-rename --modes mystique --trials 3 --lsp
```

Results are nondeterministic, so use several trials and compare aggregates.
`results/` is git-ignored.

## Tests (no API calls)

```bash
npm run check   # type-check the harness
npm test        # metrics parser (recorded sample) + fixture/check self-test
```

`tests/metrics.test.ts` asserts the parser against `samples/sample-run.jsonl`.
`tests/fixtures.test.ts` verifies each task check fails on `initial` and passes on
`solution`, so a real run's pass/fail signal is trustworthy. Both run in CI.

## Caveats

- Real runs cost tokens and vary between trials; treat single runs as anecdotes.
- `baseline` uses `--no-extensions` so a globally-configured Mystique never leaks
  into the control.
- The harness runs pi with `--approve` (trusts the temp workspace) and a closed
  stdin, so json-mode runs never stall on a trust prompt or wait for input.
- Each run has a 300s cap; a timed-out run is killed and recorded with whatever
  metrics had streamed so far.
