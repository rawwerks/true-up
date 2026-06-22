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
| [0.1.0](#010--2026-06-22) | 2026-06-22 | First tagged release: the deterministic, git-native truing-up engine — language-agnostic, read-only-by-design, marker-free, self-dogfooding. |

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
- **Tier 1 — span anchors:** bracket a region of *any* file with a paired comment token to make code a
  content-hashed source-of-truth, zero-dependency, no parser ([`20b2d91`](https://github.com/rawwerks/true-up/commit/20b2d91)).
- **Tier 2 — tree-sitter symbols:** opt-in `"symbols": true` auto-extracts code definitions
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
