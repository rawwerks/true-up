# AGENTS.md — maintainer notes for true-up

Audience: **dev agents** maintaining/extending true-up. Users read [`README.md`](./README.md);
agents running true-up in their own repo read [`SKILL.md`](./SKILL.md).

## What this is

A deterministic Git/jj-native dependency-graph engine for "truing up" a repo. Extracted from an
internal corpus where it was proven; this repo is the standalone, repo-agnostic tool.

## Layout

```
bin/true-up        thin CLI entry → lib/engine.mjs
lib/engine.mjs     the engine: build / --check[ --committed] / --impact / --policy / --externalities / --verify-scope / run / export / init / capabilities / --version / --help (every read-side cmd takes --json)
lib/config.mjs     zero-dependency config loader: legacy parity + deterministic one-level composition;
                   consumed once by every config-dependent CLI invocation
lib/symbols.mjs    Tier 2 (OPTIONAL): tree-sitter symbol extraction. Static-imported but loads
                   web-tree-sitter LAZILY (only when .true-up.json sets "symbols") — the zero-dep core never touches it
tests/engine.sh    fixture-based regression harness (synthesizes a target repo, runs the real CLI)
tests/config-composition.mjs  pure loader contract: schema/order/barriers/paths/bounds/provenance/properties
tests/config-composition-cli.mjs  real-CLI parity, fail-closed, version-skew, and subprocess-boundary gate
tests/config-composition-worktrees.mjs  Git/jj staging, race, filter, and worktree-isolation gate
tests/config-composition-adversarial.mjs  compound boundary/error-precedence and atomic-state corpus
tests/config-composition-fuzz.mjs  fixed-seed production-loader metamorphic/property campaign
tests/config-composition-mutations.mjs  named production mutation matrix with reverted-green controls
tests/config-composition-capabilities.mjs  HELP/ROBOT/capabilities/generated-steward composition contract
tests/config-composition-package.mjs  explicit-entry source/installed-package composition conformance
tests/large-json-transport.mjs  source/packed guard for complete >64 KiB structured + human stdout, EPIPE, and installed-entry symlinks
tests/large-vcs-output.mjs  bounded/fail-loud VCS reads plus opaque Git/jj path transport
tests/json-envelope-contract.mjs  command-inventory guard for the uniform `--json` envelope contract
docs/CONFIG.md     the .true-up.json schema + the marker/anchor conventions
examples/          flat and runnable multi-file composed configuration examples
meta/build-contract.mjs  generates meta/contract.json from `true-up capabilities`; --check gates engine→contract drift
meta/contract.json the command + agent-guidance + config-composition STEWARD (generated, committed)
workflows/         external-agent maintenance/audit workflow templates; shipped in npm because SKILL.md links them
package.json       npm allowlist + optional tree-sitter peer/dev deps (EXACT-pinned, Tier 2 only); posttest = self-gate
.true-up.json      sentinel-only root for true-up's own marker-free composed self-config
config/true-up/    load-bearing core facts, dependency edges, and audience/zone fragments
```

## CLI surface + exit contract (the gates exit nonzero)

The CLI is a set of gates, so exit codes are load-bearing — wire them straight into pre-commit/CI.
Verify against `lib/engine.mjs` before changing any of this.

