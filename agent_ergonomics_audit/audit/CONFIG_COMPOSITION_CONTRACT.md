# Native config composition contract and verification plan

Status: **Waves 1 and 2 complete**. The zero-dependency loader passes its 48-case source gate and is wired once through every
config-consuming command. The focused integration gates pass 9 real-CLI/version-skew/scale cases and 16
Git/jj/worktree cases, including both committed-check race windows, hidden index flags, CRLF,
repository clean-filter non-execution, linked-worktree isolation, and frozen v0.1.4/pre-composition
fail-closed compatibility. Wave 1's independent report is SHA-256
`5927a1cf3c73edce2da50fe5401bc326bf16fab0eeeb098d5a54fae48a4ac71a`. Wave 2's final source
lifecycle passed 244/244 plus self-gate and contract check; its independent audit found zero open
findings (report SHA-256 `0bab19185fb06579b5ea7cd89c621ed5e68284b647de8a9b8364872695be9b4b`).

Audience: maintainers and auditing agents. User-facing documentation belongs in `README.md`,
`SKILL.md`, and `docs/CONFIG.md` after the implementation survives its earlier correctness waves.

Tracking epic: `tu-native-config-composition-tzf`.

## 1. North star

A repository may split one large true-up configuration into stable, domain-owned JSON fragments
without changing the dependency graph those declarations mean. Composition must be deterministic,
fail closed, worktree-local, inspectable, and safe under older true-up binaries.

Telltail is the motivating case, not a special case in the engine. Its current root configuration is
3,187 lines with 529 declared edges. Its active worktrees contain multiple independently-evolved
configurations. The engine remains repo-agnostic.

Success has two independent proofs:

1. **Non-regression:** flat and composed configurations have the same declared meaning under an exact,
   predeclared semantic projection and command matrix.
2. **Structural improvement:** routine domain edits stay inside one fragment, worktree state stays
   isolated, and controlled disjoint-domain edits compose without root-manifest churn.

Composition is not presumed to be a runtime optimization. Runtime claims require the paired benchmark
protocol in section 14.

## 2. Scope and non-goals

Version 1 provides native loading and inspection of explicit JSON fragments.

In scope:

- an explicit root manifest;
- deterministic partial-config fragments;
- full current-schema support;
- repo-relative declaration provenance;
- fail-closed compatibility with the latest old published loader and the current pre-composition loader;
- working-tree, committed/staged, Git worktree, colocated-jj, and jj-only behavior;
- manual migration guidance and rollback;
- clean packaged use outside the source checkout.

Not in scope:

- glob discovery;
- recursive includes;
- a migration command;
- YAML, JSONC, comments, or trailing commas;
- cross-repository live includes;
- changing Telltail graph defects during the structural migration;
- a shared graph cache across worktrees;
- publishing, pushing, or modifying live Telltail worktrees without separate authorization.

Migration is manual in v1. If a future migrator is desired, it receives a separate contract covering
dry-run, no-clobber, deterministic partitioning, unknown-key handling, and rollback.

## 3. Root manifest syntax

After the legacy-compatible `JSON.parse` mode probe, an own `compositionVersion`, an own `include`, or
an effective `zones === null` declares composition intent. The probe deliberately retains JSON.parse
last-wins behavior: `{"zones":null,"zones":[]}` remains legacy, while either composition-only key
still activates. Once intent is present, all three conditions below MUST hold; a partial or malformed
triple is `composition-sentinel-invalid` and MUST NOT fall back to the legacy loader:

1. `compositionVersion` is exactly `1`;
2. `include` is a non-empty array of strings;
3. `zones` is exactly `null` in the root manifest.

Example:

```json
{
  "_comment": "true-up composed configuration",
  "compositionVersion": 1,
  "include": [
    "config/true-up/core.json",
    "config/true-up/docs-site.json",
    "config/true-up/tailmap.json",
    "config/true-up/tailview.json",
    "config/true-up/audits.json"
  ],
  "zones": null,
  "out": ".true-up/depgraph.json",
  "symbols": false,
  "strictSpans": false
}
```

`zones: null` is a mandatory compatibility sentinel, not a nullable zone declaration. All real zone
declarations live in fragments. The new loader removes the sentinel before normal validation.

The selected root manifest in composed mode must itself be a regular, non-symlink file whose real path
is inside the selected worktree. Legacy flat mode retains the existing root-symlink behavior in v1;
this avoids broadening a compatibility change beyond composed configs.

Why this sentinel exists:

- v0.1.4 and the current v0.2.1 loader reject non-array `zones` with exit 2;
- both versions otherwise ignore `compositionVersion` and `include`;
- an include-only root with a normal `out` was measured under v0.1.4 to exit 0 with `inert: true` and
  zero edges—a dangerous false-clean result;
- a new `minVersion` key alone would not help because the old loaders would ignore it too.

The sentinel preserves the existing custom `out` field, unlike an `out: null` sentinel. Wave 2 must
execute the compatibility fixture against v0.1.4 and the pre-composition v0.2.1 implementation. If a
future old version is found that accepts `zones: null`, composition cannot ship until the guard is
strengthened.

The existing root filename selection remains unchanged:

1. `.true-up.json` wins when present;
2. otherwise `true-up.config.json` is used;
3. both names present retain the existing first-file precedence.

Composition paths resolve only after the target repository/worktree root is selected.

## 4. Include-path contract

Version 1 uses literal paths only.

- Paths are relative to the selected repository root.
- Paths use `/` separators. Backslashes are rejected rather than interpreted differently by platform.
- Absolute paths are rejected.
- Empty paths are rejected.
- Paths containing an unpaired UTF-16 surrogate are rejected because Node would encode distinct JSON
  strings as the same replacement-character filesystem path.
