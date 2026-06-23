<div align="center">

# true-up

**Keep your docs, data, and code in sync — deterministically.**

true-up builds a content-hashed dependency graph of your repo, then tells you exactly what a change
made stale, regenerates the mechanical parts, and hands you a short list of the prose to review. No
LLM guessing. No service. No database.

[![npm](https://img.shields.io/npm/v/true-up)](https://www.npmjs.com/package/true-up)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/true-up)](https://nodejs.org)

```sh
npm i -g true-up      # then, in your repo:  true-up init && true-up status
```

</div>

---

## The problem

You change a function, a config value, or a data file — and three docs, a README table, and a
generated file silently fall out of date. Nothing tells you. Reviewers don't catch it. The drift
ships.

The usual "fixes" don't hold:

| Approach | Why it falls short |
|---|---|
| "Remember to update the docs" | Humans forget; nothing enforces it. |
| Ask an LLM "is this still accurate?" | Non-deterministic, can't gate CI on it, costs tokens, drifts over time. |
| A linter / formatter | Checks one file in isolation; it doesn't know doc X depends on code Y. |

## The solution

`true-up` makes the dependencies **explicit and content-hashed**, so "what's stale?" is a graph
query, not a judgment call:

```sh
true-up status              # one call: target workspace, stale work, and what to run next
true-up run --since HEAD~1  # Git base; use --since @- in jj-only repos
true-up gate               # CI/pre-commit: exit 1 if anything is stale or leaks — deterministic
```

Same inputs → same answer, every time. The CLI does the fast, certain 80%; you (or an agent) only
ever review the small list of prose it can't safely rewrite.

## Why true-up

| | |
|---|---|
| 🎯 **Deterministic** | Impact comes from a content-hashed graph + your VCS — never an LLM. Reproducible across machines and CI. |
| 🔒 **Read-only** | It never modifies, creates, or deletes your content. Its only writes are its own graph cache and (opt-in, Git-backed) hooks. |
| 🧬 **Git/jj-native** | The graph is plain JSON derived from tracked files. No server, no database, commit-optional. |
| 🌍 **Any language** | Mark a source-of-truth with a comment anchor (works in any language), or auto-extract code symbols with tree-sitter. |
| 🪶 **Lean** | The core is zero-dependency; `npx true-up` stays small (tree-sitter is an optional add-on). |
| 🤖 **Agent-ready** | `--json` on every command (uniform `ok` + `_v`), a one-call `status` that reports the active workspace, and an in-tool `robot-docs` handbook. |

---

## Install

It's a two-step adoption: **(1) get the `true-up` command, then (2) set it up inside a repo.**

### 1. Get the tool — pick one

```sh
npm i -g true-up                 # global CLI → `true-up` on your PATH everywhere
npx true-up@latest <command>     # zero-install, run on demand (e.g. npx true-up status)
npm i -D true-up                 # pin it inside one project (run via `npx true-up` or an npm script)
```

Or with no npm at all (puts a `true-up` launcher on your PATH; needs Node ≥ 18):

```sh
curl -fsSL https://raw.githubusercontent.com/rawwerks/true-up/main/install.sh | bash
```

> The core is zero-dependency. To auto-extract code **symbols** with tree-sitter (optional), also:
> `npm i web-tree-sitter@0.24.7 tree-sitter-wasms@0.1.13` — or pass `--with-symbols` to the installer.

### 2. Adopt it in a repo

A global install gives you the command; this step is what actually wires it into a project:

```sh
cd your-repo
true-up init       # scaffold .true-up.json — declare your sources of truth + their dependents
true-up build      # build the dependency graph (.true-up/depgraph.json)
true-up graph      # inspect nodes, audiences, and edges without writing
true-up status     # see what's tracked and whether anything is stale
true-up gate       # the check to run in CI / pre-commit
```

---

## Quick start

```sh
$ cd your-repo
$ true-up init
wrote .true-up.json — declare facts/zones/seed for your repo, then run: true-up

# ...declare a dependency in .true-up.json (a doc that derives from a data file), then:
$ true-up build
.true-up/depgraph.json written: 12 nodes (4 fact-nodes), 5 edges

# change a tracked source, then ask where you stand — one call:
$ true-up status
true-up status (.) — read-only orientation

  target:   /repo
  selected: cwd
  cwd:      .
  vcs:      git · default since HEAD~1
  graph:    12 nodes, 5 edges
  built:    yes, in sync
  changed:  since HEAD~1 → 1 mechanical / 1 advisory dependent(s)
              advisory: docs/api.md  ←  config.json#routes.timeout
  policy:   clean · externalities: clean
  verdict:  work pending ↓

  next:
    true-up run --since HEAD~1   # regenerate 1 mechanical dependent(s)
    true-up --impact --since HEAD~1 --proof --json   # review 1 advisory dependent(s)
```

`true-up run` regenerates the **mechanical** dependents (e.g. generated files) and prints the
**advisory** ones (prose for you to rewrite — true-up never edits your prose). `true-up gate`
turns the whole thing into a single pass/fail for CI.

---

## Commands

Every read-side command also accepts `--json` (data on stdout, diagnostics on stderr) and reports a
uniform `ok` boolean.

| command | what it does | exit |
|---|---|---|
| `true-up status` | read-only orientation in one call: target workspace, built? stale? what changed + what to run next | 0 as a probe; 2 for usage errors such as a bad `--since` ref |
| `true-up graph [--json]` | read-only graph dump: nodes, audiences/zones, edges, propagation, generator `via` | 0 (1 on graph errors; 2 on usage/config errors) |
| `true-up build` (or bare `true-up`) | build the dependency graph (`out`, default `.true-up/depgraph.json`) | 0 (1 on an unresolved anchor; 2 on ill-typed config) |
| `true-up --check [--committed]` | is the graph stale? `--committed` checks the VCS-stored graph (Git: staged/HEAD; jj-only: `@`) | 1 if stale |
| `true-up --impact <path\|path#fact>… [--since <ref>] [--proof]` | what becomes stale if that path/fact changes; `--proof` audits changed facts whose dependents were already edited in-range | 0 (2 on unknown target / bad ref) |
| `true-up run [--since <ref>] [--strict]` | the loop: detect → regenerate mechanical deps → list advisory prose → verify | 1 if not green (2 under `--strict` when advisory review is pending) |
| `true-up gate [--committed]` | one CI/pre-commit stage: `--check` + `--policy` + `--externalities` | **1 if any sub-check fails** |
| `true-up hooks [--install\|--uninstall\|--ci] [--force]` | wire (or remove) Git hooks in a Git-backed repo, or print a CI snippet | 0 (2 if no Git hooks dir) |
| `true-up --policy [--report]` | lint files against their declared zone rules (path leaks, visibility) | **1 on violations** (`--report` → 0) |
| `true-up --externalities [--report]` | scan public files for machine-local path leaks (`/home/you/…`) | **1 on leaks** (`--report` → 0) |
| `true-up --verify-scope [--since <ref>]` | guard: every changed file must be explained by the graph | 1 if an edit is out of scope |
| `true-up init` | scaffold a starter `.true-up.json` (idempotent — never overwrites) | 0 |
| `true-up capabilities` | machine-readable contract (commands, flags, exit codes) — always JSON | 0 |
| `true-up robot-docs` | a paste-ready, in-tool handbook for AI agents | 0 |
| `true-up --version` · `--help` | version · command table (writes nothing) | 0 |

**Global flags:** `--repo <path>` (operate on another repo — defaults to `$TRUE_UP_REPO`, then the
Git/jj toplevel of your CWD; `status --json` reports the resolved `.workspace.root` and warns if your
shell CWD points at a different repo), `--json` (structured output), `--no-write` (compute in memory,
persist nothing).

Exit codes are a documented dictionary: **0** = ok/clean, **1** = a gate failed (stale / leak /
not-green), **2** = usage error (unknown command, bad ref, not a Git/jj repo, bad config). Errors name
the exact command to run instead.

---

## Configure it: `.true-up.json`

`true-up init` writes a starter. You declare three things (full reference:
[docs/CONFIG.md](docs/CONFIG.md), example: [examples/true-up.config.json](examples/true-up.config.json)):

```jsonc
{
  // 1. FACTS — point at a JSON file's array-of-objects; each element becomes a tracked fact.
  //    Here config.json is:  { "routes": [ { "name": "timeout", "ms": 30000 }, … ] }
  //    → mints one fact per route, keyed by "name":  config.json#routes.timeout, …
  "facts": { "config.json": [["routes", "name"]] },

  // 2. SEED — declare a dependency in config, without adding comments to your files:
  //    docs/api.md derives from that one fact, so it's flagged stale only when THAT route changes.
  //    (Use "to": "config.json" for a whole-file edge if you don't need fact-granularity.)
  "seed": [ { "from": "docs/api.md", "to": "config.json#routes.timeout" } ],

  // 3. ZONES — optional: visibility / leak rules per path.
  "zones": [ { "path": "", "visibility": "public", "rules": ["no-machine-local-paths"] } ]
}
```

## Make code a source of truth

A doc can depend on **code**, fact-by-fact, in any language — two ways to expose the fact:

**Comment anchors** (any language, no dependencies) — bracket a region; the token rides whatever
comment syntax the language already uses:

```python
# true-up:anchor id=parse_config
def parse_config(path): ...
# true-up:end
```

**Symbols** (optional, tree-sitter) — set `"symbols": true` and true-up auto-extracts top-level
definitions (Python / Rust / Go / JS / TS / C / C++) as facts named after the symbol — no manual
markers.

Either way, a doc **cites** the fact to create the dependency — inline (`<!-- fact: src/app.py#parse_config -->`)
or in config via a marker-free `seed` entry:
`{ "from": "docs/api.md", "to": "src/app.py#parse_config", "kind": "derives-facts-from" }`.
The edge is always explicit; true-up never guesses a dependency from co-occurrence.

## Use it in CI / pre-commit

```sh
true-up hooks --install     # adds a pre-commit + pre-push gate to this repo
true-up hooks --ci          # prints a ready-to-paste GitHub Actions snippet (version-pinned)
```

`true-up gate` is the single command to run in a pipeline — it exits non-zero if the graph is stale
or a policy/leak check fails, so a runner can key on the exit code.

## For AI agents

true-up is built to be driven by coding agents:

- **`true-up status --json`** — one call returns `{ workspace, built, stale, impact, policy, externalities, gateGreen, green, nextCommands[] }`.
  In multi-worktree or jj runs, inspect `workspace.root`, `workspace.repoSource`, `workspace.git.linkedWorktree`,
  `workspace.vcs`, and `workspace.warnings` before acting. When status was pointed at a non-CWD target,
  `nextCommands[]` are repo-qualified with `--repo <root>` so another pane does not accidentally run
  them against its own CWD.
  `ok` means the probe ran; `gateGreen` means cache/policy/leak gates are clean; `green` means no truing-up work remains.
- **`true-up robot-docs`** — a paste-ready handbook (task → command), in-tool, no external doc lookup.
- **`true-up --impact --since HEAD --proof --json`** — audit a completed pass: changed facts, their dependents, and whether each dependent was changed in the same range or satisfied by a live symlink alias.
- **`true-up capabilities`** — the full machine contract (commands, flags, exit codes, `quickstart`).
- Every read-side command: `--json` with a uniform `ok` + `_v`; errors emit `{ok:false, …}` and a
  `did you mean` suggestion (e.g. `true-up update` → "did you mean: run").

## How true-up uses itself

This repo is the reference case study: true-up trues up true-up without inline dependency markers.
The engine's command and agent-guidance surface is generated into [meta/contract.json](meta/contract.json)
by [meta/build-contract.mjs](https://github.com/rawwerks/true-up/blob/main/meta/build-contract.mjs).
Then [.true-up.json](https://github.com/rawwerks/true-up/blob/main/.true-up.json) declares
which documents derive from those facts and from one another:

- `README.md` is the external user/agent overview and derives from every command fact, the
  agent-guidance fact, the config reference, installer, package manifest, and workflow overview.
- `SKILL.md` is the loadable external-agent skill and derives from `README.md`, `docs/CONFIG.md`,
  `.true-up.json`, the workflow overview, and the generated contract.
- `AGENTS.md` is for maintainer agents and derives from the external docs plus the engine, harness,
  release, workflow, and local-CI surfaces it summarizes.
- `PUBLISHING.md` is for credentialed release agents and derives from package metadata, lockfile,
  changelog, installer, and the local CI trust anchor.
- `docs/CONFIG.md` is the adopter/config reference and derives from the engine behavior,
  configuration examples, `.true-up.json`, `.gitignore`, and the agent-guidance contract fact it teaches.

Useful probes:

```sh
true-up --impact meta/contract.json#agent_guidance.declared-seed-edge
true-up --impact docs/CONFIG.md
true-up graph --json
```

## How it fits together

```
   your repo (tracked files)
     │   sources of truth:  JSON facts  ·  comment anchors  ·  tree-sitter symbols
     ▼
   true-up build ──►  .true-up/depgraph.json   (content-hashed, directed graph)
     │
     ├─ true-up --impact <path>     who depends on this? (full dependent list)
     ├─ true-up run --since <ref>   regenerate mechanical deps · list prose to review
     └─ true-up gate                --check + --policy + --externalities → 0/1 for CI
```

---

## Limitations

- **It tracks what you declare.** With no facts, anchors, symbols, or seed edges, the graph is empty
  and `--check` passes trivially (the build prints a NOTICE). You get out what you put in.
- **Advisory rewrites are yours.** true-up regenerates *mechanical* dependents (generated files) and
  *lists* the prose that needs review — it never rewrites your prose.
- **Symbols are top-level + opt-in.** Tree-sitter extraction lifts module-level definitions; reach a
  nested method with a comment anchor instead.
- **Dependencies are explicit by design.** true-up won't invent an edge from co-change or embeddings —
  you declare it (in config or with an anchor). That's what makes it deterministic.

## FAQ

**Does it edit my files?** No. It only ever writes its own graph cache (`.true-up/` — add it to your
`.gitignore` if you treat the graph as a regenerable cache), `.true-up.json` on `init` (never
overwriting), and Git hooks if you opt in. `run` executes only the generators *you* declare;
`--no-write` persists nothing at all.

**Do I have to commit the graph?** No. By default it's a regenerable cache and `--check` verifies
working-tree freshness. If you want CI to fail on drift, commit or track the graph and use
`--check --committed`; tracked generated graph paths under `.true-up/` are allowed.

**Does it need an LLM or network?** No. It's deterministic and offline — just Git or jj + Node.

**What languages?** Comment anchors and JSON facts work everywhere. Tree-sitter symbol extraction
covers Python, Rust, Go, JS, TS, C, and C++ (opt-in).

**How is this different from a linter?** A linter checks a file in isolation. true-up tracks
*cross-file* dependencies — it knows `docs/api.md` derives from `config.json#routes.timeout` and flags
the doc when that specific fact changes. Use them together: keep your formatter/linter configured in
its own tool, then chain it with true-up in hooks or CI. For example, if these are already your repo's
lint commands:

```sh
./scripts/lint && true-up gate
ruff check . && markdownlint README.md docs && true-up gate
```

If a formatter or lint fixer rewrites files, run `true-up status --since <ref>` again afterward. The
`--policy` and `--externalities` commands are true-up's own visibility/leak checks, not a replacement
for your project's normal linter.

**Is tree-sitter required?** No — it's an optional add-on for symbol extraction. The core and comment
anchors are zero-dependency.

**A leak finding is a false positive — how do I allow it?** Leak scans already ignore anything inside
inline or fenced code, so quoting a path as an example is fine. For a path that must appear as live
prose, add `<!-- true-up:ignore-line -->` to that line (or `<!-- true-up:ignore-next -->` to the line
above it). An optional rule name scopes it: `<!-- true-up:ignore-line no-machine-local-paths -->`.

---

## About Contributions

Please don't take this the wrong way, but I do not accept outside contributions for any of my
projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing,
so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my
perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly
make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a
proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review
submissions via `gh` and independently decide whether and how to address them. Bug reports in
particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I
understand this isn't in sync with the prevailing open-source ethos that seeks community
contributions, but it's the only way I can move at this velocity and keep my sanity.

## License

MIT © 2026 Raymond Weitekamp. See [LICENSE](LICENSE).

---

*Maintainer / architecture notes live in [AGENTS.md](https://github.com/rawwerks/true-up/blob/main/AGENTS.md).
Running true-up inside your own agent? See [SKILL.md](SKILL.md).*
