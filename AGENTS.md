# AGENTS.md — maintainer notes for true-up

Audience: **dev agents** maintaining/extending true-up. Users read [`README.md`](./README.md);
agents running true-up in their own repo read [`SKILL.md`](./SKILL.md).

## What this is

A deterministic, git-native dependency-graph engine for "truing up" a repo. Extracted from an
internal corpus where it was proven; this repo is the standalone, repo-agnostic tool.

## Layout

```
bin/true-up        thin CLI entry → lib/engine.mjs
lib/engine.mjs     the engine: build / --check[ --committed] / --impact / --policy / --externalities / --verify-scope / run / init / capabilities / --version / --help (every read-side cmd takes --json)
lib/symbols.mjs    Tier 2 (OPTIONAL): tree-sitter symbol extraction. Static-imported but loads
                   web-tree-sitter LAZILY (only when .true-up.json sets "symbols") — the zero-dep core never touches it
tests/engine.sh    fixture-based regression harness (synthesizes a target repo, runs the real CLI)
docs/CONFIG.md     the .true-up.json schema + the marker/anchor conventions
examples/          an example .true-up.json
package.json       optionalDependencies: web-tree-sitter + tree-sitter-wasms (EXACT-pinned, Tier 2 only)
.true-up.json      true-up's own config (it trues up itself — dogfood)
```

## CLI surface + exit contract (the gates exit nonzero)

The CLI is a set of gates, so exit codes are load-bearing — wire them straight into pre-commit/CI.
Verify against `lib/engine.mjs` before changing any of this.