- `true-up status [--since <ref>]` — **read-only ORIENTATION mega-command** (Axiom 10): one call returns workspace identity (`workspace.root`, target source `cwd`/`$TRUE_UP_REPO`/`--repo`, Git linked-worktree metadata, jj mode, mismatch warnings), built/stale, graph stats, what's stale since `<ref>` (mechanical + advisory worklist), policy/leak status, and copy-paste `nextCommands[]`. Exits 0 as a probe (not a gate — `gate` is the authoritative CI exit), exits 2 only for usage errors such as a bad `--since` ref/revset, and writes nothing. The canonical first command an agent reaches for; `triage`/`doctor`/`overview`/`update`/`docs` etc. redirect here or to the right verb via an intent/synonym map (not just lexical did-you-mean). Multi-agent/multi-worktree agents must inspect `.workspace` before acting on `nextCommands`.
- `true-up graph [--json]` — **read-only graph inspection**: prints the actual nodes, audiences/zones, edges, propagation, and generator `via` fields. This is the command for "show me the graph" / "look at the data"; writes nothing.
- `true-up build` — explicit verb for the bare build below (discoverable alias).
- `true-up` (no args) — (re)build + write the graph JSON to `out` (default `.true-up/depgraph.json`). Exit 1 on an unresolved anchor (fail-loud); otherwise exit 0. Prints a NOTICE when no facts/edges are declared (the drift layer is INERT).
- `true-up --check` — working-tree freshness: exit 1 if the ON-DISK graph differs from a fresh rebuild.
- `true-up --check --committed` — the real drift gate: exit 1 if the VCS-stored graph blob differs from a fresh rebuild. Git reads the selected worktree's **index blob only**; in clean CI the index mirrors `HEAD`. A staged deletion therefore stays missing and must never fall back to `HEAD`. jj-only reads `@`. A missing/untracked graph fails (false assurance is worse than none).
- `true-up --impact <path|path#fact>…` OR `true-up --impact --since <ref> [--proof]` — who is made stale; exit 0. The two modes are mutually exclusive: explicit targets answer "what depends on X", while `--since` derives the changed set from the ref range (`--proof`, valid only with `--since`, adds an audit map from changed facts/sources to dependents and marks whether dependents changed in the same range). Combining explicit targets with `--since` is rejected (`unexpected-arg`, exit 2). It must list every dependent artifact; do not collapse generated outputs just because they share one generator `via`. With `--since`, the default view is "remaining stale". A bad Git ref / jj revset exits 2 (not a silent "0 dependents"); no graph on disk exits 2.
- `true-up --policy [--report]` — zone/visibility lint. **EXIT 1 on violations**; `--report` forces exit 0 (report-only).
- `true-up --externalities [--report]` — machine-local-path leak scan. **EXIT 1 on leaks**; `--report` forces exit 0.
- `true-up --verify-scope [--since <ref>]` — anti-code-golf gate: exit 1 (naming the file) if a changed file is not explained by the graph (the changed source, its regenerated/advisory dependents, or the cache). Vacuous (exit 0, stderr NOTE) on a no-edge repo. Bad ref exits 2.
- `true-up run [--since <ref>] [--strict]` — deterministic truing-up loop; exit 1 if not GREEN (regen failed / policy violations / depgraph stale), exit 2 under `--strict` when GREEN but advisory prose review is still pending. Verify reads the `--policy` child's EXIT CODE, not its stdout.
- `true-up gate [--committed]` — one CI stage: spawns `--check` (+`--committed`) · `--policy` · `--externalities` as children and exits **1 if ANY fails**, 0 if all pass. `--json` reports per-check status. The exit code is the contract (a runner keys on it). Build the graph first so `--check` is meaningful.
- `true-up hooks [--install|--uninstall|--ci] [--force]` — Git-backed per-repo adoption: writes/removes executable `pre-commit` + `pre-push` (resolved via `git rev-parse --git-path hooks`, honoring `core.hooksPath`/worktrees) carrying the `managed-by: true-up-hooks` marker; idempotent; backs up a pre-existing foreign hook to `*.bak` **once** (never clobbers an existing `.bak`), and `--uninstall` **restores** that backup. SAFETY: if the resolved hooks dir is **outside this repo's `.git`** (a shared/global `core.hooksPath`), `--install`/`--uninstall` **REFUSE** (exit 2) with a loud message unless `--force` — this prevents silently rewiring every repo on the machine (the incident that overwrote a dev's global hooks during `npm test`; the test harness is now git-config-isolated too). Hooks **fail closed** if `true-up` is absent. `--ci` prints a version-pinned GH Actions snippet. Exit 2 if there is no Git hooks dir. (pre-push too: `jj commit` bypasses pre-commit; non-colocated jj has no Git hooks dir for this command.)
- `true-up export --audience <public|internal|private|secret>` — emits a one-way inter-repo import snapshot from explicit `.true-up.json` `exports`. The source repo controls the allowlist; crossing from higher-visibility source material to a lower audience requires per-export `"declassify": true`. Consumers must track/stage a regular in-repo snapshot, pin `repoId` and `audience` under `imports`, then seed local advisory edges to `@alias:fact`. No live sibling-repo paths, symlink snapshots, raw values, source paths, commit ids, or executable imported generator metadata are allowed. Non-public import taint propagates through local files/facts and blocks public re-export.
- `true-up init` — scaffold a starter `.true-up.json`; **idempotent** (exit 0): never overwrites an existing config, and "already scaffolded" is success — exit 1 is reserved for gate violations everywhere else.
- `true-up capabilities` — machine-readable contract (commands, flags, exit-code dictionary, **`quickstart` task→command map, `entrypoints`, `cmd_flags`** = the live per-command flag map, `error_codes`, and versioned `config_composition` schema/merge/path/worktree/error contract); always JSON; exit 0. Axiom 9: an agent reads the contract from the tool, not out-of-band.
- `true-up robot-docs` (alias `--robot-help`) — paste-ready **in-tool agent handbook** (task→command recipes); writes nothing; works outside any repo; exit 0. `capabilities` is the machine CONTRACT, this is the QUICKSTART.
- `true-up --version | -v | version` — print the version; exit 0.
- `true-up --help | -h | help` — prints the command table (with a COMMON TASKS block) and **writes nothing** (exit 0). An **unknown command/flag exits 2 and writes nothing** (with a `did you mean: …` suggestion that consults the synonym map, then cross-prefix Levenshtein, then global flags) — never a silent fall-through to build+write. A **stray positional on a no-positional command exits 2** (Axiom 14 — `gate zzz` must not silently PASS).
- **`--json` on every documented JSON-capable command** — the required contract is one JSON object on
  **stdout** (data only; diagnostics on stderr, Axiom 4), always carrying **`ok`** (boolean pass/fail)
  and **`_v`** (contract version); error paths carry `{ok:false, kind, …}` and preserve the command's
  exit code. `tests/json-envelope-contract.mjs` derives coverage from live capabilities and currently
  inventories 59 success/error cases: canonical commands, documented aliases, hooks modes, absent
  optional symbol dependencies, usage/config/fail-loud diagnostics, and missing-value,
  trailing-global, and stray-positional guards. **Wave 0B verification is complete:** the inventory
  passes both source and clean-installed-package entries, the full source/CI lifecycles pass, and an
  independent package audit found no remaining Critical/High/Medium gap.

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
6. **Repo-agnostic.** The engine operates on a TARGET repo (`--repo` / CWD Git/jj toplevel) driven by
   `<repo>/.true-up.json`. Nothing repo-specific is hardcoded; `run`'s regeneration is data-driven
   from each edge's `via` (the generator the marker names), never a hardcoded list.
