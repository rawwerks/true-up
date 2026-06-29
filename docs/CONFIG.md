# `.true-up.json` — per-repo configuration

Place `.true-up.json` (or `true-up.config.json`) at the repo root. Everything repo-specific lives
here; the engine itself is generic. All keys are optional. An absent config is fine (defaults apply);
a present-but-malformed config — unparseable JSON, a wrong-typed `facts`/`zones`/`seed`/`out`, or an
`out` path that escapes the repo — is a hard error and exits 2 (`invalid-config`).

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
  "imports": {
    "payments": { "path": "imports/payments.public.true-up-import.json", "repoId": "payments-service", "audience": "public" }
  },
  "exports": [
    { "id": "api.timeout", "from": "data/verdicts.json#frameworks.ax", "audience": "public" }
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

A content-hashed **fact node** (the unit that gives early-cutoff) comes from one of three sources:

1. **JSON stewards** (`facts`). The engine `JSON.parse`s the steward file and, for each
   `[arrayProp, keyField]`, reads `data[arrayProp]`; if that is not an array it is skipped, and each
   element must carry the `keyField` to become the fact `path#arrayProp.key`. A file that doesn't
   parse as JSON yields no facts.
2. **Span anchors** — a bracketed region of *any* file, zero-dep (see "Conventions" below). The fact
   is `path#id`.
3. **Symbols** — opt-in `"symbols": true`; tree-sitter definitions, the fact is `path#SymbolName`.

So **code IS a valid fact-granular source-of-truth** (via #2 or #3), not just a coarse endpoint. A
code file is *also* a valid `seed`-edge endpoint at file granularity (a declared edge to a tracked
code file gets a minimal node so the edge isn't dropped) — use that when you want a whole file
tracked rather than a specific region/symbol. When the graph has no dependency **edges** (a `seed`
edge, a resolved inline `<!-- fact: -->` anchor, or a generated-by/symlink marker), build prints a
NOTICE that the drift-detection layer is inert (`--check` passes trivially) — note that declaring
facts/anchors/symbols only mints *nodes*; you still need an *edge* for the drift layer to be live.

## `symbols` — tree-sitter symbol extraction (opt-in)

Set `"symbols": true` to auto-extract top-level code definitions as fact nodes via tree-sitter — so a
doc can anchor to a function/class/struct by name (`<!-- fact: src/app.py#parse_config -->`) with no
manual markers. Supported: Python, Rust, Go, JavaScript, TypeScript, C, C++. Each symbol's hash is its
source-span bytes, so a dependent stales only when *that symbol* changes (symbol-granular
early-cutoff); an explicit span anchor of the same `id` wins over a symbol of the same name.

This is the only feature with a dependency: it needs the **optional** `web-tree-sitter` +
`tree-sitter-wasms` packages (exact-pinned; run `npm install` / `bun install` in the true-up tool
directory). The zero-dep core never loads tree-sitter. Because the symbol set is part of the graph,
the switch lives in tracked config (not a transient flag) so the graph stays reproducible — and if
`"symbols"` is enabled but the deps are absent, the build **fails loud (exit 2)** rather than silently
producing a different, environment-dependent graph. Prefer span anchors (zero-dep) when you only need
a handful of regions tracked; use `"symbols"` to blanket-track a whole code tree.

## `strictSpans` — make malformed span anchors fatal (opt-in)

By default a malformed span anchor (an unclosed `true-up:anchor`, a duplicate id) is **ignored** — a
span nothing depends on is harmless, and a doc that *does* anchor to a missing span still fails loud
(unresolved-anchor). That keeps a file free to *document* the token without self-tripping. Set
`"strictSpans": true` to make any malformed span a **fatal** build/`--check` error (exit 1) instead —
use it in a CI gate so a typo can't silently drop a span you meant to track.

## Hashing model (what is normalized before hashing)

Content hashes are `sha256` (16 hex chars). Only **JSON facts are normalized** — the array element is
serialized with **sorted keys** so the hash is order-independent within an object. Everything else is
hashed as **raw bytes**:

- **JSON fact** — key-sorted JSON of the array element.
- **span fact** — raw bytes strictly *between* the `true-up:anchor`/`true-up:end` markers (markers excluded).
- **symbol fact** — raw bytes of the symbol's source span (tree-sitter).
- **generated block** — raw bytes of the captured block body.
- **file node** — raw file content.

So don't over-claim cross-tool byte-identity: it holds for key-sorted JSON facts, but span/symbol/block
hashes are raw-byte and depend on exact formatting (and, for symbols, the pinned grammar version).

## `zones` — visibility + intent + rules

Each zone matches a path prefix (most-specific wins: exact > `**/suffix` > `dir/` > `""` catch-all)
and declares `visibility` (`public` < `internal` < `private` < `secret`), `audience`, an `intent`
label, and `rules`. `visibility` is the enforced lattice and must use one of those four values.
`audience` is native graph metadata but repo-defined: any string is valid, so use values that make
sense for your project (`external-users`, `external-agents`, `maintainer-agents`, `release-agents`,
etc.). true-up does not impose an audience enum; it validates the value is a string and carries it
onto matching `file:` nodes.
Use this for document audiences too, not just security boundaries: this repo declares `README.md` as
the external user/agent overview, `SKILL.md` as the external-agent skill, `AGENTS.md` as maintainer
agent notes, `PUBLISHING.md` as the release-agent handoff, and `docs/CONFIG.md` as the adopter/config
reference. Those values are stamped onto graph file nodes and show up in `true-up graph --json`.
Mechanical rules enforced by `--policy`:

- `no-machine-local-paths` — no `/home/<user>`, `/Users/<user>`, or non-canonical `~/` paths
  (canonical `~/.claude`, `~/.config`, `~/.cache` are allowlisted).
- `must-be-ciphertext` — every file in the zone must be encrypted (no plaintext).
- `no-public->private-deps` — no dependency edge from a public node into a private path (no-read-down).
- `no-public->nonpublic-import` — no public local file may depend on an imported fact exported above
  public visibility.

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

### Using true-up with an existing linter

Keep ordinary linting and formatting in the tool that already owns it; true-up does not configure or
run a project linter from `.true-up.json`. Compose them at the shell, hook, or CI layer with whatever
commands the repo already uses:

```sh
./scripts/lint
true-up gate
```

```sh
ruff check .
markdownlint README.md docs
true-up gate
```

Run the formatter/linter first when it may rewrite files, then run `true-up status --since <ref>` or
`true-up gate` so the graph reflects the final file contents. `--policy` and `--externalities` are
true-up-specific visibility/leak checks; they are intentionally narrower than a general linter.

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
# true-up:ignore-file true-up-markers suppresses marker/span extraction for this file only
```

The optional line-level `[rule]` (e.g. `no-machine-local-paths` or `no-private-operational-leak`) scopes
the suppression to that one rule; omit it to suppress all rules on that line. Prefer code formatting
over a directive where you can — reserve the directive for prose that genuinely needs the bare path.
For test fixtures or docs generators that quote true-up marker syntax in source files, use
`true-up:ignore-file true-up-markers`; the file remains a normal graph node, but marker/span extraction
does not treat the quoted fixture strings as live dependencies. File-level suppression is intentionally
restricted to marker extraction; it cannot turn off leak/policy scanners for a whole public file.

## `seed` — declared edges (the marker-free path)

Directed edges declared in config, so your content stays pristine — **no inline markers**:
`{ from: <dependent>, to: <source-of-truth>, kind: "derives-facts-from" }`.

- **File-granular** — `to` is a file path; the dependent stales when that whole file changes.
- **Fact-granular (marker-free)** — `to` is `path#fact`; the dependent stales only when **that fact**
  moves (early-cutoff), with **no `<!-- fact: -->` marker in the dependent**. The `fact` is addressed
  exactly as the engine mints fact ids: a JSON `arrayProp.key` (steward), a span `id`
  (`true-up:anchor`), or a tree-sitter `Symbol` name (`"symbols": true`). Examples:
  `{ "from": "README.md", "to": "data/verdicts.json#frameworks.ax" }` ·
  `{ "from": "guide.md", "to": "src/app.py#parse_config" }`.
- **Mechanical generated (marker-free)** — use `kind: "generated-from"` plus required `via` to model a generated
  artifact without a content marker: `{ "from": "meta/contract.json", "to": "lib/engine.mjs",
  "kind": "generated-from", "via": "meta/build-contract.mjs" }`. `true-up run` executes each distinct
  tracked in-repo `via` for stale mechanical dependents; `run --no-write` only reports what would run.
  Use `true-up --impact <source>` when you need the complete file-level blast radius: it lists every
  generated dependent, even when many outputs share the same `via`. JS generators run with Node,
  shell/Python/Ruby/Perl generators run by extension, and extensionless shebang tools execute directly.
- **Imported fact (one-way mirror)** — `to` can be `@alias:fact` when `imports.alias` points at a
  tracked/staged regular in-repo snapshot. Imported targets are advisory, even if the snapshot says the
  source was generated, so `run` never executes generator metadata that crossed a repo boundary.

A `seed` whose `from`/`to` does not resolve (untracked file, or a fact that doesn't exist) is a **hard
error** — fail-loud parity with inline anchors, never a silently-dropped edge. Inline `<!-- fact: -->`
anchors remain available for authors who prefer a co-located, greppable citation that travels with the
prose; both forms resolve to the identical edge. Neither survives a source rename automatically — the
sidecar's edge is just an auditable one-line `.true-up.json` diff a reviewer signs off.

`seed` is also how to model prose dependencies no parser can infer. In this repo, `README.md` derives
its config summary from `docs/CONFIG.md`, `SKILL.md` derives from both, `AGENTS.md` derives from the
user/agent docs and maintainer surfaces it summarizes, and `PUBLISHING.md` derives from package,
changelog, local-CI, and workflow surfaces. That is deliberate graph data: `true-up --impact
docs/CONFIG.md` names the downstream documents that need review, and `true-up graph --json` shows the
audience and dependency map.

## `repoId`, `exports`, and `imports` — inter-repo one-way mirrors

Inter-repo dependencies are explicit snapshots, not live reads of another checkout. A source repo sets
a stable `repoId` and an `exports` allowlist:

```json
{
  "repoId": "payments-service",
  "facts": { "secret/internal.json": [["items", "id"]] },
  "exports": [
    { "id": "api.timeout", "from": "secret/internal.json#items.timeout", "audience": "public", "declassify": true },
    { "id": "internal.discount", "from": "secret/internal.json#items.discount", "audience": "internal", "declassify": true }
  ]
}
```

Then it emits a path-minimized snapshot for a chosen audience:

```sh
true-up export --audience public > exports/payments.public.true-up-import.json
```

If an export crosses from private/internal/secret source material to a lower audience, the exact export
entry must include `"declassify": true`; otherwise `true-up export` fails. The source controls the
public/private boundary and does not need to know every downstream consumer. A consumer opts in by
tracking/staging or committing the snapshot as a regular file and pinning the identity/audience it
agreed to mirror:

```json
{
  "imports": {
    "payments": {
      "path": "imports/payments.public.true-up-import.json",
      "repoId": "payments-service",
      "audience": "public"
    }
  },
  "seed": [{ "from": "README.md", "to": "@payments:api.timeout" }]
}
```

Import aliases are namespaces, not paths: they cannot contain traversal or separators. Import paths
must resolve inside the repo, be tracked/staged, and be regular files rather than symlinks, so gates
never silently read a sibling repo. Snapshot facts carry hashes and audience metadata, not raw source
paths. Public snapshots are schema-strict: commit ids, raw values, source paths, and arbitrary taint
fields are rejected instead of re-emitted into the graph. Non-public imports taint downstream local
artifacts; `true-up export --audience public` refuses to re-export an artifact derived from an
internal/private/secret import. Public snapshots omit source commit ids.

## `out` — graph path + the commit-optional model

`out` is the path (relative to the repo root) where the graph JSON is written; it defaults to
`.true-up/depgraph.json`. Plain `true-up` (re)writes it; `--impact` and `run` read it.

**Committing the graph is optional.** Two freshness checks exist for the two stances:

- `--check` — **working-tree freshness.** Exits 1 if the on-disk graph isn't byte-identical to a
  fresh rebuild. This is all you need if you don't track the graph (the default `.gitignore` may
  exclude `.true-up/`); regenerate it locally before relying on `--impact`/`run`.
- `--check --committed` — **the drift gate** for repos that *do* commit the graph. It compares a
  fresh rebuild to the **VCS-stored** graph blob. In Git repos, the staged `:<out>` blob is preferred
  (pre-commit), then `HEAD:<out>` (CI). In jj-only repos, it reads `@`. It exits 1 if they differ or if
  the graph is absent from that VCS view. Wire this into pre-commit/CI to catch "source changed without
  the regenerated graph."

If you choose to commit/track the graph, make sure `out` is **not** ignored so the VCS blob exists for
`--check --committed` to compare against. Explicitly setting `"out": ".true-up/depgraph.json"` is
compatible with committing that generated graph; true-up still refuses tracked content paths outside
the generated graph area.

## `init` — scaffold a starter config

`true-up init` writes a starter `.true-up.json` at the repo root (empty `facts`, a private/
SKILL.md/README.md/catch-all `zones` set, empty `seed`, and the default `out`), then exits 0. It is
idempotent: re-running on an existing config leaves it untouched and still exits 0 ("already
scaffolded" is success; exit 1 is reserved for gate violations). Edit the scaffold to declare your
repo's stewards, zones, and seed edges, then run `true-up`.

## Conventions the engine reads from content (no config needed)

- **Generated block:** `<!-- generated by <generator> from <source> -->` → a `generated-from` edge
  (mechanical). The named `<generator>` is what `run` re-executes to regenerate it.
- **Fact anchor:** `<!-- fact: <path>#<key> -->` inside a doc → a fact-level `derives-facts-from`
  edge (advisory). `<key>` is a JSON `arrayProp.key`, a span-anchor `id`, or a symbol name. An anchor
  that doesn't resolve to a known fact node is a hard error (stable-ID discipline).
- **Span anchor (any language):** bracket a region of any tracked file with a paired comment token —
  `# true-up:anchor id=NAME` … `# true-up:end` (or `//`-style, or `<!-- … -->`). The lines strictly
  between the markers are content-hashed into the fact `<path>#NAME`; the token is matched bare so it
  rides any comment syntax (no parser). A bare `true-up:end` closes the most-recent open; examples
  inside markdown code fences are inert. A malformed/unclosed anchor is ignored — the backstop is the
  fact-anchor hard error above if a doc actually depends on it.
- **Symlink:** a symlink → an `alias-of` edge to its target (mechanical; same bytes).