- `true-up` (no args) — (re)build + write the graph JSON to `out` (default `.true-up/depgraph.json`). Exit 1 on an unresolved anchor (fail-loud); otherwise exit 0. Prints a NOTICE when no facts/edges are declared (the drift layer is INERT).
- `true-up --check` — working-tree freshness: exit 1 if the ON-DISK graph differs from a fresh rebuild.
- `true-up --check --committed` — the real drift gate: exit 1 if the COMMITTED-or-STAGED graph blob differs from a fresh rebuild (prefers the staged blob for pre-commit, else `HEAD:` for CI). An **untracked** graph fails (false assurance is worse than none).
- `true-up --impact <path|path#fact>… [--since <ref>]` — who is made stale; exit 0. A bad `--since` ref exits 2 (not a silent "0 dependents"); no graph on disk exits 2.
- `true-up --policy [--report]` — zone/visibility lint. **EXIT 1 on violations**; `--report` forces exit 0 (report-only).
- `true-up --externalities [--report]` — machine-local-path leak scan. **EXIT 1 on leaks**; `--report` forces exit 0.
- `true-up --verify-scope [--since <ref>]` — anti-code-golf gate: exit 1 (naming the file) if a changed file is not explained by the graph (the changed source, its regenerated/advisory dependents, or the cache). Vacuous (exit 0, stderr NOTE) on a no-edge repo. Bad ref exits 2.
- `true-up run [--since <ref>] [--strict]` — deterministic truing-up loop; exit 1 if not GREEN (regen failed / policy violations / depgraph stale), exit 2 under `--strict` when GREEN but advisory prose review is still pending. Verify reads the `--policy` child's EXIT CODE, not its stdout.
- `true-up gate [--committed]` — one CI stage: spawns `--check` (+`--committed`) · `--policy` · `--externalities` as children and exits **1 if ANY fails**, 0 if all pass. `--json` reports per-check status. The exit code is the contract (a runner keys on it). Build the graph first so `--check` is meaningful.
- `true-up hooks [--install|--uninstall|--ci]` — per-repo adoption: writes/removes executable `pre-commit` + `pre-push` (resolved via `git rev-parse --git-path hooks`, honoring `core.hooksPath`/worktrees) carrying the `managed-by: true-up-hooks` marker; idempotent; backs up a pre-existing foreign hook to `*.bak`. Hooks **fail closed** if `true-up` is absent. `--ci` prints a version-pinned GH Actions snippet. Exit 2 if not a git repo. (pre-push too: `jj commit` bypasses pre-commit.)
- `true-up init` — scaffold a starter `.true-up.json`; exit 1 if one already exists (won't overwrite).
- `true-up capabilities` — machine-readable contract (commands, flags, exit-code dictionary); always JSON; exit 0. Axiom 9: an agent reads the contract from the tool, not out-of-band.
- `true-up --version | -v` — print the version; exit 0.
- `true-up --help | -h | help` — prints the command table and **writes nothing** (exit 0). An **unknown command exits 2 and writes nothing** (with a `did you mean: …` suggestion) — it does NOT fall through to a silent build+write into the target repo.
- **`--json` on every read-side command** — a single JSON object on **stdout** (data only; diagnostics on stderr, Axiom 4) so workflows parse the result instead of regex-scraping. The exit code is unchanged by `--json`.

"The workflow today" = `true-up run`. The agentic prose-rewrite `/workflow` is roadmap, not built (see Roadmap).

## Load-bearing invariants (do not regress — each is a test in `tests/engine.sh`)

1. **Directed, causal edges only.** `from` = dependent → `to` = source-of-truth. Direction basis
   ∈ {generator (a `<!-- generated by X from Y -->` marker), declared (a steward edge in config
   `seed`), anchored (`<!-- fact: path#arrayProp.key -->`), symlink (`alias-of`)}. Correlation
   (co-change/embeddings) may *propose* candidates but must NEVER assign the arrow — none are emitted.
2. **Impact is deterministic.** The worklist is content-hash + graph traversal. The LLM only
   *proposes* edits; it never decides staleness. (The prior LLM-coverage approach was
   non-deterministic and non-monotonic — that failure mode is why this rule exists.)
3. **Per-fact granularity + early-cutoff, in any language.** A content-hashed fact node comes from
   one of three extractors: steward JSON (`facts`), a **span anchor** (`true-up:anchor`/`true-up:end`
   bracketing a region of any file, zero-dep), or a **tree-sitter symbol** (opt-in `"symbols": true`).
   An anchored dependent is stale only when *its* fact's hash moves. CRITICAL: extractors only produce
   NODES — the edge still comes from an explicit anchor/seed/marker (invariant 1). Span/symbol code is
   never an exception to "correlation never assigns the arrow."
4. **Fail-loud.** An anchor that doesn't resolve to a known fact node is a hard error (stable IDs).
5. **Mechanical vs advisory.** `generated-from` / `symlink` edges are *mechanical* (regenerate, no
   LLM). `derives-facts-from` (declared or anchored) is *advisory* (a human/LLM rewrites prose).
6. **Repo-agnostic.** The engine operates on a TARGET repo (`--repo` / CWD git-toplevel) driven by
   `<repo>/.true-up.json`. Nothing repo-specific is hardcoded; `run`'s regeneration is data-driven
   from each edge's `via` (the generator the marker names), never a hardcoded list.
7. **Git is the database — commit-optional.** The graph is a JSON file derived purely from sources
   (markers / anchors / `.true-up.json` seed), so the *real* source of truth is the repo's tracked
   content, never a DB. Committing the graph blob is **optional**: `.gitignore` ships ignoring
   `.true-up/`, and `--check` (working-tree freshness) works whether or not you commit it. For repos
   that DO commit the graph, `--check --committed` is the drift gate that catches "committed a source
   change without re-staging the regenerated graph" (an untracked graph fails it). Do not claim the
   graph "is a committed JSON file" unconditionally — that was an overclaim; it contradicted the shipped
   `.gitignore`. (A derived SQLite cache is a future option *only* for query-at-scale — never the source
   of truth.)

## Harness

Tests ARE the harness: every invariant and every past incident is a case in `tests/engine.sh`.
`npm test` runs it (sub-minute, fixture-based). When you fix a bug, add the test that catches it.

### Durable lessons from the telltail dogfooding round

Provenance: these came from a real user dogfooding report (telltail v0.1.0) run against true-up as an
*external* repo — not our own self-trueing. Each lesson below now has a regression case in
`tests/engine.sh`; preserve them.

- **A "gate" must carry an exit code.** `--policy` and `--externalities` were documented as gates but
  unconditionally exited 0 — so CI/pre-commit could never actually block on them. A gate's contract IS
  its nonzero exit; report-only mode is opt-in (`--report`), not the default. (HIGH-1.)
- **Leak detectors must `stripCode` and offer a suppression escape hatch.** The detectors scanned raw
  content, so a doc that quoted a forbidden path/token shape inside a code span false-positived on
  itself (e.g. a privacy policy listing forbidden shapes). Fix: scan `stripCode(content)` and honor
  `<!-- true-up:ignore-line/-next [rule] -->`. A linter that can't lint its own documentation honestly
  is a foot-gun. (HIGH-2.)
- **`--check` (working-tree) ≠ `--check --committed` (drift gate).** `--check` proved rebuild-equality
  against the on-disk file; it did NOT verify the *committed* graph, despite docs promising committed
  verification — and an untracked graph silently "passed." Keep the two modes distinct and name which
  one a given gate uses; the committed-graph check must fail on an untracked blob. This also forced the
  commit-optional reconciliation above (the shipped `.gitignore` ignores `.true-up/`, contradicting any
  "the graph is a committed file" claim). (HIGH-3.)
- **`--help` (and any unknown arg) must never write.** `--help`/unknown args fell through to a silent
  build+write into the *target* repo (exit 0) — a destructive foot-gun for anyone exploring the CLI.
  `--help` now prints and writes nothing (exit 0); an unknown command exits 2 and writes nothing. A
  read-intent or malformed invocation must never mutate the target repo. (HIGH-4.)
- **A pipefail-coupled test breaks the moment a gate starts exiting nonzero — assert on output, not the
  pipeline exit.** `tests/engine.sh` runs `set -uo pipefail`; once `--policy`/`--externalities` began
  exiting 1 on violations, any `$TU … | grep …` case had its exit masked/flipped by the failing gate in
  the pipe. The durable fix is to capture and assert on the gate's OUTPUT (and separately on its `rc`),
  never on a pipeline's exit through the gate (see the comment at `tests/engine.sh` and the HIGH-1
  cases). When you make a command start exiting nonzero, audit every test that pipes from it.