7. **The VCS is the database — commit-optional.** The graph is a JSON file derived purely from sources
   (markers / anchors / `.true-up.json` seed), so the *real* source of truth is the repo's tracked
   content, never a DB. Committing the graph blob is **optional**: `.gitignore` ships ignoring
   `.true-up/`, and `--check` (working-tree freshness) works whether or not you commit it. For repos
   that DO commit/track the graph, `--check --committed` is the drift gate that catches "source changed
   without the regenerated graph" (a missing/untracked graph fails it). Git mode reads only the selected
   worktree's index blob (clean CI's index mirrors `HEAD`); it never rescues a staged deletion from
   `HEAD`. jj-only mode reads `@`. Do not claim the graph "is a committed JSON file" unconditionally
   — that was an overclaim; it contradicted the shipped `.gitignore`. (A derived SQLite cache is a future
   option *only* for query-at-scale — never the source of truth.)
8. **Read-only wrt content (the write invariant).** true-up NEVER modifies/creates/deletes a content
   file. Its entire write surface is three paths: `.true-up/depgraph.json` (bare build), `.true-up.json`
   (`init`, no-clobber), and `.git/hooks/*` (opt-in Git-backed `hooks --install`). `run` mutates content ONLY by
   executing user-declared external generators (`execFileSync` of the edge's `via`) — true-up's own code
   authors no prose/code (it emits an advisory worklist; "this CLI never edits prose"). `--no-write` (a
   global, like `--json`) persists NOTHING — build computes in memory, `--impact`/`run` fall back to an
   in-memory build, `run --no-write` is a dry-run. ENFORCED by the T35 keystone (snapshot every file
   before/after every read-side command → zero content-byte change) + T38 (`--no-write` writes nothing).
   Graph writes use a temp file plus rename so concurrent agents rebuilding the same worktree graph do
   not leave a torn JSON file; tests exercise parallel builds.
   A tracked generated graph under `.true-up/` is still part of the write surface and MUST remain
   writable; only tracked *content* outputs are refused (T14b prevents the 0.1.1 regression).
   Edges are declarable **marker-free** via fact-granular `seed` (`to: path#fact` → JSON-key / span /
   symbol), with fail-loud parity (a bad seed target is a hard error, not a dropped edge). Do NOT add a
   parallel `.true-up.facts.json` hash sidecar — `--check --committed` already IS the stored-expected-hash
   verify-don't-regenerate gate (the committed graph blob holds every fact's expected hash); a second
   sidecar is a deletion-blind, merge-conflict-prone second source of truth (decision: rejected).