- Paths whose normalized lexical form escapes the repository are rejected.
- The final real path must remain inside the repository.
- The target must be a regular file.
- Any symlink path component is rejected, including an in-repo directory symlink and a final symlink
  whose target remains inside the repository.
- FIFOs, sockets, devices, and directories are rejected.
- Included files under `.git/`, `.true-up/`, or other ignored/generated cache locations are rejected.
- Duplicate normalized include paths are rejected with both manifest indices.
- An included fragment may not contain `include` or `compositionVersion`.
- Globs are treated as literal filenames and therefore normally fail as missing files.

Because recursive includes are not supported, include cycles and diamonds do not exist as legal v1
structures. A fragment that attempts to include itself, the root, a sibling, or any other fragment
fails as an invalid nested include before traversal. The dependency graph's own causal cycles remain
legal and are unrelated to config inclusion.

Working-tree commands may read a regular untracked fragment to support authoring. They report its
untracked state in config diagnostics. `--check --committed` fails closed when any composition source
is untracked, ignored, missing from the selected Git worktree index, or differs unstaged from the
indexed source used to justify an indexed graph. Git committed checks read the selected worktree's
index blobs only; in clean CI the index mirrors `HEAD`. The exact staged matrix is in section 12.

## 5. Resource bounds

Composition adds explicit denial-of-service bounds independent of the general engine deadline:

- at most 256 include entries;
- at most 32 MiB of included JSON bytes in aggregate;
- maximum include depth is exactly one edge (root → fragment); any nested include fails without opening
  the named grandchild;
- each reached include is opened and parsed at most once; fragments after the first canonical
  path-ordered failure are not opened (section 9);
- no filesystem enumeration or repository-wide search is performed to discover fragments;
- the cooperative engine deadline is checked between fragment reads and merge phases.

These are product safety limits, not measured performance claims. The frozen Telltail variants are
approximately 0.10–0.21 MiB total as monoliths, far below the aggregate limit.

## 6. Full-schema ownership

Root-only settings:

- `compositionVersion`;
- `include`;
- `out`;
- `symbols`;
- `strictSpans`;
- `deadlineMs`;
- `repoId`;
- `$schema`, if used;
- the mandatory `zones: null` sentinel.

Fragments may declare:

- `facts`;
- `zones` as an array;
- `seed` as an array;
- `imports`;
- `exports`;
- underscore-prefixed inert metadata such as `_comment`.

The root may also carry underscore-prefixed inert metadata (the example above uses `_comment`).

Root-only settings appearing in a fragment are invalid even when identical to the root value. A
fragment cannot silently override process-wide behavior.

For incremental migration, the composed root may also contain `facts`, `seed`, `imports`, and
`exports`. It may not contain real zones because `zones: null` is reserved for the compatibility
sentinel.

In composed mode, unknown non-underscore keys are errors. Underscore-prefixed metadata is inert and
does not participate in merge identity. Legacy no-include mode retains its current unknown-key
compatibility.

Arbitrary existing edge kinds remain valid. The loader must not restrict declarations to
`derives-facts-from` and `generated-from`; observed Telltail variants also use `depends-on`, `tests`,
`calibrates`, and `validates`.

## 7. Source-local legacy behavior versus cross-source composition

The loader distinguishes declarations repeated within one JSON source from declarations repeated
across sources.

Within one source:

- array order and multiplicity are preserved;
- existing zone, seed, and export duplicates remain duplicates;
- legacy same-file behavior is not silently cleaned up during migration.

This is necessary because the frozen probability-matrix variant has 544 seed declarations including
two exact duplicate groups. Structural migration must preserve that variant before any separate graph
correction.

Across different sources:

- one logical declaration has one owner;
- exact duplicates are errors rather than silently deduplicated;
- conflicting definitions are errors;
- errors name every origin.

The distinction prevents two domains from unknowingly owning the same contract while preserving
existing single-file multiplicity.

## 8. Merge algebra

All paths and identities below use their POSIX-normalized repo-relative representation. Source
iteration includes the selected root plus every fragment in canonical lexical path order, not manifest
order or filesystem enumeration order. Within each source, array order remains unchanged. Reordering
the `include` array changes the root file's own content hash but does not change the effective config,
provenance, or normalized composed meaning.

Canonical path order compares raw UTF-8 bytes, with no Unicode normalization or case folding.

Normalization happens before an owner key is formed and is closed as follows:

- entry, include, fact-steward, zone, import-snapshot, and ordinary edge/export endpoint paths use
  `node:path`'s POSIX lexical normalization after `/`-separator and containment validation;
- for `path#fact` endpoints, only the path portion before the first `#` is normalized; the fact suffix
  is opaque and byte-preserved;
- imported `@alias:fact` endpoints are not path-normalized; the alias and fact suffix are opaque and
  byte-preserved after their existing schema validation;
- import aliases and export IDs are literal owner identities; they receive no case folding, Unicode
  normalization, or trimming;
- glob tokens already legal in zone paths remain tokens during POSIX normalization; normalization
  neither expands them nor performs filesystem lookup;
- backslashes never become separators, and normalization never turns an otherwise invalid declaration
  into a valid one.

Consequently, two spellings that normalize to the same owner are the same cross-source owner and
conflict. Source-local multiplicity is determined from provenance before flattening, not reconstructed
from adjacent entries after merge.

### 8.1 Facts

`facts` remains `path -> [[arrayProp, keyField], ...]`.

- A fact steward path is owned by one source.
- Repeating the same fact path across sources is an error, whether identical or different.
- Within its owning source, selector order and multiplicity remain legacy-compatible.
- Invalid selector tuples fail with source and JSON pointer.

### 8.2 Zones