- **Read the child's exit code, not its stdout.** `run`'s verify step sniffed `--policy` stdout with a
  regex to decide clean/dirty; now it reads the child process's EXIT CODE. Structured status belongs in
  the exit code, not in a stdout string a refactor can silently reword. (MED.)
- **A bad ref is an error, not an empty result.** `--impact --since <bad ref>` swallowed the failure and
  reported "0 dependents" (exit 0), which reads as "nothing is affected" — the most dangerous possible
  false negative. A ref that doesn't resolve to a commit now exits 2. (MED.)
- **No hardcoded repo-local paths in a repo-agnostic tool.** Dead hints like `node meta/build-depgraph.mjs`
  and a hardcoded `meta/depgraph.json` would `MODULE_NOT_FOUND` when the tool runs against any other
  repo; use `rel(OUT)`/`rel(self)` so messages are correct in the target repo. (MED.)
- **Fact-model scope was a JSON-only boundary — now lifted for code (Tier 1 + Tier 2).** Historically
  `extractFacts` only decomposed top-level JSON arrays-of-objects and `listFiles` kept `.md/.json/.mjs/.js`,
  so a `.py` source-of-truth got 0 fact-nodes and was inert. Code is now fact-granular two ways, both
  reusing the same fact-node/anchor/edge/since machinery: **Tier 1 span anchors** (`extractSpans`, scans
  files containing `true-up:anchor` via `git grep -I`, zero-dep, any language) and **Tier 2 tree-sitter
  symbols** (`lib/symbols.mjs`, opt-in `CONFIG.symbols`, optional dep, `extractSymbols`). A declared
  (seed) edge to a tracked code file still works at file granularity. Design rules that MUST hold:
  (a) extractors create NODES only — edges stay explicit (anchor/seed/marker); (b) Tier 2 is
  CONFIG-driven not a transient flag, so `--check` stays deterministic, and **fails loud (exit 2)** if
  enabled-but-deps-absent rather than silently building a symbol-less graph; (c) malformed span anchors
  are IGNORED (not fatal) so a file can document the token without self-tripping — the backstop is the
  unresolved fact-anchor hard error when a doc actually depends on a missing span. (Dogfood-found: the
  build `inert` flag must key off `edges.length`, not `config.facts` — span/symbol facts make a repo
  with empty `facts` non-inert.)