9. **Inter-repo dependencies are consented snapshots, never live reads.** A repo may depend on another
   repo's exported facts without the source knowing, but only through a tracked/staged local snapshot
   whose `repoId` and `audience` are pinned by the consumer. This is intentionally directional: one-way
   mirrors are allowed; federated live graph reads are not. Public/private boundaries are enforced by
   the visibility lattice (`public < internal < private < secret`), explicit declassification on the
   source side, consumer-side pins, strict snapshot schema, taint propagation, and policy/export gates.
   Local edge privacy checks compare visibility ranks, not literal directory names; a public or internal
   node deriving from `secret/` must fail even when the path is not `private/`. Every privacy failure
   found by adversarial review belongs in `tests/engine.sh`.

## Harness

Tests ARE the harness: `tests/engine.sh` is the fixture orchestrator, and dedicated helpers cover
large stdout transport, large VCS reads, and the JSON-envelope inventory. `npm test` runs the complete
source-entry set; local CI repeats package-boundary cases against the clean installed tarball. When you
fix a bug, add the deterministic test that catches it.

The composition T80 family is split across the pure loader, real-CLI, Git/jj/worktree, compound
adversarial, fixed-seed property, production-mutation, machine-contract, and package-boundary suites
listed above. All eight run in the standard source lifecycle; local CI repeats the package harness
against a clean tarball install with optional dependencies omitted and repeats the real-CLI suite from
a freshly initialized one-commit source tree that provably lacks both historical runtime objects. Keep
the pure loader importable without dispatching the CLI, computing `OUT`, reading a graph, or writing
anything. The installed harness must use the explicit supplied entry and verify its `bin/`,
`lib/engine.mjs`, and `lib/config.mjs` adjacency; it must never fall back to the source checkout or
`PATH`.

Source tests must also be reproducible from a signed, history-free source snapshot. A regression may
not fetch an older runtime with `git show`/`git archive` or otherwise assume that a full clone's object
database is present. The exact pre-composition runtimes used by the `zones:null` compatibility test are
offline fixtures under `tests/fixtures/pre-composition/`: the suite pins the compressed archive and
every extracted runtime file, and its red controls prove missing/corrupted fixtures and changed engine
bytes fail loud. These test fixtures are deliberately outside the npm package allowlist.

Composition validation order is a read barrier, not cosmetic diagnostics. Validate declaration path
forms in the root before opening any fragment, and in each canonical fragment before opening the next.
Canonicalization and serialization must stay iterative because byte-bounded valid JSON can still be
thousands of levels deep. Duplicate-key scanning must collect every occurrence, pre-index locations
in linear time, and cooperatively tick; an immediate second-key failure loses later origins and an
origin-by-origin prefix rescan becomes quadratic. T80 pins each failure class.

Make regression tests DETERMINISTIC, not best-effort — a guard that can't fail on the regression it
names is worse than none. Two patterns proven here: (a) the atomic graph write (temp file + `renameSync`)
is pinned by an **inode-change** assertion across two builds (rename swaps a fresh inode; an in-place
`writeFileSync` revert would keep it, so the test fails loud) — the parallel-reader race only tears at
multi-MB graphs and silently passed the revert. (b) The release **tag-coherence** guard is factored into
`scripts/ci.sh`'s `check_tag_coherence` + a hermetic `ci.sh --tag-coherence-check <ver>` hook, so the
suite exercises the EXACT guard `prepublishOnly` runs (untagged HEAD under `npm_lifecycle_event=prepublishOnly`
must hard-fail "publish blocked"; a manual run only warns) — the incident it prevents is a nested
`npm run ci` resetting `npm_lifecycle_event` and downgrading the block to a warn.
For inter-repo import/export, the harness must stay adversarial: cover path escapes, untracked or
symlinked snapshots, mismatched `repoId`/`audience`, public→non-public imports, transitive taint,
taint laundering through local fact extraction, malformed snapshot metadata, declassification, and
imported generator execution.