- A zone path is owned by one source.
- Repeating the same zone path across sources is an error, whether identical or different.
- Distinct overlapping paths are legal and retain the engine's exact/suffix/prefix/catch-all
  specificity rules.
- A fragment's `zones` must be an array with the existing typed zone shape.
- The root `zones: null` sentinel never becomes a zone.

### 8.3 Seed edges

For cross-source ownership, a seed's logical endpoint key is canonical `(from, to)`. Missing `kind`
canonicalizes to `derives-facts-from` for conflict comparison.

- The exact same canonical edge in two sources is an error.
- The same endpoints with different `kind` are an error.
- The same generated endpoints with different `via` are an error.
- Distinct endpoints are additive.
- Within one source, existing order and duplicates remain untouched.
- Generator execution continues to deduplicate by `via` in `run`; composition never causes a duplicate
  include to execute a generator twice because duplicate includes are invalid.

### 8.4 Imports

- An import alias is owned by one source.
- Repeating an alias across sources is an error, including an identical specification.
- Existing path, `repoId`, audience, tracking, schema, taint, and privacy validation runs after merge.

### 8.5 Exports

- An export `id` is owned by one source.
- Repeating an `id` across sources is an error, including an identical specification.
- Different IDs may intentionally export the same source.
- Existing audience/declassification validation remains authoritative.

### 8.6 Scalars

All scalars are root-only. There is no last-writer-wins, first-writer-wins, or identical-value merge.
Absent and explicit `false` retain their existing distinct meanings.

### 8.7 Duplicate JSON object keys

Once the legacy-compatible mode probe activates composed mode, duplicate JSON object keys in the root
or any fragment are rejected before last-wins values enter the effective config. The production parser
must report the repo-relative source and key location. The mode probe itself uses legacy `JSON.parse`
last-wins behavior solely to decide whether composition is active, as frozen in section 9. Legacy
no-include parsing remains unchanged in v1 to avoid an unrelated compatibility break.

### 8.8 Effective config and normalized semantic bytes

The production loader returns both an effective `config` and `normalizedConfigBytes`:

- `config` retains `compositionVersion: 1`, replaces `include` with its sorted normalized paths,
  removes the root `zones: null` sentinel, emits merged `zones` only when a source declares at least
  one zone (otherwise the field stays absent so the existing public-default applies), retains root
  scalar field presence, drops underscore-prefixed inert metadata, and merges declaration blocks in
  canonical source-path order while preserving each source's local array order and multiplicity;
- `normalizedConfigBytes` is the partition-independent semantic projection used by property and later
  flat/composed tests. It omits `compositionVersion`, `include`, and underscore metadata; retains the
  presence and exact values of root scalars; deep-sorts object keys; groups declarations by logical
  owner (`facts` path, zone path, seed `(from,to)`, import alias, export id); sorts owner groups by
  canonical identity; and preserves the exact source-local sequence and duplicate multiplicity inside
  each group. Missing seed `kind` canonicalizes to `derives-facts-from` in this semantic projection;
- the byte encoding is exactly `JSON.stringify(deepKeySortedProjection) + "\n"` in UTF-8. No pretty
  indentation is added.

This projection normalizes ordering only for comparison. The effective config still preserves
source-local array behavior used by the engine.

The projection's closed top-level schema is the six optional root scalar keys (`$schema`, `out`,
`symbols`, `strictSpans`, `deadlineMs`, and `repoId`) plus the five optional declaration-family keys
(`facts`, `zones`, `seed`, `imports`, and `exports`). A key is present if and only if it was present in
the effective config; defaults are not materialized. `compositionVersion`, `include`, and every
underscore-prefixed metadata key are never present. Objects are deep-key-sorted. Arrays retain item
order except that independent owner groups are sorted and then concatenated. A group retains its
owning source's exact array order and duplicate multiplicity. The only value rewrite is an absent seed
`kind`, which becomes the literal string `derives-facts-from`.

The following literal example freezes every scalar and declaration family. The root manifest listed
`z.json` before `a.json`; the effective `include` below is already canonicalized. Both `z/**` zone
entries, both `zed` exports, both `z.md` seed entries, and both `z.json` fact selectors originate in
one source, so their repeated owner/value sequence is legal and preserved.

```json
{
  "compositionVersion": 1,
  "include": ["config/true-up/a.json", "config/true-up/z.json"],
  "$schema": "https://example.invalid/true-up.schema.json",
  "out": ".true-up/custom.json",
  "symbols": false,
  "strictSpans": false,
  "deadlineMs": 0,
  "repoId": "example/repo",
  "facts": {
    "z.json": [["items", "id"], ["items", "id"]],
    "a.json": [["rows", "key"]]
  },
  "zones": [
    {"path": "z/**", "rules": ["rule-b", "rule-a"]},
    {"path": "a/**", "visibility": "public"},
    {"path": "z/**", "audience": "agents"}
  ],
  "seed": [
    {"from": "z.md", "to": "z.json#items.one"},
    {"from": "a.md", "to": "a.json#rows.one", "kind": "generated-from", "via": "tools/gen.mjs"},
    {"from": "z.md", "to": "z.json#items.one", "kind": "derives-facts-from"}
  ],
  "imports": {
    "zed": {"path": "snapshots/z.json", "repoId": "z/repo", "audience": "internal"},
    "alpha": {"path": "snapshots/a.json", "repoId": "a/repo", "audience": "public"}
  },
  "exports": [
    {"id": "zed", "from": "z.json#items.one", "audience": "internal"},
    {"id": "alpha", "from": "a.json#rows.one", "audience": "public", "declassify": false},
    {"id": "zed", "from": "z.json#items.two", "audience": "internal"}
  ]
}
```

