# true-up

Deterministic, git-native **truing-up** for any repo: a content-hashed dependency graph that
detects what a change makes stale, regenerates the mechanical, and worklists the advisory — so
docs, data, and code stay in sync without an agent guessing.

## The idea

Change-impact must be **deterministic** — derived from a typed, content-hashed graph, not an LLM
judgment (an LLM-coverage approach is non-deterministic and rots). The CLI does the fast 80%; an
optional agent layer only ever *proposes* minimal prose edits.

- **Directed, causal edges only.** `from` = dependent → `to` = source-of-truth. Direction comes
  from a generator marker, a declared steward, an inline fact-anchor, or a symlink — never from
  correlation (co-change/embeddings can suggest, never assign the arrow).
- **Fact/span granularity, in any language.** Steward JSON files decompose into per-fact nodes; a
  bracketed code region (`true-up:anchor`/`true-up:end` — any language, zero-dep) or a tree-sitter
  symbol (opt-in `"symbols": true`) is a content-hashed fact too — so a dependent is stale only when
  the *specific* fact / region / symbol it cites moves (early-cutoff), not when the file changes.
- **Fail-loud.** A fact-anchor that doesn't resolve is a hard error (stable-ID discipline).
- **Git-native, commit-optional.** The graph is plain JSON derived from tracked sources — no
  service, no DB. The default `out` (`.true-up/depgraph.json`) is gitignored, so it acts as a
  regenerable cache. If you want drift to fail CI, **commit the graph** and gate on
  `--check --committed` (see below); otherwise treat it as a build artifact and use `--check`
  for working-tree freshness.

## Install

```sh
git clone <this-repo> true-up
```

No global install is required. Run it cross-repo by pointing `--repo` at the target:

```sh
node <path-to>/true-up/bin/true-up --repo <target-repo>           # build the target's graph
node <path-to>/true-up/bin/true-up --repo <target-repo> --check   # freshness gate
```

The target repo is resolved as `--repo <path>` | `$TRUE_UP_REPO` | the git toplevel of the
current directory | CWD — so you can also `cd` into the target and run `bin/true-up` with no
`--repo`. If you prefer a bare `true-up` command, `cd true-up && npm link` exposes it on PATH,
but that is optional; `node bin/true-up …` works straight from a clone.

## Quickstart (in any repo)

The examples below use a bare `true-up` (assume the optional `npm link`, or substitute
`node <path-to>/true-up/bin/true-up --repo <target-repo>`).

1. Scaffold a config: `true-up init` writes a starter `.true-up.json` (or copy
   [`examples/true-up.config.json`](examples/true-up.config.json); see
   [docs/CONFIG.md](docs/CONFIG.md)). Declare your steward facts, zones, and seed edges.
2. Build and check:

```sh
true-up                          # build the graph (path from `out`; default .true-up/depgraph.json)
true-up --check                  # exit 1 if the ON-DISK graph is stale (working-tree freshness)
true-up --check --committed      # exit 1 if the COMMITTED/STAGED graph blob is stale (drift gate)
true-up --policy                 # lint content vs declared zone intents; exit 1 on violations
true-up --impact --since HEAD~1  # what a git change made stale (mechanical vs advisory)
true-up run --since HEAD~1       # detect → regenerate mechanical → advisory worklist → verify
```

## Commands

| command | what it does | exit |
|---|---|---|
| `true-up` | build the dependency graph (path from `.true-up.json` `out`; default `.true-up/depgraph.json`) | 0 (1 on unresolved anchor) |
| `--check` | working-tree freshness: is the ON-DISK graph what a fresh build produces? | 1 if stale |
| `--check --committed` | the drift gate: does the COMMITTED (or staged) graph blob match a fresh rebuild? An untracked graph fails. | 1 if stale/untracked |
| `--impact <path\|path#fact>…` | what becomes stale if that path/fact changes | 0 (2 on bad usage/ref) |
| `--impact --since <ref>` | same, auto-detected from `git diff` since `<ref>` | 0 (2 on a bad ref) |
| `run [--since <ref>] [--strict]` | the deterministic loop: detect → regenerate mechanical dependents → print the advisory worklist → verify | 1 if not green; `--strict` exits 2 when advisory review is still pending |
| `--policy [--report]` | lint each file against its declared zone's rules (leaks, visibility, public→private deps, ciphertext) | **1 on violations**; `--report` forces 0 |
| `--externalities [--report]` | machine-local path leaks in public files | **1 on leaks**; `--report` forces 0 |
| `--verify-scope [--since <ref>]` | anti-code-golf gate: every changed file must be explained by the graph | 1 if an edit is out of the blast radius |
| `init` | scaffold a starter `.true-up.json` (refuses to overwrite an existing one) | 0 (1 if one exists) |
| `capabilities` | machine-readable contract: commands, flags, exit-code dictionary (always JSON) | 0 |
| `--version` / `-v` | print the version | 0 |
| `<read-cmd> --json` | structured JSON on stdout for any read-side command (data only; diagnostics on stderr) | as the command |
| `--help` / `-h` / `help` | print this command table; **writes nothing** | 0 |
| `--repo <path>` | operate on a target repo (default: `$TRUE_UP_REPO` \| git toplevel of CWD \| CWD) | — |