## Self-dogfood (true-up trues up ITSELF, marker-free)

true-up is part of developing true-up — and it does so **without a single inline marker in its own
files** (every edge is a sidecar `seed`). Its root `.true-up.json` is the compatibility sentinel and
literal include list only; `config/true-up/core.json`, `dependencies.json`, and `zones.json` own the
load-bearing declarations. The lifecycle copies the current source snapshot and proves deleting the
fragment-only contract facts fails the real graph gate. The wiring:

- **Source of truth → steward.** The command surface and in-tool agent guidance live in the engine
  (`HELP`, `ROBOT_DOCS`, and `capabilities`). `meta/build-contract.mjs` generates `meta/contract.json`
  (a committed steward, one fact per command plus explicit `agent_guidance` and named
  `config_composition` facts) from
  `true-up capabilities`. `meta/build-contract.mjs --check` is the **engine→contract drift gate**
  (fails if the steward is stale vs the engine) — run in `npm test` posttest and local CI. The generated
  steward is also modeled as a marker-free **mechanical** seed edge (`kind: generated-from`, `via:
  meta/build-contract.mjs`) from `bin/true-up`, `lib/engine.mjs`, and the generator itself.
- **Docs → contract (marker-free).** The composed dependency fragment declares the dependency: `README.md`
  derives-facts-from each `meta/contract.json#commands.<name>` it documents, plus
  `meta/contract.json#agent_guidance.declared-seed-edge`; `docs/CONFIG.md` also derives from that
  agent-guidance fact. README, SKILL, CONFIG, and AGENTS also derive from each named
  `config_composition` fact, so a schema/merge/path/worktree change has a precise blast radius.
  `AGENTS.md` and `SKILL.md` additionally derive-facts-from the whole `meta/contract.json`
  (file-granular). No `<!-- fact: -->` anchors anywhere — the build proves it (`byDirectionBasis` is
  all `declared` except symlink aliases).
- **Audience is data, not folklore.** `.true-up.json` `zones` assigns document intent and audience:
  `README.md` is for external users + agents, `SKILL.md` is for external agents, `AGENTS.md` is for
  maintainer agents, `docs/CONFIG.md` is the adopter/config reference, `PUBLISHING.md` is for
  credentialed release agents, `workflows/` is for external agents using the agentic layer,
  `scripts/ci.sh` is the local release trust anchor, `tests/engine.sh` orchestrates the regression
  harness, the dedicated transport/envelope/composition suites pin their named bug classes,
  `config/true-up/` is maintainer-owned self-config, `meta/contract.json` is for agents + CI, and
  `agent_ergonomics_audit/` is the maintainer audit trail.
  The graph stamps those values onto file nodes so `true-up graph --json`
  is the query surface for "who is this artifact for?"
- **Documents depend on documents.** The seed graph also models semantic prose dependencies that no
  parser can infer: `README.md` derives its config summary from `docs/CONFIG.md`; `SKILL.md` derives
  from `README.md`, `docs/CONFIG.md`, the composed root/fragments, and the workflow overview; `AGENTS.md` derives
  from the user/agent docs plus the engine, harness, release, workflow, and local-CI surfaces it summarizes;
  `PUBLISHING.md` derives from package metadata, lockfile, changelog, installer, and local CI.
  This is intentional "more than AST" truth — if a source document changes,
  `true-up --impact <doc>` should name the dependent artifact audiences that need review.
- **Probe the case study directly.** `true-up --impact meta/contract.json#agent_guidance.declared-seed-edge`
  should name the docs that teach marker-free `seed` edges, and `true-up graph --json` should show the
  full audience/dependency map with zero `anchored`/`generator` self-edges. Tests T74/T75 pin this.
  `true-up --impact meta/contract.json#config_composition.merge` should name README, SKILL, CONFIG,
  and AGENTS, while graph/status expose all four config sources and fragment provenance.
