# `.true-up.json` — per-repo configuration

Place `.true-up.json` (or `true-up.config.json`) at the repo root. Everything repo-specific lives
here; the engine itself is generic. All keys are optional.

```json
{
  "facts": {
    "data/verdicts.json": [["frameworks", "key"]]
  },
  "zones": [
    { "path": "private/", "visibility": "private", "audience": "team", "intent": "encrypted-notes", "rules": ["must-be-ciphertext"] },
    { "path": "", "visibility": "public", "audience": "world", "intent": "public-default", "rules": ["no-machine-local-paths"] }
  ],
  "seed": [
    { "from": "README.md", "to": "data/verdicts.json", "kind": "derives-facts-from" }
  ],
  "out": ".true-up/depgraph.json"
}
```

## `facts` — steward decomposition

`path -> [[arrayProp, keyField], ...]`. The engine decomposes a source-of-truth JSON into one
content-hashed **fact node** per array element, keyed `fact:<path>#<arrayProp>.<key>`. This is what
gives **early-cutoff**: a dependent anchored to `fact:data/verdicts.json#frameworks.ax` is stale
only when *that framework's* entry changes, not when any other part of the file moves.

### Fact-model scope (the boundary)

Fact decomposition only applies to **JSON files whose declared `arrayProp` is a top-level
array-of-objects**. The engine `JSON.parse`s the steward file and, for each `[arrayProp, keyField]`,
reads `data[arrayProp]`; if that is not an array it is skipped, and each array element must carry the
`keyField` to become a fact (elements missing it are skipped). A file that doesn't parse as JSON
yields no facts.

**Code files (`.py`, `.ts`, `.rs`, …) are never auto-decomposed into facts.** They are still valid
**`seed`-edge endpoints**: a declared edge whose `from`/`to` is a tracked code file gets a minimal
file-level node so the coarse advisory edge is not silently dropped — but the engine does not crack
open source to extract per-symbol facts. If your source-of-truth lives in code, model the
dependency at file granularity via `seed`; fact-level early-cutoff is JSON-only. (When you declare
no `facts` at all, build prints a NOTICE that the drift-detection layer is inert — `--check` passes
trivially — to distinguish "nothing changed" from "nothing declared to track".)

## `zones` — visibility + intent + rules

Each zone matches a path prefix (most-specific wins: exact > `**/suffix` > `dir/` > `""` catch-all)
and declares `visibility` (public < private < secret), `audience`, an `intent` label, and `rules`.
Mechanical rules enforced by `--policy`:

- `no-machine-local-paths` — no `/home/<user>`, `/Users/<user>`, or non-canonical `~/` paths
  (canonical `~/.claude`, `~/.config`, `~/.cache` are allowlisted).
- `must-be-ciphertext` — every file in the zone must be encrypted (no plaintext).
- `no-public->private-deps` — no dependency edge from a public node into a private path (no-read-down).

`no-private-operational-leak` (raw credential-file paths, private adapter class names, raw backend
endpoints) is enforced on **every** non-private file regardless of per-zone opt-in, so a new public
file is auto-covered. Any rule a zone declares that isn't one of the mechanical rules above is
treated as **advisory** — `--policy` lists it as "declared, not auto-enforced (manual/LLM review)"
rather than gating on it.

### Exit codes

`--policy` and `--externalities` **exit 1** when they find violations/leaks (exit 0 when clean), so
they gate a pre-commit hook or CI directly. Pass **`--report`** to force **exit 0** regardless —
the same findings are still printed, but the command is report-only (use it to survey the surface
without failing the build). `--externalities` is the standalone `no-machine-local-paths` scan over
public files.

### Suppressing a legitimate path example

The leak detectors (`--externalities` machine-local scan and the `--policy`
`no-private-operational-leak`/`no-machine-local-paths` checks) run against **code-stripped**
content: a forbidden path shape shown inside an inline `` `code span` `` or a fenced ``` block ```
(e.g. a privacy policy quoting a path shape, or a doc demonstrating a marker) is **not** flagged.
For a path example in plain prose that must stay literal, opt that line out with a directive checked
against the original (un-stripped) line text:

```
<!-- true-up:ignore-line [rule] -->   suppresses findings on THIS line
<!-- true-up:ignore-next [rule] -->   suppresses findings on the NEXT line
```

The optional `[rule]` (e.g. `no-machine-local-paths` or `no-private-operational-leak`) scopes the
suppression to that one rule; omit it to suppress all rules on that line. Prefer code formatting
over a directive where you can — reserve the directive for prose that genuinely needs the bare path.

## `seed` — declared edges

Directed edges the engine can't infer: `{ from: dependent, to: source-of-truth, kind: "derives-facts-from" }`.
Prefer promoting these to inline fact-anchors (`<!-- fact: path#fact -->`) over time — that upgrades
a file-level *advisory* edge to a fact-level one (early-cutoff).

## `out` — graph path + the commit-optional model

`out` is the path (relative to the repo root) where the graph JSON is written; it defaults to
`.true-up/depgraph.json`. Plain `true-up` (re)writes it; `--impact` and `run` read it.

**Committing the graph is optional.** Two freshness checks exist for the two stances:

- `--check` — **working-tree freshness.** Exits 1 if the on-disk graph isn't byte-identical to a
  fresh rebuild. This is all you need if you don't track the graph (the default `.gitignore` may
  exclude `.true-up/`); regenerate it locally before relying on `--impact`/`run`.
- `--check --committed` — **the drift gate** for repos that *do* commit the graph. It compares a
  fresh rebuild to the **committed-or-staged** graph blob (staged `:<out>` preferred, else
  `HEAD:<out>`), and exits 1 if they differ. It also exits 1 if the graph is **untracked** (an
  untracked graph would otherwise give false assurance). Wire this into pre-commit/CI to catch
  "committed a source change without re-staging the regenerated graph."

If you choose to commit the graph, make sure `out` is **not** gitignored so the staged/HEAD blob
exists for `--check --committed` to compare against.

## `init` — scaffold a starter config

`true-up init` writes a starter `.true-up.json` at the repo root (empty `facts`, a private/
SKILL.md/README.md/catch-all `zones` set, empty `seed`, and the default `out`), then exits 0. It
refuses to overwrite an existing config (exit 1). Edit the scaffold to declare your repo's stewards,
zones, and seed edges, then run `true-up`.

## Conventions the engine reads from content (no config needed)

- **Generated block:** `<!-- generated by <generator> from <source> -->` → a `generated-from` edge
  (mechanical). The named `<generator>` is what `run` re-executes to regenerate it.
- **Fact anchor:** `<!-- fact: <path>#<arrayProp>.<key> -->` inside a doc → a fact-level
  `derives-facts-from` edge (advisory). An anchor that doesn't resolve is a hard error.
- **Symlink:** a symlink → an `alias-of` edge to its target (mechanical; same bytes).