Its `normalizedConfigBytes` are exactly the following single UTF-8 line followed by one LF byte; the
line wrapping of surrounding prose is not part of the value:

```json
{"$schema":"https://example.invalid/true-up.schema.json","deadlineMs":0,"exports":[{"audience":"public","declassify":false,"from":"a.json#rows.one","id":"alpha"},{"audience":"internal","from":"z.json#items.one","id":"zed"},{"audience":"internal","from":"z.json#items.two","id":"zed"}],"facts":{"a.json":[["rows","key"]],"z.json":[["items","id"],["items","id"]]},"imports":{"alpha":{"audience":"public","path":"snapshots/a.json","repoId":"a/repo"},"zed":{"audience":"internal","path":"snapshots/z.json","repoId":"z/repo"}},"out":".true-up/custom.json","repoId":"example/repo","seed":[{"from":"a.md","kind":"generated-from","to":"a.json#rows.one","via":"tools/gen.mjs"},{"from":"z.md","kind":"derives-facts-from","to":"z.json#items.one"},{"from":"z.md","kind":"derives-facts-from","to":"z.json#items.one"}],"strictSpans":false,"symbols":false,"zones":[{"path":"a/**","visibility":"public"},{"path":"z/**","rules":["rule-b","rule-a"]},{"audience":"agents","path":"z/**"}]}
```

Changing any scalar's presence, any declaration value, any source-local order, or any duplicate count
changes these bytes. Repartitioning whole owner groups among fragments does not.

## 9. Validation and failure ordering

Composition is all-or-nothing.

The first failure in the following order wins. No later phase runs, and no later fragment is opened.

1. Select the target root and entry filename using the established filename precedence. An absent
   entry is a successful legacy empty config, not a composition error.
2. Read the selected entry once and perform the legacy-compatible JSON parse used only to choose the
   mode. A JSON syntax failure is `root-invalid-json`. Activation is evaluated on that parsed object's
   last-wins values: own `compositionVersion`, own `include`, or `zones === null`. This preserves v1
   legacy duplicate-key behavior when the parsed object does not activate composition.
3. If composition is active, classify the entry in this order: final symlink
   (`composition-root-symlink`), non-regular/missing bytes (`composition-root-not-regular`), then opened
   real path outside the selected root (`composition-root-realpath-escape`). Re-decode as fatal UTF-8,
   parse JSON, and reject duplicate object keys in source occurrence order. Thus a composed document
   whose replacement-decoded mode probe succeeded can still fail `root-invalid-utf8`; a document that
   did not parse during the mode probe already failed `root-invalid-json`.
4. Validate the complete activation triple, then the literal 256-entry count, then root keys/scalars
   and root declarations. Validate each include string's lexical path rules in manifest-index order.
   After all paths normalize, choose a duplicate normalized path in canonical path order and report
   all of its manifest indices.
5. Sort accepted fragment paths by raw UTF-8 bytes. For each fragment in that canonical order, check
   the cooperative deadline, call the provider exactly once, classify the provider result, enforce the
   remaining aggregate-byte allowance, fatal-decode, parse, reject duplicate keys, and validate the
   fragment shape. Nested `include`/`compositionVersion` is checked before other fragment keys and
   fails immediately; the named grandchild is never opened. Within shape validation, declaration
   families are visited as facts, zones, seed, imports, exports; array entries use index order and
   object members use canonical key order.
6. Stop at the first canonical fragment failure. For example, with sorted fragments `a.json`,
   `b.json`, and `c.json`, a malformed `a.json` produces reads `[entry, a.json]`; neither `b.json` nor
   `c.json` is opened. Include-list reordering cannot change that sequence or the selected error.
7. Only after every fragment succeeds, sort root plus fragments by canonical source path, merge the
   complete effective config and provenance, collect all cross-source conflicts in canonical owner
   order, and fail once with every conflicting origin if the set is non-empty.
8. Only then expose `CONFIG`, compute `OUT`, load optional symbols, build a graph, inspect a prior cache,
   or execute a generator.

No error may fall back to `{}` or to a prior graph.

Wave 1 exposes this through zero-dependency `lib/config.mjs`. Its production entry accepts the selected
repo root plus a virtualizable source provider. The provider interface is exactly:

- `selectEntry(entryNames)` → `null` or one entry record using the supplied filename precedence;
- `inspectAndRead(normalizedRepoPath, {role, maxBytes})` → one result record.

The result `kind` vocabulary is closed to `regular`, `missing`, `symlink`, `outside`, and
`not-regular`. Every record has the requested normalized repo-relative `path`; it never exposes an
absolute `realPath`. A `regular` accepted read has exact `bytes`; `tooLarge: true` may omit bytes and
may carry a nonnegative `size`. `realInside` is only a boolean containment result. `ignored` is only a
boolean. `tracking` is opaque provider-to-loader state: the loader may retain it for Wave 2's
allowlisted tracked/staged summary, but raw provider state is never serialized publicly. A provider
must classify operational failures fail-closed into this vocabulary or throw; it may not return empty
bytes as success.

For an include result, public-code precedence is `ignored` → `missing` → `symlink` → `outside` →
anything other than accepted `regular` → aggregate bytes, mapping respectively to `include-ignored`,
`include-missing`, `include-symlink`, `include-realpath-escape`, `include-not-regular`, and
`include-bytes-limit`. Entry mapping is the ordered classification in step 3. Provider-only fields and
exceptions never appear in a public diagnostic.

The loader never enumerates the repository, writes, computes `OUT`, loads symbols, reads a graph/cache,
or executes a generator. It returns legacy or composed mode, raw entry metadata, effective config,
normalized semantic bytes, sorted sources, and declaration provenance. `ConfigLoadError` is
CLI-neutral; Wave 2 maps it to `invalid-config`.