- **The tool gates itself locally.** `npm test` posttest runs `true-up gate` (`--check` + `--policy` +
  `--externalities`) on true-up's own repo, and `npm run ci` is the release trust anchor: fixture suite,
  self-gate, contract check, pack, clean-sandbox install, installed composition positives/negatives,
  runnable packaged example, lean optional-dependency failure, rich installed-symbol success, tarball
  run, negative gate, hygiene,
  and version coherence. There is intentionally no hosted GitHub Actions mirror for this repo.
- **When you add/rename/change a command:** regenerate the steward (`npm run contract`), and if it's a
  new command, add its `seed` line(s) so its doc-drift is tracked. The local `npm run ci` gate will remind
  you if you forget to regenerate.
- **When you change composition:** update exported constants/semantics in `lib/config.mjs`, the
  capabilities contract, its dedicated test, and the affected composed-config fact edges; regenerate
  the steward and run both source and clean-installed package conformance.

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
- **Exit 0 must mean stdout is complete.** Calling `process.exit(...)` after asynchronous
  `process.stdout.write(...)` or `console.log(...)` can truncate a piped payload while still reporting
  success. The observed 164,597-byte JSON proof repeatedly stopped at 146,176 bytes; independent audit
  also saw only 268 of 4,096 human graph nodes. Keep direct writes and the process-local `console.log`
  adapter on synchronous `writeStdout`. Preserve `tests/large-json-transport.mjs`: it checks every
  expected node/dependent in source and installed-package structured and human graph/proof/status/dry-run
  outputs, plus exact-boundary and async-writer mutants. It also resolves an installed `.bin/true-up`
  symlink before inspecting the package engine and proves an early downstream pipe close exits nonzero
  with EPIPE. Do not weaken it to shell redirection, because regular-file stdout masked the bug. (HIGH.)
- **VCS output is required input, not a best-effort hint.** Node's historical 1 MiB child-process
  buffer could overflow on `git ls-files` or `git show`; the old catch-to-empty adapters then produced
  false-clean graphs, leak scans, or impact reports. The required adapter is bounded at 64 MiB,
  distinguishes an absent object/no-match from any operational failure, and fails loud with exit 2 plus
  a `vcs-read-failed` JSON envelope. `tests/large-vcs-output.mjs` now covers >1 MiB tracked-list and
  historical-fact reads, injected >64 MiB capture failure, operational object-read failure versus
  genuine absence, Git <=2.40-compatible object probing, index-only staged deletion, an unborn Git
  repository's empty implicit baseline, and non-colocated jj `@-` default plus required-read failure.
  Every Git path inventory is now a byte-buffered, terminal-NUL-validated `-z` stream; invalid UTF-8
  exits 2 instead of decoding to a nonexistent replacement path. Fatal UTF-8 decoding must also set
  `ignoreBOM:true`: despite the counterintuitive name, that preserves a leading U+FEFF as filename
  content instead of silently stripping it and scanning a different path. jj file/diff inventories use JSONL
  templates, and anchor discovery scans the lossless inventory locally because `jj file search` has no
  template mode. The regression pins LF, tab, Unicode, invalid UTF-8, malformed framing, exact seed
  resolution, leading-BOM preservation, leak detection, changed-path impact, and matching non-colocated jj behavior.
  Git diffs use `--no-renames`, because rename collapsing emits only the destination and can erase
  dependents wired to the deleted source. Ref probes treat only the tool's documented absence status
  as absence; operational jj `log` failure stays `vcs-read-failed`. Root discovery must also fail loud
  when a visible Git worktree's probe fails: falling through to colocated jj changes index-only
  committed semantics and can bless a staged deletion. This includes an explicit `--repo` symlink to
  the worktree: directory probes follow that symlink just as `git -C` does, so it cannot bypass the
  Git-marker guard and switch to jj semantics. Security and policy scans treat a tracked
  symlink's link text as its repository content: they use `lstat` + `readlink`, never follow the live
  target. Following the target both hid machine-local link text from the gates and could read mutable
  bytes outside the target repo. The VCS regression pins graph classification plus `--externalities`
  and `--policy` violations for a broken `/home/...` link.
  Release/package fixtures must not inherit an ambient temp root as a VCS ancestor either. This
  machine's `$TMPDIR` contained an unrelated empty `.git`; the source VCS harness passed from its owned
  scratch tree, while the clean-installed harness under bare `mktemp -d` failed every non-colocated jj
  build. `scripts/ci.sh` now allocates `~/scratch/true-up-ci.*`, exports that owned root as
  `GIT_CEILING_DIRECTORIES`, and the self-harness pins both lines. Keep the dynamic ceiling test and the
  static CI-wiring assertion together: one proves engine behavior, the other proves release CI uses it.
  Wave 0B source, clean-package, full-suite, and independent VCS/package audits all pass on the
  remediated snapshot. (HIGH, resolved in Wave 0B.)