## Extending

- New edge kind → give it a propagation (`mechanical`/`advisory`) and a direction basis; add a test.
- New policy rule → add to the zone `rules` vocabulary + a mechanical check; default-enforce on all
  public files where it's a leak class (see the no-machine-local-paths / private-leak pattern).
- New leak detector → scan `stripCode(content)`, never the raw content: a doc that legitimately quotes
  a forbidden path/token shape inside an inline/fenced code span must not false-positive (`stripCode`
  blanks code spans while preserving line numbers). Then honor the per-line suppression directives so a
  legitimate prose example (e.g. a privacy policy showing a forbidden path shape outside a code span)
  can opt out: `<!-- true-up:ignore-line [rule] -->` and `<!-- true-up:ignore-next [rule] -->`. The
  optional `[rule]` scopes the suppression; omitted = all rules. Directives are matched against the
  ORIGINAL line text (so they survive even when `stripCode` would blank the span around them).
- New symbol language (Tier 2) → add an ext entry to `LANGS` in `lib/symbols.mjs` (grammar wasm name
  + the definition node types), confirm `tree-sitter-wasms` ships that grammar, and add a fixture
  test. Languages with a `name` field resolve cleanly; declarator-named ones (C/C++) use `nameOf`'s
  fallback. Pin grammar+runtime versions exactly (determinism) — a grammar bump re-hashes every symbol.
- Keep output deterministic (sorted, no timestamps) so `--check` stays honest.

## Running it cross-repo

Not on `PATH` after a bare clone — either `npm link` it, or (the canonical, no-install pattern) invoke
the entry directly against a target:

```
node bin/true-up --repo <target-repo> --policy
```

`--repo` | `$TRUE_UP_REPO` | git-toplevel-of-CWD | CWD selects the target (in that order). There is no
agentic prose-rewrite `/workflow` yet (roadmap) — **"run the workflow" today means `true-up run`**, the
deterministic mechanical loop. Don't point users at a `/workflow` that doesn't exist.

### Vendoring true-up (as a submodule)

A consumer may vendor true-up as a git submodule and call `node vendor/true-up/bin/true-up`. If they
clone without `--recursive`, `lib/engine.mjs` is absent; `bin/true-up` catches the `ERR_MODULE_NOT_FOUND`
and prints `git submodule update --init --recursive` (exit 2) instead of a raw stack trace. For a
deterministic gate, pin the submodule to a tag and (if using Tier 2) commit the vendored `bun.lock`.

## Roadmap

- Claude Code `/workflow` for the advisory rewrites (fan-out per stale doc → minimal rewrite →
  adversarial-verify → loop until `run` is green). **Not built yet** — today the advisory worklist that
  `run` prints is reviewed/rewritten by a human or LLM; the CLI itself never edits prose.
- An installer that wires git hooks (a shared read-only gate on pre-commit AND pre-push — note that
  `jj commit` bypasses git hooks, so the gate must live on pre-push too) + CI into a target repo.
- mycelium note enrichment (knowledge layer alongside the structural graph).
