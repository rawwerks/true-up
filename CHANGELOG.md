# Changelog

All notable changes to **true-up** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public contract is the command
surface in [`meta/contract.json`](meta/contract.json) (`true-up capabilities`, `contract_version`).

Scope: from the initial commit through the first tagged release. Links point at the canonical
commit pages on GitHub (`rawwerks/true-up`). No GitHub *Releases* existed before `v0.1.0`.

## [0.1.4] - 2026-06-23

A multi-agent, multi-worktree usability patch. No breaking changes; JSON consumers get additive fields,
and copied `status` next-commands are safer when the target repo is not the caller's CWD.

### Added
- **Workspace identity in `status`.** Human and JSON status now name the resolved target root, selection
  source (`cwd`, `$TRUE_UP_REPO`, or `--repo`), caller CWD, Git linked-worktree metadata, jj mode, and
  mismatch warnings. Agents can inspect `.workspace` before copying a command between panes or
  worktrees.
- **Completed-pass proof mode for impact.** `true-up --impact --since <ref> --proof --json` reports
  changed facts/sources, their dependents, and whether each dependent changed in the same range. This
  covers the rename-workflow audit case where the default remaining-stale view correctly omits already
  edited dependents.

### Changed
- **Safer `nextCommands` across workspaces.** When `status` is run from one repo while targeting another
  via `$TRUE_UP_REPO` or `--repo`, suggested commands are repo-qualified with `--repo <target-root>` so
  another agent does not accidentally rebuild or inspect its own CWD.
- **Atomic graph writes.** Builds write `.true-up/depgraph.json` through a temp file plus rename, so
  parallel agents rebuilding the same graph do not leave torn JSON for readers.
- **Impact remains a full blast-radius list.** Explicit `--impact <source>` lists every dependent output
  even when many generated files share one generator `via`; `run` is the place that deduplicates
  generator execution.
- Docs now clarify how to compose true-up with an existing formatter/linter in hooks or CI without
  making true-up choose or run a project-specific linter.

### Fixed
- jj-only status now resolves correctly from nested subdirectories and exposes a uniform workspace schema
  (`git: null`, jj metadata present).
- jj-only explicit `--repo` paths now still fail closed when the path is nonexistent or a file; the
  nested-subdirectory fallback no longer silently retargets the parent workspace.
- `status --since <bad-ref>` now has a documented exit-2 contract in capabilities and docs instead of
  being described as unconditional exit 0.
- `--impact --since <ref>` rejects stray explicit targets instead of silently mixing modes, and proof
  summaries include unique dependent counts so duplicate fact edges do not inflate the audit headline.
- Since-mode impact and `run` no longer report live symlink aliases as pending mechanical work; proof
  output marks them as satisfied by the alias instead of as missing edits.

## [0.1.3] - 2026-06-22

A self-dogfood patch for release and agent guidance. No breaking changes.

### Added
- **`true-up graph` is now the first-class "look at the data" command.** It prints a read-only
  human or JSON dump of nodes, audiences/zones, edges, propagation, and generator `via` fields.
- **Agent guidance is now a first-class contract steward.** `meta/build-contract.mjs` derives an
  `agent_guidance` fact from `true-up capabilities`, and the self-graph links README/docs guidance to
  that fact marker-free. `robot-docs` and `capabilities` now show the concrete `seed` edge shape agents
  should use for dependencies tree-sitter cannot infer.
- **Marker-free mechanical generated edges.** A `seed` can now use `kind: "generated-from"` plus
  `via` so generated artifacts like `meta/contract.json` can be modeled without inline markers.
- **Marker-example suppression for fixtures.** `true-up:ignore-file true-up-markers` lets test fixtures
  quote true-up marker syntax while the file remains a normal graph node.
- **Release handoff is in the self-graph.** `PUBLISHING.md` now has its own release-agent audience and
  declared dependencies on package metadata, changelog, installer, and the local CI trust anchor.
- **External-agent workflows ship with the package.** The npm allowlist now includes `workflows/` so
  `SKILL.md` links to the maintenance/audit templates are valid from the published tarball.

### Changed
- **true-up is a stronger case study for itself.** `.true-up.json` now models document audiences and
  prose/code/release/local-CI dependencies for README, SKILL, AGENTS, CONFIG, PUBLISHING, workflows,
  and the generated contract; the harness asserts those edges and the README command-fact coverage.
- The default graph file universe now includes tracked ignore/lock artifacts such as `.gitignore` and
  `bun.lock`, so release and cache-policy surfaces can participate in the graph.

### Fixed
- **New-user onboarding: `status` no longer reports "GREEN ✓ (nothing to do)" on an un-wired graph.**
  A freshly-`init`'d repo with no declared edges is *tracking nothing*, not done — `status` now shows a
  distinct orientation verdict ("SET UP — but TRACKING NOTHING yet") and its `next:` / `--json`
  `nextCommands` lead with the wire-up recipe (`init` → declare a `seed` edge → `robot-docs`). `status`
  also exposes `tracking` and `graph.declaredEdges`. (Found by a 3-agent new-user onboarding simulation:
  agents who followed the advertised first command were misled into a false "done".)
- **An incidental symlink no longer masks an un-wired repo.** Inert/“tracking” is keyed on
  declared/anchored/generator edges, so an auto-detected `alias-of` symlink can't flip `status` to green
  or suppress the build INERT NOTICE.
