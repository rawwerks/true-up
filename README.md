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
- **Fact/span granularity.** Steward data files decompose into per-fact nodes (content-hashed), so
  a dependent is stale only when the *specific* fact it cites moves (early-cutoff).
- **Fail-loud.** A fact-anchor that doesn't resolve is a hard error (stable-ID discipline).
- **Git is the database.** The graph is a committed JSON file; no service, no DB.

## Install

```sh
git clone <this-repo> true-up
cd true-up && npm link          # exposes the `true-up` command on PATH
```

## Quickstart (in any repo)

1. Add a `.true-up.json` config (see [docs/CONFIG.md](docs/CONFIG.md); start from
   [`examples/true-up.config.json`](examples/true-up.config.json)).
2. Build and check:

```sh
true-up                          # build .true-up/depgraph.json
true-up --check                  # exit 1 if the graph is stale (drift gate)
true-up --policy                 # lint content against declared zone intents
true-up --impact --since HEAD~1  # what a git change made stale (mechanical vs advisory)
true-up run --since HEAD~1       # detect → regenerate mechanical → advisory worklist → verify
```

## Commands

| command | what it does |
|---|---|
| `true-up` | build the dependency graph into `.true-up/depgraph.json` |
| `--check` | exit 1 if the committed graph is stale |
| `--impact <path\|path#fact>` | what becomes stale if that path/fact changes |
| `--impact --since <ref>` | same, auto-detected from `git diff` since `<ref>` |
| `run --since <ref>` | the deterministic loop: detect → regenerate mechanical dependents → print the advisory worklist → verify (exit 1 if not green) |
| `--policy` | lint each file against its declared zone's rules (leaks, visibility, no-read-down) |
| `--externalities` | machine-local path leaks in public files |
| `--repo <path>` | operate on a target repo (default: git toplevel of the current directory) |

## Status

**v0.1.0** — the deterministic engine, fully tested against a synthetic repo (`npm test`).
On the roadmap: the optional Claude Code `/workflow` that applies the advisory rewrites,
an installer that wires the git hooks + CI into a target repo, and mycelium note enrichment.
See [AGENTS.md](AGENTS.md) for the architecture and invariants.