Direct config-consuming commands fail with exit 2 and a JSON error envelope whose stable class is
`invalid-config`. Human diagnostics use repo-relative paths and never print raw config values or an
engine `/home/...` path. The detail contains:

- a stable composition error code;
- repo-relative source;
- JSON pointer or array index where available;
- all conflicting origins where relevant;
- an include chain of root → fragment (one edge in v1).

The Wave 1 stable composition detail-code inventory is closed to exactly these 30 values:

- activation/root: `composition-sentinel-invalid`, `composition-root-symlink`,
  `composition-root-not-regular`, `composition-root-realpath-escape`, `root-invalid-utf8`,
  `root-invalid-json`;
- include list/path/resource: `include-count-limit`, `include-bytes-limit`, `include-path-empty`,
  `include-path-backslash`, `include-path-absolute`, `include-path-nul`, `include-path-escape`,
  `include-path-invalid-unicode`, `include-path-duplicate`, `include-root`, `include-forbidden-location`, `include-ignored`,
  `include-missing`, `include-symlink`, `include-realpath-escape`, `include-not-regular`;
- parsing/schema/merge: `fragment-invalid-utf8`, `fragment-invalid-json`, `duplicate-json-key`,
  `nested-include`, `root-only-key`, `unknown-key`, `invalid-source-shape`,
  `cross-source-conflict`.

There is no generic composition-detail fallback and no provider-kind detail code. Adding, removing, or
renaming one of these 30 values requires a contract change and an inventory-gate update. These are
loader detail codes only; existing downstream graph, policy, VCS, and command usage error kinds are
outside this inventory.

The public diagnostic detail key set is `code`, `source`, `pointer`, `includeChain`, `origins`,
`location`, and `conflicts`; keys without data are omitted. `source` and every
`origins[*].source` are normalized repo-relative paths. JSON pointers use RFC 6901 escaping
(`~` → `~0`, `/` → `~1`). Duplicate-key origins report one-based `line` and `column` for every
occurrence. Syntax `location` reports the runtime's available line/column or byte offset without
echoing source text. A fragment `includeChain` is exactly `[entry, fragment]`; a root chain is
`[entry]`. Conflict entries contain only canonical identity plus sorted origins. The message,
structured detail, JSON stringification, and stack presented by the CLI may not contain raw config
values, absolute paths, provider exceptions, or machine-local engine paths. The engine maps these
detail codes to the existing top-level `kind: "invalid-config"`; they are not new process exit classes.

`gate` retains its aggregate exit-1 contract when a child fails. The failing child command remains the
surface for exit-2 detail.

Config-independent precedence surfaces—help, version, capabilities, robot docs, hooks help, and an
unknown command/flag—do not traverse or validate fragments and do not write. An invalid fragment must
not turn `--version` into `invalid-config`, nor turn an unknown command into a build.

## 10. Provenance

Composition must tell an agent exactly which file to edit without leaking machine-local or private
information.

In composed mode:

- `status --json` reports the repo-relative entry, `compositionVersion`, sorted source list/count, and
  tracked/staged warnings;
- declared graph edges carry a repo-relative `declaredIn` with source and JSON pointer/index;
- graph/config inspection reports source provenance in deterministic order;
- conflict errors report all origins, never a selected winner;
- provenance is stable under manifest reordering;
- no absolute path or raw declaration value appears in public JSON diagnostics;
- export snapshots never contain config provenance or fragment paths.

Legacy no-include graph bytes remain unchanged; provenance fields are emitted only for composed mode.

## 11. Exact differential oracle

Wave 0 freezes a single `semanticProjection` used by every later flat-versus-composed comparison. No
later wave may broaden the exclusion list merely to make a test pass.

### 11.1 Graph projection

For every node present in the flat graph, compare the complete node object byte-canonically after deep
key sorting. This includes node ID, kind, path/fact identity, content hash, audience, visibility,
intent, rules, and taint metadata, subject only to the single root-config hash-field replacement
listed below. The selected root config node remains in the comparison; its complete object is not
excluded.

For every edge, compare the complete edge object after removing only composed-mode `declaredIn`.
Compare exact sorted identity, `from`, `to`, kind, propagation, direction basis, `via`, and every other
existing field.

Allowed graph differences are closed:

1. exactly `graph.nodes["file:<selected-root-config-path>"].hash` may differ for a migrated composed
   fixture. Its candidate value MUST equal
   `SHA-256(exact raw composed-manifest bytes).slice(0, 16)`, using the same algorithm as the engine's
   file-node hash. The fixture records both the exact manifest bytes and this expected value. Every
   other field on that node remains byte-canonically equal to the flat graph, and no other legacy node
   hash may differ;
2. one new `file:<fragment-path>` node for each tracked fragment, with the expected fragment content
   hash and zone metadata;
3. composed-mode provenance fields at `graph.edges[*].declaredIn`;
4. composed-mode top-level config-source metadata, if persisted in the graph.

The root config node is not excluded: only its `hash` field has the exact replacement rule above.
For `.true-up.json`, the allowed JSON path is literally
`graph.nodes["file:.true-up.json"].hash`; if the selected entrypoint is `true-up.config.json`, only the
corresponding literal node path is allowed. Existing edges to the selected root config, including
known defects, must remain. No new dependency edge to a fragment is allowed unless the flat source
already had the same logical edge and the migration explicitly remaps its endpoint under a separately
approved change.

Expected fragment-node IDs and count are recorded per fixture. Any new JSON path outside the closed
allowlist fails the differential.

### 11.2 Envelope and command projection

Each command has a child-only sentinel declaration so a command that bypasses composition cannot pass
vacuously.

The flat/composed matrix covers:

