# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/emafajriana/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/emafajriana/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` is a command-line tool that applies an edit an AI model wrote
to a tree of text files, in whichever of the four formats models actually produce:

- **unified diffs**, whose line numbers may be wrong — each hunk is found by its lines, at the position nearest
  the one the header names;
- **SEARCH/REPLACE blocks**, located by their old lines;
- **V4A patches** (`*** Begin Patch` … `*** End Patch`), with anchored, cursor-driven chunks;
- **JSON tool calls** — `create`, `str_replace` and `insert` edit objects, as one array or as JSON Lines.

Old lines are matched at the first of three tiers that finds them: exact, ignoring trailing whitespace, then
ignoring indentation as well, with tier-2 replacements re-indented to the file's own indentation. Every edit of
a patch applies, in order, or the patch writes nothing at all: a run prints one line per changed file
(`A`/`D`/`M`/`R`), or one `error: <code> <path>` line per failed edit, and exits 0, 1 or 2 accordingly.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file relative to the working directory (the tree's root); with no argument, or `-`, the patch
is read from standard input. `--format` names one of `unified`, `search-replace`, `v4a` or `json`; the default,
`auto`, detects the format from the patch itself. `--check` reports what would change and writes nothing.
`--strict` matches lines exactly (tier 0 only). The full contract is `SPEC.md`.

## Files

- `main.ts` — the CLI: Node 22, standard library alone. In a make.fun trial it also hands over to the runner
  when `MAKEFUN_ENV_URL` is set.
- `runner.ts` — the kit's trial runner: reads a trial's checks from the env, runs `main.ts` on each one in a
  fresh directory, and posts what it did.
- `check.ts` — runs `main.ts` on the public practice set (`program/generator/practice.json` in the kit) and
  prints the practice score.
- `SPEC.md` — the specification mend implements, sentence for sentence.

## Behaviour notes

- The whole patch is parsed into edits before any file is touched, and an edit that fails leaves no trace:
  its own changes roll back, later edits still run, and nothing is written unless every edit succeeds.
- Changed files are written back with their own line breaks (CRLF stays CRLF) and their own final break,
  except where a unified diff's `\ No newline at end of file` lines say otherwise. Created files use LF and
  a final break, unless a JSON `create` supplies the file's bytes directly.
- A path is safe — relative, with no empty, `.` or `..` segments and no backslashes — or the edit that names
  it fails with `unsafe`. Paths are checked, oldest first, before anything else about an edit.
- mend is deterministic: the same tree and the same patch always produce the same report and the same bytes.