- **`init` ships a copy-paste `_seed_example`** edge in the scaffold, and `init`/the build INERT NOTICE/
  the SEED-ERROR message now point to the in-tool `true-up robot-docs` instead of `docs/CONFIG.md` (a
  file an adopting repo does not have — a dead breadcrumb).
- **Clearer guidance:** `robot-docs` and the SEED-ERROR text now state that a scalar JSON value (e.g.
  `package.json#version`) is not fact-addressable (depend on the whole file or anchor a span); `--check`
  failures name how to see what's affected (`--impact --since`); a bare `true-up` on a config-less repo
  notes that it built with defaults and points to `init`; `SKILL.md` leads with the on-PATH `true-up`
  form (npm install) and labels `node bin/true-up` the from-clone fallback.

## [0.1.2] - 2026-06-22

A compatibility patch for real-world committed-graph and Jujutsu workspaces. No breaking changes.

### Added
- **jj-only repo support.** true-up now discovers non-colocated Jujutsu repos (`jj git init
  --no-colocate`) and uses jj primitives for file listing, span-anchor search, changed paths,
  historical file content, rev validation, and the `--check --committed` graph comparison. Colocated jj
  repos continue to use the Git path.

### Fixed
- **Committed graph output is writable again when explicitly configured.** `0.1.1` refused to rebuild
  when `.true-up.json` explicitly set `"out": ".true-up/depgraph.json"` and that generated graph was
  tracked. That broke the committed-graph discipline. true-up now allows tracked generated graph paths
  under `.true-up/` while still refusing tracked content outputs like `README.md`.

## Version timeline

| Version | Date | Summary |
|---|---|---|
| [0.1.4](#014--2026-06-23) | 2026-06-23 | Multi-agent/worktree status identity, repo-qualified next commands, impact proof mode, and atomic graph writes. |
| [0.1.3](#013--2026-06-22) | 2026-06-22 | Agent guidance and npm publishing handoff are modeled in true-up's own dependency graph. |
| [0.1.2](#012--2026-06-22) | 2026-06-22 | jj-only workspace support plus the committed-graph output fix for repos that intentionally track `.true-up/depgraph.json`. |
| [0.1.1](#011--2026-06-22) | 2026-06-22 | Docs rewritten for users (README no longer leaked internal/maintainer framing); a doc-fact-check found and fixed real drift (a README config example that failed to build, an `init` exit-code claim, an installer `--help` source leak); six deterministic doc/marker-drift gates added so it can't recur. |
| [0.1.0](#010--2026-06-22) | 2026-06-22 | First tagged release: the deterministic, git-native truing-up engine — language-agnostic, read-only-by-design, marker-free, self-dogfooding. |

## [0.1.1] - 2026-06-22

A docs + self-gating patch. No breaking changes; the command surface and behavior are identical to
0.1.0 except one spurious flag was removed (`status --committed`, which no code path honored). The
motivation: true-up's own README had drifted — a keeping-things-in-sync tool shipping a stale, internal
README. This release fixes the rot and makes the whole class of doc/marker drift impossible to ship.

### Changed — docs rewritten for users
- **README.md** is now user-facing: removed internal jargon (the old span-vs-symbol layer naming,
  self-dogfood, invariants, steward) — that lives in
  [AGENTS.md](https://github.com/rawwerks/true-up/blob/main/AGENTS.md) — and restructured to
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

### Added — six deterministic doc/marker-drift gates (tests/engine.sh, in `npm test` + local CI)
- **docs-in-sync** (every `capabilities` command documented in README + SKILL), **flag-coverage**
  (every contract flag documented), **no-stale-init** (proves idempotency, then forbids the exit-1
  claim), **no-jargon** (no Tier/Axiom in user docs or installer `--help`), **no-source-leak**
  (installer `--help` prints no code), and **marker-free** (true-up's own build has zero inline-marker
  edges — the "no markup in our files" invariant was claimed in AGENTS.md but never asserted; now it is).
  Provenance: two multi-agent audits in
  [agent_ergonomics_audit/](https://github.com/rawwerks/true-up/blob/main/agent_ergonomics_audit/audit/HANDOFF.md).

## [0.1.0] - 2026-06-22

First public, tagged release. true-up is a deterministic, git-native engine that builds a typed,
content-hashed dependency graph of a repo and gates on staleness — detecting what a change makes
stale, regenerating the mechanical, and worklisting the advisory, without an LLM guessing. It is
**read-only with respect to your content**: its only writes are `.true-up/` (the graph), `.true-up.json`
(`init`), and `.git/hooks/` (opt-in) — enforced by a snapshot test.

### Hardened — safety & agent-ergonomics (pre-release pass)

A pre-release pass (driven by a multi-lens audit; see
[`agent_ergonomics_audit/`](https://github.com/rawwerks/true-up/tree/main/agent_ergonomics_audit)) closed
safety footguns and made the CLI dramatically easier for an AI agent to use correctly on the first try.
Every fix ships with a regression test (`tests/engine.sh` T40–T72).

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
  steward, the docs derive from it via sidecar `seed`, and `npm test` + local CI run `true-up gate` on
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

[0.1.4]: https://github.com/rawwerks/true-up/releases/tag/v0.1.4
[0.1.3]: https://github.com/rawwerks/true-up/releases/tag/v0.1.3
[0.1.2]: https://github.com/rawwerks/true-up/releases/tag/v0.1.2
[0.1.1]: https://github.com/rawwerks/true-up/releases/tag/v0.1.1
[0.1.0]: https://github.com/rawwerks/true-up/releases/tag/v0.1.0
