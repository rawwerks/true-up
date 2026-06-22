# true-up — safety + agent-ergonomics pass (HANDOFF)

**Mode:** full. **Branch:** `main` (no new branch). **Workspace:** in-tree (`agent_ergonomics_audit/`).
**Target:** `true-up` v0.1.0 (unpublished at pass time — breaking-change-free latitude).
**Provenance:** two multi-agent workflows — a 6-lens usability/robustness/safety audit, then a 6-lens
agent-ergonomics scoring pass (11 dimensions + first-try-inevitability + exemplar-gap). The raw ranked
findings (which embed absolute machine paths from live transcripts, so they are NOT committed here to
keep this repo leak-clean) live in the workflow run transcripts and the auditor's scratch.

## Outcome

`npm run ci` (the trust anchor) is GREEN: **122 engine tests, 0 failed, 0 skipped**, all 8 release steps
pass, contract in sync. Fresh `git clone && npm test` is green (Tier-2 skips honestly without devDeps).
The package is correct and publishable; only npm credentials remain (see [`../../PUBLISHING.md`](../../PUBLISHING.md)).

## What shipped (all on `main`, each with a regression test in `tests/engine.sh`)

### Safety (the reason this pass started)
- **Test harness is git-config isolated** (`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, throwaway `HOME`). Before,
  `npm test`/`npm run ci`/`npm publish` could **overwrite the developer's global git hooks** (via a global
  `core.hooksPath`) — it did, once, during this pass. (T32b, T44.)
- **`hooks --install/--uninstall` refuse a hooks dir outside this repo** without `--force`; `--uninstall`
  **restores** the backed-up foreign hook; `--install` never clobbers an existing `.bak`. (T44, T45.)
- **`out` confined** to the repo (no `..`/absolute escape, never a tracked content file). (T48.)
- **`run` confines generators** to the repo + surfaces their stderr. (T52, T53.)
- **Malformed/ill-typed config fails clean** (exit 2) — no stack trace leaking the engine's own path; a
  global `uncaughtException` guard is the floor. (T46, T47.)

### No false-clean gates (the worst false negative the tool exists to prevent)
- **`resolveRoot` normalizes `--repo`/`$TRUE_UP_REPO`/CWD to the git toplevel** → a `--repo` at a
  subdirectory no longer scans an empty set and reports clean (GAP-H); non-git/nonexistent → exit 2. (T40–T42.)
- **`--impact` unknown target → exit 2** (not a false "0 dependents"). (T49.)
- **`gate <stray-arg>` → exit 2** (was a silent PASS). (T69.)

### Agent ergonomics (Ambition Bar)
- **`status`** read-only orientation mega-command — built/stale + what's stale + policy/leak + `nextCommands[]`
  in one call, always exit 0, writes nothing. (T64.)
- **`robot-docs`** in-tool agent handbook; **`build`** explicit verb. (T65, T66.)
- **Intent/synonym inference**: `update`→`run`, `docs`→`robot-docs`, `--jsno`→`--json`, cross-prefix typos. (T67.)
- **`--json` on every error path** ({ok:false, kind, didYouMean}); **uniform `ok` + `_v`** on every read-side envelope. (T68, T70.)
- **`run --json` real path carries `advisoryWorklist`** (parity with `--no-write`). (T71.)
- **`capabilities` completeness**: `quickstart`, `entrypoints`, `cmd_flags` (live), `error_codes`; `run` marked
  code-executing with safe-alt; new commands listed. (T72.)
- Stray-`fatal:` git noise suppressed; `--version` clean outside a repo; `init` idempotent (exit 0);
  `ci.sh` self-bootstraps devDeps + surfaces the real step error; PUBLISHING.md preflight fixed.

### Ambition Bar
- Substantive landed changes: **well over 10**, covering **≥ 8 of 11 dimensions**.
- Missing-surface types now PRESENT: mega-command ✓ (`status`), robot-docs ✓, `--json` on read-side ✓
  (pre-existing, extended to errors), error rewrite ✓, intent-inference handler ✓ (synonym map).
- Bar **met** without needing the "That's it??" self-prompt round.

## Deferred (filed for a future pass; non-blocking)
- Bare `true-up` still WRITES (it announces the write on stdout; `status` is the non-mutating probe). A
  stricter "a bare probe never mutates" (bare = read-only, `build`/`--write` to persist) is a larger
  contract change deferred to avoid churn — `status` already gives agents the safe probe.
- Per-command JSON output-key *schema* in `capabilities` (today: `cmd_flags` + uniform `ok`/`_v` + the
  `json_envelope` note). 
- `run` trust-gate (allowlist generators) beyond path-confinement.

## How to re-open the loop
1. `true-up status --json` on the post-pass binary (one-call health).
2. `bash scripts/ci.sh` (with a real `node` first in PATH — see the mycelium note on `scripts/ci.sh`).
3. The two findings JSONs here hold the full ranked recommendation lists.
