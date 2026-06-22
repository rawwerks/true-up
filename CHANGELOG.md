# Changelog

All notable changes to **true-up** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public contract is the command
surface in [`meta/contract.json`](meta/contract.json) (`true-up capabilities`, `contract_version`).

Scope: from the initial commit through the first tagged release. Links point at the canonical
commit pages on GitHub (`rawwerks/true-up`). No GitHub *Releases* existed before `v0.1.0`.

## Version timeline

| Version | Date | Summary |
|---|---|---|
| [0.1.1](#011--2026-06-22) | 2026-06-22 | Docs rewritten for users (README no longer leaked internal/maintainer framing); a doc-fact-check found and fixed real drift (a README config example that failed to build, an `init` exit-code claim, an installer `--help` source leak); six deterministic doc/marker-drift gates added so it can't recur. |
| [0.1.0](#010--2026-06-22) | 2026-06-22 | First tagged release: the deterministic, git-native truing-up engine — language-agnostic, read-only-by-design, marker-free, self-dogfooding. |

## [0.1.1] - 2026-06-22

A docs + self-gating patch. No breaking changes; the command surface and behavior are identical to
0.1.0 except one spurious flag was removed (`status --committed`, which no code path honored). The
motivation: true-up's own README had drifted — a keeping-things-in-sync tool shipping a stale, internal
README. This release fixes the rot and makes the whole class of doc/marker drift impossible to ship.

### Changed — docs rewritten for users
- **README.md** is now user-facing: removed internal jargon (the old span-vs-symbol layer naming,
  self-dogfood, invariants, steward) — that lives in [AGENTS.md](AGENTS.md) — and restructured to
  problem → solution → two-phase
  install (get the tool, then `init` in a repo) → commands → config → FAQ. The config example now
  actually builds (the prior one hard-failed with a SEED ERROR).
- **SKILL.md / docs/CONFIG.md**: corrected the `init` exit code (idempotent **exit 0**, not "refuses to
  overwrite, exit 1"), the inert-graph condition (keyed off edges, not declared facts), and documented
  that a malformed config exits 2. Removed leaked "Axiom N" jargon from the agent-facing skill.
- **install.sh**: `--help` no longer leaks source code (the comment-range `sed` overshot), and the
  user-visible internal layer-naming strings are gone.

### Fixed
- Removed `status --committed` from the contract's `cmd_flags` — `status` never read it.

### Added — six deterministic doc/marker-drift gates (tests/engine.sh, in `npm test` + CI)
- **docs-in-sync** (every `capabilities` command documented in README + SKILL), **flag-coverage**
  (every contract flag documented), **no-stale-init** (proves idempotency, then forbids the exit-1
  claim), **no-jargon** (no Tier/Axiom in user docs or installer `--help`), **no-source-leak**
  (installer `--help` prints no code), and **marker-free** (true-up's own build has zero inline-marker
  edges — the "no markup in our files" invariant was claimed in AGENTS.md but never asserted; now it is).
  Provenance: two multi-agent audits in [agent_ergonomics_audit/](agent_ergonomics_audit/audit/HANDOFF.md).

## [0.1.0] - 2026-06-22

First public, tagged release. true-up is a deterministic, git-native engine that builds a typed,
content-hashed dependency graph of a repo and gates on staleness — detecting what a change makes
stale, regenerating the mechanical, and worklisting the advisory, without an LLM guessing. It is
**read-only with respect to your content**: its only writes are `.true-up/` (the graph), `.true-up.json`
(`init`), and `.git/hooks/` (opt-in) — enforced by a snapshot test.

### Hardened — safety & agent-ergonomics (pre-release pass)

A pre-release pass (driven by a multi-lens audit; see `agent_ergonomics_audit/`) closed safety footguns
and made the CLI dramatically easier for an AI agent to use correctly on the first try. Every fix ships
with a regression test (`tests/engine.sh` T40–T72).

- **Safety.** The test harness is git-config-isolated (`GIT_CONFIG_GLOBAL=/dev/null`, isolated `HOME`) so
  `npm test`/`npm run ci` can never overwrite a developer's **global git hooks** (it could before, via a
  global `core.hooksPath`). `hooks --install`/`--uninstall` now **refuse a hooks dir outside this repo**
  without `--force`, never clobber an existing `.bak`, and `--uninstall` **restores** the backup. `out`
  is confined inside the repo (no `..`/absolute escape, never a tracked content file). `run` confines
  generators to the repo and surfaces their stderr. A malformed/ill-typed `.true-up.json` fails clean
  (exit 2) instead of a stack trace that leaked an absolute path; a global `uncaughtException` guard is
  the floor.
- **No false-clean gates.** `--repo` is normalized to the git toplevel — a `--repo` pointing at a
  **subdirectory** (or a non-git/nonexistent path) no longer scans an empty file set and reports clean;
  it resolves to the repo root or exits 2. `--impact` on an unknown target exits 2 (not a false "0
  dependents"). `gate <stray-arg>` exits 2 (was a silent PASS).
- **Agent ergonomics.** New `status` read-only **orientation mega-command** (built/stale, what's stale,
  policy/leak status, `nextCommands[]` — one call, always exit 0); new `robot-docs` in-tool agent
  handbook; explicit `build` verb. Intent/synonym inference (`update`→`run`, `docs`→`robot-docs`,
  `--jsno`→`--json`, cross-prefix typos). Every `--json` envelope carries a uniform `ok` + `_v`; error
  paths emit `{ok:false,…}` on stdout. `capabilities` gained `quickstart`, `entrypoints`, `cmd_flags`,
  and `error_codes`. Fresh `git clone && npm test` is green (Tier-2 symbol tests skip honestly without
  the optional tree-sitter devDeps); `scripts/ci.sh` self-bootstraps devDeps and surfaces the real error
  on a failed step.

### Added — engine & detection
- Deterministic content-hashed dependency graph with causal, directed edges (generator marker,
  declared steward, fact anchor, symlink); per-fact granularity + early-cutoff; fail-loud on an
  unresolved anchor. Commands: `build`, `--check [--committed]`, `--impact [--since]`, `run`, `init`
  ([`df46976`](https://github.com/rawwerks/true-up/commit/df46976)).
- `--verify-scope` anti-code-golf gate (a changed file must be explained by the graph) and the
  `maintenance` / `audit` workflows ([`1cd7590`](https://github.com/rawwerks/true-up/commit/1cd7590)).

### Added — language-agnostic source-of-truth
- **Span anchors (any language, zero-dependency):** bracket a region of *any* file with a paired comment
  token to make code a content-hashed source-of-truth, no parser ([`20b2d91`](https://github.com/rawwerks/true-up/commit/20b2d91)).
- **Tree-sitter symbols (opt-in):** `"symbols": true` auto-extracts code definitions
  (Python/Rust/Go/JS/TS/C/C++) as facts; optional pinned deps, fail-loud if enabled-but-missing
  ([`20b2d91`](https://github.com/rawwerks/true-up/commit/20b2d91)).
- **Marker-free fact-granular `seed`:** a sidecar `seed` `to` of form `path#fact` links a doc to a
  specific JSON-key / span / symbol fact with **no inline markers**; fail-loud on an unresolved target
  ([`94b0c37`](https://github.com/rawwerks/true-up/commit/94b0c37)).

### Added — agent ergonomics & gates
- `--json` on every read-side command, `capabilities` (machine-readable contract), and did-you-mean
  flag/command correction ([`4ba5701`](https://github.com/rawwerks/true-up/commit/4ba5701)).
- `gate` (one CI stage = `--check` + `--policy` + `--externalities`, exit-code authoritative) and
  `hooks --install|--uninstall|--ci` (per-repo pre-commit + pre-push adoption, fail-closed)
  ([`bd409e6`](https://github.com/rawwerks/true-up/commit/bd409e6)).
- `--no-write`: fully stateless — compute in memory and persist nothing (not even `.true-up/`);
  `run --no-write` is a dry-run ([`94b0c37`](https://github.com/rawwerks/true-up/commit/94b0c37)).

### Added — distribution & self-dogfood
- `curl | bash` `install.sh` (zero-dep Node tool; `--with-symbols`; `--uninstall`)
  ([`dc429fc`](https://github.com/rawwerks/true-up/commit/dc429fc)).
- true-up **dogfoods itself, marker-free**: the command surface is generated to a `meta/contract.json`
  steward, the docs derive from it via sidecar `seed`, and `npm test` + CI run `true-up gate` on
  true-up's own repo ([`6ddf63d`](https://github.com/rawwerks/true-up/commit/6ddf63d)).
- MIT licensed ([`b7ef7aa`](https://github.com/rawwerks/true-up/commit/b7ef7aa)).

### Security & hardening
- **Read-only invariant** asserted as a keystone harness test: every read-side command leaves all
  content byte-identical; the only write surface is `.true-up/` (+ opt-in hooks)
  ([`94b0c37`](https://github.com/rawwerks/true-up/commit/94b0c37)).
- Gates carry **real exit codes** (a gate that always exited 0 was a footgun), leak detectors scan
  code-stripped content with per-line suppression, and `--check` vs `--check --committed` are distinct
  drift gates ([`3130e1d`](https://github.com/rawwerks/true-up/commit/3130e1d)). A typo'd flag (e.g.
  `--comitted`) is now rejected instead of silently downgrading the committed drift gate
  ([`94b0c37`](https://github.com/rawwerks/true-up/commit/94b0c37)). `"strictSpans"` makes malformed
  span anchors fatal for a trustworthy CI gate ([`bd409e6`](https://github.com/rawwerks/true-up/commit/bd409e6)).

### Notes for agents
- **Read the contract from the tool:** `true-up capabilities` returns commands, flags, exit codes,
  the `rules` semantics, the `hashing` model, and the `write_invariant`. `true-up --help` is paste-ready.
- **Exit codes:** `0` success/clean, `1` gate violation (stale / leak / policy / not-GREEN / out-of-scope),
  `2` usage error.
- **Determinism:** the graph is byte-stable (sorted, no timestamps); pin the tool version for a gate
  shared across machines.

[0.1.0]: https://github.com/rawwerks/true-up/releases/tag/v0.1.0