`--policy` and `--externalities` are **gates**: they exit 1 when they find something, so they
fail a pre-commit hook or CI step out of the box. Pass `--report` to inspect findings without
failing (report-only, exit 0). An **unknown command** exits 2 and writes nothing — it does
**not** silently build into the target repo.

## Suppressing leak findings in prose

The leak scanners (`--externalities` and the `no-machine-local-paths` / `no-private-operational-leak`
policy rules) ignore anything inside **inline or fenced code** — a doc that *quotes* a forbidden
path shape as an example (a privacy policy, this README) is not a leak. For a path that has to
appear as live prose, opt out per line:

```md
A machine-local path like /home/alice/notes is forbidden.   <!-- true-up:ignore-line -->
<!-- true-up:ignore-next no-machine-local-paths -->
The next line's path example is intentionally left as-is.
```

`ignore-line` suppresses findings on the same line; `ignore-next` suppresses the following line.
An optional rule name (e.g. `no-machine-local-paths`) scopes the suppression to that one rule;
omit it to suppress all rules on that line.

## The truing-up loop today

`true-up run` is **the workflow today**: it detects what changed since a ref, regenerates the
mechanical dependents (running the generators the graph's edges name), prints the advisory
worklist of prose a human or LLM must rewrite, and verifies (policy clean + graph in sync). This
CLI **never edits prose** — the advisory rewrites are left to you. The agentic Claude Code
`/workflow` that would *apply* those rewrites automatically is on the roadmap, not yet built; for
now, "run the workflow" means `true-up run`.

## Code as a source-of-truth

A doc can derive from *code* in any language, fact-granular. Three ways to expose a fact:

1. **JSON stewards** — a JSON file with top-level arrays-of-objects, declared in `facts`.
2. **Span anchors (any language, zero-dep)** — bracket a region with a paired comment token; the
   token rides whatever comment syntax the language already has, so no parser is needed:

   ```python
   # true-up:anchor id=parse_config
   def parse_config(path): ...
   # true-up:end id=parse_config
   ```

   The region's bytes become the fact `parse_config`. A doc anchors to it the usual way:
   `<!-- fact: src/app.py#parse_config -->`.
3. **Symbols (opt-in, tree-sitter)** — set `"symbols": true` in `.true-up.json` to auto-extract
   top-level definitions (Python / Rust / Go / JS / TS / C / C++) as facts named after the symbol —
   no manual markers. This needs the optional `web-tree-sitter` + `tree-sitter-wasms` deps (run
   `npm install` in the true-up tool dir); if `"symbols"` is enabled but they're absent, the build
   **fails loud** (exit 2) rather than silently producing a different, non-deterministic graph.

In all three, **edges stay explicit** — tree-sitter (and span scanning) only produce better *nodes*;
a doc must still anchor (`<!-- fact: … -->`) or be a declared `seed` for an edge to exist. Correlation
never assigns the arrow. A code file is also a valid **seed-edge endpoint** at file granularity
without any of the above.

## Scope and limitations

- **Empty graph is inert.** With no facts, anchors, symbols, or seed edges, the drift layer passes
  `--check` trivially; the build prints a `NOTICE` to that effect. Give it something to track.
- **Symbols are top-level + opt-in.** Tree-sitter extraction lifts module-level definitions (nested
  methods aren't auto-named yet — reach them with a span anchor). It's off unless `"symbols": true`.

## Status

**v0.1.0** — the deterministic engine, fully tested against a synthetic repo (`npm test`).
On the roadmap: the optional Claude Code `/workflow` that *applies* the advisory rewrites,
an installer that wires the git hooks + CI into a target repo, and mycelium note enrichment.
See [AGENTS.md](AGENTS.md) for the architecture and invariants.