- graph and build;
- status;
- working-tree and committed/staged checks;
- impact at file and fact targets;
- impact `--since` and `--proof` after a controlled post-migration edit;
- policy and externalities;
- verify-scope;
- run, strict run, and no-write run;
- gate and committed gate;
- export;
- symbols and strict spans;
- `--repo`, `$TRUE_UP_REPO`, nested CWD, Git worktree, colocated jj, and jj-only target selection.

Compare exact exit code, `ok`, `_v`, stable error/kind class, relevant JSON data, diagnostic class,
and write-set. Where config-source counts or provenance are intentionally added, compare against the
same closed path allowlist and expected counts.

Export bytes must remain exact because provenance is forbidden from snapshots.

The write-set remains the established one: graph output for a build, no-clobber config for `init`, and
opt-in Git hooks. No merged/materialized config file is written. `--no-write` writes nothing.

## 12. Freshness, staging, and worktrees

Included fragments are tracked content sources. Their raw file hashes appear through their file nodes,
so even a formatting-only fragment edit can make the stored graph stale; normalized semantic equality
does not excuse an outdated persisted graph.

Required Git staging matrix:

Git committed checks read the selected worktree's index blobs only. A clean CI checkout's index mirrors
`HEAD`; a staged deletion remains missing and may never be rescued from `HEAD`.

1. staged fragment plus matching staged graph passes committed check;
2. staged fragment without matching graph fails;
3. staged graph followed by an unstaged fragment change fails;
4. deleted or renamed included fragment fails closed;
5. untracked included fragment may build locally but committed check fails;
6. ignored included fragment is invalid;
7. an unchanged entry with a changed fragment is still detected.

Each selected worktree has its own effective config and `.true-up/depgraph.json`. Never cache by config
hash alone and never place graph state in the shared Git common directory. Identical config hashes can
produce different graphs when tracked content differs.

Concurrency tests write only to disposable linked worktrees under `$HOME/scratch`. They preseed each
cache with distinct bytes/inode/mtime/hash sentinels, build concurrently, and prove no cross-root
mutation. Live Telltail worktrees receive read-only `status` and `--no-write` probes only, surrounded
by pre/post config/cache hashes.

## 13. Frozen baseline

Capture time: 2026-07-14T15:30:59.536Z.

true-up input:

- source commit: `7844b4f77f4cd74f7026edf8f7bf6811c6a11e65`;
- package version: `0.2.1`;
- `lib/engine.mjs` SHA-256:
  `c39fae47e8a33c39cf6bebc4d8477034614a3e10a7d56a5625cc56371f92954e`.

Telltail input:

- root commit: `d88da14a51337cf9cda1fbee400ebde7b568bcd4`;
- 17 worktrees at capture time;
- 11 worktrees dirty at capture time;
- 6 distinct working config hashes;
- 11 graph caches present, 6 absent;
- every capture probe preserved config/cache bytes, inode, mtime, and SHA-256;
- direct `--no-write --json` outputs from 361,555 to 583,193 bytes parsed successfully;
- old-form read-only merge orientation covered 16 other heads and observed zero conflict-marker pairs.

The worktree count and dirty state are evidence bound to this timestamp, not permanent requirements.
Wave 5 re-inventories and reports drift without silently substituting a new cohort.

Representative variants:

| Variant | Config lines | Config bytes | Seeds | Zones | Facts | Graph nodes | Graph edges |
|---|---:|---:|---:|---:|---:|---:|---:|
| root/core | 3,187 | 109,188 | 529 | 43 | 4 | 771 | 529 |
| confidence sequence | 5,464 | 207,940 | 984 | 43 | 4 | 953 | 984 |
| probability matrix | 3,262 | 111,761 | 544 | 43 | 4 | 846 | 544 |
| tail-tales clarity | 3,291 | 112,217 | 533 | 48 | 5 | 903 | 538 |
| website | 3,247 | 111,317 | 541 | 43 | 4 | 897 | 541 |
| older agent cohort | 3,063 | 104,927 | 505 | 43 | 4 | 753 | 505 |

Raw local artifacts are under `$HOME/scratch/true-up-config-composition/` and are intentionally not
committed because they contain machine-local worktree paths and complete graphs. Integrity anchors:

- `telltail-worktrees-baseline.json` SHA-256:
  `f08e1eb2631835442176148e54a3c9b72ec390608e8fca711cc6b0b73b5b158b`;
- initial version-skew baseline (with both compatibility sentinels) was regenerated after the first
  capture; its current SHA-256 must be taken from the scratch artifact ledger during audit;
- every graph artifact hash is listed in `artifact-sha256.txt`.

## 14. Performance protocol

Performance acceptance compares the same packed candidate binary against flat and composed versions
of the same scratch target. It does not compare a global old binary with source-tree new code.

Pre-registered procedure:

- targets: frozen 529-edge and 984-edge shapes;
- commands: no-write build JSON, status JSON, and gate JSON;
- five fixed warmup runs per command/form;
- at least 20 alternating paired measured runs per command/form;
- A/B order alternates and the starting side is recorded;
- runs are sequential and separate from concurrency testing;
- record wall time, child CPU time, peak RSS, exit code, stdout/stderr hash, host/kernel/Node version,
  load average, and relevant process pressure;
- reject a pair only for a recorded external interruption; no statistical outlier deletion after data
  inspection;
- raw JSONL schema and all samples are persisted before aggregation;
- compute paired p50 and p95 for each command/shape.

Proposed release thresholds, fixed before candidate measurement:

- build p50 no worse than +10%;
- build p95 no worse than +15%;
- status p50 and p95 no worse than +10%;
- gate p50 and p95 no worse than +10%;
- output, exit code, and semantic projection remain equal for every timed pair;
- fragment loading performs one bounded read per source and no extra repository scan.