- **A uniform JSON contract needs an inventory gate, not spot checks.** Wave 0B first found documented
  JSON-capable success paths that emitted `_v` without boolean `ok`, plus a symbols dependency failure
  with stderr only. The current 59-case inventory derives canonical coverage from live capabilities,
  covers documented aliases and hooks modes, and adds diagnostic parity plus missing-value,
  trailing-global, and stray-positional usage guards. Every `ok:false` case must carry its own nonempty
  stable `kind`; the inventory deliberately does not substitute `error` for a missing kind and pins
  the exact kind per case. It also checks every expected exit against the owning capability row and
  every expected kind against the exhaustive `error_codes` list. Three broken-seed cases ensure
  in-memory impact, scope, and dry-run commands call the shared graph-build-error gate rather than
  returning 0 dependents, vacuous PASS, or GREEN. It must fail on command, exit, error-code, or usage-
  guard coverage drift. The source and clean-installed-package inventories, full lifecycle, and
  independent package audit all pass.
  The earlier frozen red baseline remains useful historical evidence: 38/50 cases passed, with 12
  failures across bad-ref/outside-VCS/invalid-config/build-error/unknown-target/export-usage/
  unknown-command-or-flag/hooks-refusal diagnostic paths. (HIGH, resolved in Wave 0B.)
- **A bad ref is an error, not an empty result.** `--impact --since <bad ref>` swallowed the failure and
  reported "0 dependents" (exit 0), which reads as "nothing is affected" — the most dangerous possible
  false negative. A ref that doesn't resolve to a commit now exits 2. (MED.)
- **No hardcoded repo-local paths in a repo-agnostic tool.** Dead hints like `node meta/build-depgraph.mjs`
  and a hardcoded `meta/depgraph.json` would `MODULE_NOT_FOUND` when the tool runs against any other
  repo; use `rel(OUT)`/`rel(self)` so messages are correct in the target repo. (MED.)
- **Impact is a blast-radius list; generator execution is a separate grouping.** Telltail docs-site
  exposed the trap: 20 API pages and 17 CLI pages all depended on source generators while sharing one
  wrapper `via`. `--impact <generator-file>` must enumerate every generated page, both human and JSON;
  only `run` should deduplicate by distinct `via` when deciding what executable to invoke. If a UI ever
  groups or summarizes this, it must say how many dependents were omitted. (MED.)
- **Completed-pass audit is different from remaining-stale impact.** Prose-lint feedback surfaced a
  real audit gap: after a rename workflow edits both a source fact and its dependent docs,
  `--impact --since <ref>` can show changed facts but zero dependents because the downstream files are
  themselves changed seeds. Keep that default; it answers "what remains stale." Use `--proof` for the
  proof/report view: changed fact/source → dependents, with each dependent marked `changed-in-range` or
  `not-changed-in-range`. Do not call `changed-in-range` semantic verification; it proves edit coverage.
  (MED.)
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
- Linter integration → keep it compositional unless a concrete user workflow proves otherwise. true-up
  should not choose or run a project's formatter/linter from `.true-up.json`; docs should show users how
  to chain their existing lint/test command with `true-up gate`, and agents should rerun
  `true-up status --since <ref>` after any formatter/lint fixer rewrites files.
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
- Optional hashlines for proof/audit modes: compute line/window fingerprints with the existing crypto
  stack only when requested (for relocation/proof across parallel worktrees), never as primary graph
  identity and never persisted by default in the graph. Stable IDs remain path/fact/symbol/span/seed.
- mycelium note enrichment (knowledge layer alongside the structural graph).