These percentages are acceptance policy, not measured results. A speed improvement is reported only
when it exceeds the measured A/A noise band and is supported at both p50 and p95.

## 15. Known-defect ledger

The structural migration preserves these items until separately fixed. A parity test must not erase,
normalize, or silently repair them.

- `KD-COMPAT-001`: v0.1.4 ignores unknown `compositionVersion`/`include` keys and returns an inert,
  exit-0 graph for an include-only root. The mandatory `zones: null` sentinel is the planned guard.
- `KD-JSON-001` (**resolved in Wave 0B**): Wave 0 direct-file capture did not reproduce the prior
  exact-65,536-byte report, but a piped `spawnSync` caller did expose the actual false-success path.
  A 164,597-byte `--impact --since HEAD --proof --json` envelope repeatedly arrived as the same invalid
  146,176-byte prefix with child exit 0; source and packed entries both reproduced it. Independent audit
  then found the same false-success class in asynchronous human `console.log` loops: a 4,096-node graph
  emitted only 268 nodes. Structured direct writes and process-local human logging now share synchronous
  `writeStdout`. The permanent `tests/large-json-transport.mjs` fixture requires complete source and
  clean-installed-package structured and human graph/proof/status/dry-run output for 4,096 dependents,
  exercises gate child paths, rejects exact-65,536-byte plus asynchronous-writer mutants, resolves an
  installed `.bin/true-up` symlink to the package engine, and proves an early closed pipe exits nonzero
  with EPIPE.
  Regular-file redirection is insufficient evidence because it masked the original defect.
- `KD-VCS-001` (**resolved in Wave 0B**): the Git/jj text adapters inherited Node's
  historical 1 MiB `execFileSync` buffer and converted capture failures to empty text/lists. A large
  `git ls-files` or historical `git show` could therefore make graph, externalities, or impact output
  falsely clean. The adapter now uses an explicit 64 MiB bound, distinguishes a genuine no-match or
  absent object from a failed capture, and fails loud with exit 2 plus `vcs-read-failed` under `--json`.
  The focused source harness now covers >1 MiB tracked-list and historical-fact cases, injected
  >64 MiB capture failure, the audited object-read operational-failure/absence distinction, and
  index-only staged deletion. It also pins compatibility without `cat-file -Z` (Git <=2.40), the empty
  implicit baseline in an unborn Git repository, and non-colocated jj behavior: `@-` remains the
  default, an obsolete default-probe failure cannot fall back to `@`, ordinary missing paths remain
  empty-success, and a failed required `jj diff` read fails loud. The independent audit also found
  that display/line-oriented path output dropped LF names and Git-quoted ordinary Unicode. Git path
  streams are now captured as bytes with `-z`, require terminal NUL framing, and decode each path with
  fatal UTF-8 plus `ignoreBOM:true`; LF/tab/Unicode (including a leading U+FEFF) round-trip exactly
  while malformed framing and invalid UTF-8 exit 2. Fatal decoding without `ignoreBOM:true` is not
  sufficient because `TextDecoder` otherwise strips the leading filename code point.
  jj file/diff inventories use JSONL templates, and its anchor scan starts from that lossless list.
  The source regression proves exact graph/seed/leak/impact behavior for those paths in Git and jj.
  Git diffs also use `--no-renames` so staged renames expose both the deleted source and added
  destination; ref/root probes distinguish documented absence from operational failure, including a
  colocated Git/jj case where falling through to jj would otherwise bless a staged graph deletion.
  The root fixture also invokes the same workspace through an explicit `--repo` directory symlink;
  directory probes follow it like `git -C`, so the Git-marker guard cannot be bypassed.
  A tracked symlink's repository content is its link text, so security and policy scans now use
  `lstat` + `readlink` instead of following the live target. The fixture pins a broken machine-local
  link as a symlink graph node and requires both externalities and policy violations; this prevents a
  false-clean gate and any read of mutable content outside the target repository.
  Closure evidence includes the 239/239 source lifecycle, eight-stage clean-package CI, and independent
  source/installed VCS audits with no remaining Critical/High/Medium finding.
- `KD-JSON-002` (**resolved in Wave 0B**): live inventory first found JSON-capable success paths
  that emitted `_v` without boolean `ok` (capabilities, robot-docs aliases, version aliases, and hooks
  success modes), while symbols-enabled/missing-optional-dependencies lacked a JSON envelope. Those
  initial paths are now represented in the source gate. The inventory has expanded to 56 cases and
  derives canonical command coverage from live capabilities; it also covers usage/config/fail-loud
  diagnostic parity and explicit missing-value, trailing-global, and stray-positional guards. The
  earlier frozen 38/50 red run remains the baseline and names `status-bad-ref`, `status-outside-vcs`,
  `graph-invalid-config`, `graph-build-error`, `impact-unknown`, `verify-scope-bad-ref`, `run-bad-ref`,
  `export-missing-audience`, `export-build-error`, `unknown-command`, `unknown-flag`, and
  `hooks-external-refusal`; its report SHA-256 is
  `49e1ef01868fe8a4542be82235c16b99ef9ea745540038ced559b559477cd4b5` (engine SHA-256
  `342db888077f33e188b253a5a6c35791d8e2d914fd6043e993efac74f2277c1d`, harness SHA-256
  `2bb2567d5b56b8eb2d016c4163bce2a9681495014dc0e0d8608bbf4480e032e2`).
  A later stable-kind tightening produced a separate 42/56 red baseline: 14 `ok:false` cases lacked
  their documented nonempty `kind` because the report had incorrectly substituted `error`. The
  inventory now rejects that substitution and the engine supplies command-specific kinds plus a
  stable backstop. The current 59-case inventory additionally cross-checks each expected exit against
  its capability command row, each exact failure kind against the exhaustive `error_codes` list, and
  three broken-seed in-memory paths against the shared graph-build-error gate. It must fail on command-
  inventory, required-usage-guard, exit-set, error-code, or failure-kind drift. The source and
  clean-installed-package inventories both pass 59/59 with zero meta errors; the full lifecycle and
  independent package audit also pass with no remaining Critical/High/Medium finding.
- `KD-GRAPH-001`: three generated CLI pages are missing mechanical edges.
- `KD-GRAPH-002`: the generated-doc wrapper appears only as `via`, not as a causal source.
- `KD-GRAPH-003`: the manually copied verification page lacks its source dependency.
- `KD-GRAPH-004`: the root config contains a self-edge and additional causal cycles need source-of-truth
  review.
- `KD-GRAPH-005`: the adoption prose is stale/backward in places.
- `KD-GRAPH-006`: major packages and extracted facts remain outside the intentionally conservative graph
  slice.
- `KD-ADOPT-001`: Telltail invocation is version-skewed: root use and docs-site package pin do not agree.

The six flat graph artifacts and their hashes are the preservation oracles. Graph corrections happen
only after the composed migration is proven equivalent.

For `KD-GRAPH-001` through `KD-GRAPH-006`, the root preservation oracle is the direct no-write graph
stdout SHA-256 `ffb67f3d9624bb0d7503d46e8c97288ebd5f9901e5d8bfeefe9f8f94b947e8c6`.
Variant-specific expected hashes remain in the frozen manifest and artifact ledger; a variant may not
substitute the root hash.

## 16. Test and mutation obligations

The T80 family must contain:

- prerequisite guards for complete 4,096-dependent piped output, bounded/fail-loud >1 MiB VCS reads,
  and inventory-complete JSON envelopes (`tests/large-json-transport.mjs`,
  `tests/large-vcs-output.mjs`, and `tests/json-envelope-contract.mjs` respectively);
- pure production-loader unit/property tests;
- real-CLI flat/composed differential tests;
- full command-to-child-only-sentinel coverage;
- staged/committed and worktree sentinel matrices;
- strict path, symlink, non-regular, ignored, missing, bounds, and nested-include failures;
- within-source duplicate compatibility and cross-source ownership conflicts;
- exact provenance and privacy assertions;
- prior-cache atomic-failure assertions;
- a deterministic Telltail-shaped 529-seed/43-zone fixture;
- fixed-PRNG partition/collision fuzzing with replay/minimization;
- packed external-target tests;
- load-bearing self-dogfood negative tests.

Named production mutants include:

- root-only loading;
- first/last-writer wins;
- include-order dependence;
- wrong semantic path base;
- duplicate concatenation;
- absent-versus-explicit-false/zero/empty scalar collapse;
- duplicate-key acceptance;
- collision rescue by a later declaration;
- import/export alias bypass;
- lexical-only path containment;
- eager fragment traversal for help/version/unknown command;
- staged-root-only freshness;
- equal-specificity zone last-wins (the production engine's frozen `s > bestS` tie-break is
  first-wins, so the mutant changes it to `s >= bestS`);
- swallowed invalid-child provenance;
- duplicate generator execution;
- provenance leak/loss;
- partial graph write before validation.

Each non-equivalent mutant needs a named killing test, observed failing assertion and red log hash,
followed by a reverted-green hash. Equivalent and unreachable claims require proofs defined in the
Wave 3 task acceptance criteria.

## 17. Audit protocol

Every wave has a separate audit task performed by an agent/session distinct from implementation.

An audit records:

- audited HEAD plus working-diff hash;
- fixture, package, corpus, and raw-log hashes relevant to the wave;
- exact commands and exit codes;
- severity-ranked findings and counterexamples;
- at least one representative falsification/injected regression observed to fail its gate;
- restoration and green proof;
- an explicit PASS or remaining blockers.

An audit with findings remains open. Remediation receives child tasks, and the remediated snapshot is
re-audited. No next wave becomes ready while a critical/high finding remains.

## 18. Wave graph

Durable work is in Beads under epic `tu-native-config-composition-tzf`:

1. Wave 0: this contract, exact baselines, oracle, bounds, thresholds, and defect ledger.
2. Audit Wave 0.
3. Wave 0B: large-stdout transport, large-VCS fail-closed reads, and JSON-envelope prerequisite guards.
4. Audit Wave 0B.
5. Wave 1: pure loader TDD and core safety.
6. Audit Wave 1.
7. Wave 2: engine/CLI wiring, command parity, version skew, staging, atomicity, and scratch worktrees.
8. Audit Wave 2.
9. Wave 3 parallel tracks: compound boundaries, structure-aware fuzzing, and mutation kills.
10. Audit Wave 3.
11. Wave 4: docs, versioned machine contract, package smoke, and load-bearing self-dogfood.
12. Audit Wave 4.
13. Wave 5 parallel scratch-only Telltail tracks: six-variant differential, worktrees, merge locality,
    and performance.
14. Audit Wave 5.
15. Wave 6 parallel clean-state tracks: package/CI, synthetic user, upstream mergeability, and hygiene.
16. Final independent audit.

`br dep cycles --json` must remain empty. At wave boundaries, only the next implementation task or its
parallel children may be ready.

## 19. Authorization boundaries

The frozen Telltail cohort is read-only evidence. No live cache rebuild, config split, package-pin
change, lockfile change, candidate link/install, commit, or branch edit is authorized by this plan.
Wave 5 works in disposable scratch replicas and produces a local patch/report only.

No publish, push, PR, GitHub mutation, global installation/link, or public comment occurs without an
explicit user instruction. Read-only fetch and disposable merge simulation are required before any
mergeability claim.
