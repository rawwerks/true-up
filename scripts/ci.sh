#!/usr/bin/env bash
# true-up:ignore-file true-up-markers
# scripts/ci.sh — true-up's TRUSTED LOCAL CI / release gate.
# Tests ARE the harness: one command runs the whole publish-readiness chain and exits
# nonzero on ANY failure. prepublishOnly invokes this directly, so a broken build cannot publish.
# Sub-minute (npm test dominates). The fixture suite includes multi-worktree/jj workspace,
# repo-qualified next-command, visibility-lattice privacy, inter-repo privacy, and parallel graph-write regressions.
# Not dependent on GitHub Actions.
#   Run: npm run ci   (or: bash scripts/ci.sh)
set -euo pipefail

# TAG COHERENCE (release safety): a publish must come from a HEAD tagged v$PKG_VER so the published
# bytes map to a real release commit. HARD-FAIL under prepublishOnly (the real publish path); WARN on a
# manual `npm run ci` so pre-tag dev validation still works. Factored into a function + a hermetic
# self-test hook so tests/engine.sh can exercise the EXACT guard ci.sh runs — regression for the
# "nested `npm run ci` reset npm_lifecycle_event to 'ci' and downgraded the HARD-FAIL to a silent warn"
# incident (the reason v0.1.4 made prepublishOnly call `bash scripts/ci.sh` DIRECTLY). The hook runs
# BEFORE the `cd "$HERE"` below so the self-test operates on the caller's throwaway repo, not this one.
check_tag_coherence() {
  local ver="$1"
  git rev-parse --git-dir >/dev/null 2>&1 || return 0   # no-op outside a git checkout
  if git tag --points-at HEAD 2>/dev/null | grep -qx "v$ver"; then
    return 0
  elif [ "${npm_lifecycle_event:-}" = "prepublishOnly" ]; then
    printf 'publish blocked: HEAD is not tagged v%s — create it first (annotated, like the prior tags): git tag -a v%s -m v%s\n' "$ver" "$ver" "$ver" >&2
    return 1
  else
    printf '\033[33m  ⚠ HEAD is not tagged v%s\033[0m — fine for local validation, but REQUIRED before `npm publish` (prepublishOnly will block).\n' "$ver" >&2
    return 0
  fi
}
read_latest_released_version() {
  grep -m1 -E '^## \[[0-9]+\.[0-9]+\.[0-9]+[^]]*\]' "$1" | sed -E 's/^## \[([^]]+)\].*/\1/'
}
check_changelog_timeline_anchors() {
  node - "$1" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);

const headingSlugs = new Set();
for (const line of lines) {
  const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
  if (!match) continue;
  // GitHub removes punctuation, preserves literal hyphens, then maps each whitespace run to '-'.
  // Thus `[0.2.0] - 2026-06-29` becomes `020---2026-06-29`, with three hyphens.
  const slug = match[1]
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  headingSlugs.add(`#${slug}`);
}

const start = lines.findIndex((line) => /^##\s+Version timeline\s*$/.test(line));
if (start < 0) {
  console.error(`${path}: missing "## Version timeline" section`);
  process.exit(1);
}
let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
if (end < 0) end = lines.length;

let links = 0;
const broken = [];
for (let index = start + 1; index < end; index += 1) {
  for (const match of lines[index].matchAll(/\]\((#[^)]+)\)/g)) {
    links += 1;
    if (!headingSlugs.has(match[1])) broken.push(`${path}:${index + 1}: ${match[1]}`);
  }
}
if (links === 0) {
  console.error(`${path}: Version timeline contains no local anchors`);
  process.exit(1);
}
if (broken.length > 0) {
  console.error(`broken CHANGELOG timeline anchor(s):\n${broken.join("\n")}`);
  process.exit(1);
}
NODE
}
if [ "${1:-}" = "--tag-coherence-check" ]; then
  check_tag_coherence "${2:?usage: ci.sh --tag-coherence-check <version>}"; exit $?
fi
if [ "${1:-}" = "--changelog-version-check" ]; then
  found="$(read_latest_released_version "${2:?usage: ci.sh --changelog-version-check <changelog> <expected-version>}")"
  [ "$found" = "${3:?usage: ci.sh --changelog-version-check <changelog> <expected-version>}" ]
  exit $?
fi
if [ "${1:-}" = "--changelog-anchor-check" ]; then
  check_changelog_timeline_anchors "${2:?usage: ci.sh --changelog-anchor-check <changelog>}"; exit $?
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# Own the durable harness root instead of inheriting TMPDIR. A machine-local TMPDIR once contained an
# unrelated, invalid `.git` marker; package fixtures below it then made Git's root probe fail before a
# genuine non-colocated jj workspace could be recognized. The explicit ceiling makes the harness root
# the VCS boundary, while fixture-local .git directories remain visible below it.
CI_SCRATCH_ROOT="${TRUE_UP_CI_SCRATCH:-$HOME/scratch}"
mkdir -p "$CI_SCRATCH_ROOT"
WORK="$(mktemp -d "$CI_SCRATCH_ROOT/true-up-ci.XXXXXX")"
GIT_CEILING_DIRECTORIES="${GIT_CEILING_DIRECTORIES:+$GIT_CEILING_DIRECTORIES:}$CI_SCRATCH_ROOT"
export GIT_CEILING_DIRECTORIES

# Single trap covers every temp artifact on any exit path (success, failure, or signal).
TGZ=""
cleanup() { rm -rf "$WORK"; [ -n "$TGZ" ] && rm -f "$TGZ" || true; }
trap cleanup EXIT INT TERM

step() { printf '\n\033[1m[%s]\033[0m %s\n' "$1" "$2"; }
fail() { printf '\033[31mCI FAILED:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# GENUINE-NODE PIN (machine-robustness — stays general, hardcodes no paths): npm's CLI is
# `#!/usr/bin/env node`, so if the first `node` on PATH is a NON-Node shim (e.g. a `.bun/bin/node`
# symlink to Bun, or Deno's node compat), `npm install`/`npm publish` crash deep in npm internals —
# observed here as `mod.require is not a function`. The PUBLISHED package is unaffected; this only bites
# the local release gate (and a from-this-shell `npm publish`). So pin the FIRST genuine Node.js already
# on PATH (or $TRUE_UP_NODE) ahead of any shim for the rest of this script — we don't install anything,
# we just prefer a real `node` the user already has. Fail loud if none exists (better than a cryptic
# mid-pack crash — Axiom 14). "never again": a Bun-as-node PATH shadow silently red-failed this gate.
is_genuine_node(){ [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(process.versions.bun||process.versions.deno?1:0)' >/dev/null 2>&1; }
pick_genuine_node(){
  if [ -n "${TRUE_UP_NODE:-}" ] && is_genuine_node "$TRUE_UP_NODE"; then printf '%s\n' "$TRUE_UP_NODE"; return 0; fi
  local n; while IFS= read -r n; do is_genuine_node "$n" && { printf '%s\n' "$n"; return 0; }; done < <(type -aP node 2>/dev/null)
  return 1
}
if ! is_genuine_node "$(command -v node 2>/dev/null)"; then
  NODE_BIN="$(pick_genuine_node)" || fail "the first \`node\` on PATH is a non-Node shim (e.g. Bun) and no genuine Node.js was found — npm's CLI runs under \`env node\` and will crash. Install Node >=18 or set TRUE_UP_NODE=/path/to/real/node, then re-run."
  PATH="$(cd "$(dirname "$NODE_BIN")" && pwd):$PATH"; export PATH
  step "node" "pinned genuine Node.js for the gate (a non-Node \`node\` shim was first on PATH): $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"
fi

# ---------------------------------------------------------------------------
# Self-bootstrap: the Tier-2 symbol tests need the OPTIONAL tree-sitter devDeps. On a fresh clone they're
# absent — `npm test` would SKIP Tier-2 (honest, still green), but the release trust anchor must run the
# FULL suite. Install once if missing (pinned versions, no surprise upgrades). Makes `npm run ci` on a
# bare checkout self-sufficient — the documented "one command" needs no separate `npm install` step.
if [ ! -d node_modules/web-tree-sitter ]; then
  step "0/8" "bootstrap: install optional devDeps (tree-sitter) so Tier-2 tests run"
  npm install --no-package-lock --no-audit --no-fund >/dev/null 2>&1 || fail "devDeps bootstrap (npm install --no-package-lock) failed — run 'npm install --no-package-lock' manually, then re-run"
fi

# ---------------------------------------------------------------------------
step "1/8" "fixture suite + self-gate + contract --check (npm test)"
npm test

# A full clone can accidentally hide a source-test dependency on historical Git objects. Rebuild the
# focused composition CLI source boundary inside a fresh one-commit repository, prove both audited old
# revisions are absent, then run the exact suite from that history-free tree. The immutable runtime
# fixtures are source-test assets only; they intentionally remain outside the published npm allowlist.
HISTORY_FREE_SOURCE="$WORK/history-free-source"
mkdir -p "$HISTORY_FREE_SOURCE/tests/fixtures"
cp -R "$HERE/bin" "$HERE/lib" "$HISTORY_FREE_SOURCE/"
cp "$HERE/package.json" "$HISTORY_FREE_SOURCE/"
cp "$HERE/tests/config-composition-cli.mjs" "$HISTORY_FREE_SOURCE/tests/"
cp -R "$HERE/tests/fixtures/pre-composition" "$HISTORY_FREE_SOURCE/tests/fixtures/"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$HISTORY_FREE_SOURCE" init -q
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$HISTORY_FREE_SOURCE" add -A
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$HISTORY_FREE_SOURCE" \
  -c user.name='true-up history-free CI' -c user.email=tests@true-up.invalid commit -qm snapshot
for old_revision in \
  4eb0e4ddf4eda309857a97a317424c2aea664250 \
  7844b4f77f4cd74f7026edf8f7bf6811c6a11e65; do
  if ( unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_OBJECT_DIRECTORY
       git -C "$HISTORY_FREE_SOURCE" cat-file -e "$old_revision^{commit}" 2>/dev/null ); then
    fail "history-free source control unexpectedly contains old revision $old_revision"
  fi
done
if ! ( unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_OBJECT_DIRECTORY
       TRUE_UP_CONFIG_CLI_TEST_SCRATCH="$WORK/history-free-cli-fixtures" \
         node "$HISTORY_FREE_SOURCE/tests/config-composition-cli.mjs" ) \
  | tee "$WORK/history-free-cli.log"; then
  fail "config composition CLI suite failed from a history-free source snapshot"
fi
grep -qF 'config composition CLI: 9/9 passed; fixtures cleaned=true' "$WORK/history-free-cli.log" \
  || fail "history-free config composition CLI suite did not complete all 9 cases"

# ---------------------------------------------------------------------------
step "2/8" "pack tarball (isolated, never left in repo)"
npm pack --pack-destination "$WORK" >/dev/null
TGZ="$(ls -1 "$WORK"/true-up-*.tgz | tail -1)"
[ -f "$TGZ" ] || fail "npm pack produced no tarball"
# Belt-and-suspenders: ensure no stray .tgz landed in the repo root.
if ls "$HERE"/*.tgz >/dev/null 2>&1; then fail "a .tgz leaked into the repo root"; fi

# ---------------------------------------------------------------------------
step "3/8" "install tarball into a clean sandbox (--omit=optional => lean core)"
SANDBOX="$WORK/sandbox"
mkdir -p "$SANDBOX"
# Capture the install output so a FAILURE shows the REAL npm error, not a generic message. (A muzzled
# `>/dev/null 2>&1` here once hid a `node`-shim `mod.require` crash for an hour — never again: Axiom 14.)
# --no-audit --no-fund: no registry round-trip (Axiom 12 determinism; avoids audit-latency stalls).
if ! ( cd "$SANDBOX" && npm init -y && npm install --no-audit --no-fund --omit=optional "$TGZ" ) >"$WORK/sandbox-install.log" 2>&1; then
  printf '\033[31m--- sandbox install output (the real error): ---\033[0m\n' >&2
  cat "$WORK/sandbox-install.log" >&2
  fail "clean-sandbox install of the tarball failed (real npm error shown above)"
fi
BIN="$SANDBOX/node_modules/.bin/true-up"
[ -x "$BIN" ] || fail "installed bin not found/executable: $BIN"
[ -f "$SANDBOX/node_modules/true-up/lib/engine.mjs" ] || fail "lib/engine.mjs missing from installed package"
[ -f "$SANDBOX/node_modules/true-up/lib/config.mjs" ] || fail "lib/config.mjs missing from installed package"
[ -f "$SANDBOX/node_modules/true-up/lib/symbols.mjs" ] || fail "lib/symbols.mjs missing from installed package"
check_changelog_timeline_anchors "$SANDBOX/node_modules/true-up/CHANGELOG.md" \
  || fail "clean-installed package contains broken CHANGELOG Version timeline anchors"

# ---------------------------------------------------------------------------
step "4/8" "LEAN/RICH check — optional symbol runtime fails loud when absent and works when present"
if [ -e "$SANDBOX/node_modules/web-tree-sitter" ] || [ -e "$SANDBOX/node_modules/tree-sitter-wasms" ]; then
  fail "tree-sitter grammars were pulled into a lean install (peerDependencies + peerDependenciesMeta{optional:true} should keep them out)"
fi
LEAN_SYMBOLS="$WORK/lean-symbols-missing"
mkdir -p "$LEAN_SYMBOLS"
git -C "$LEAN_SYMBOLS" init -q
git -C "$LEAN_SYMBOLS" config user.email t@t >/dev/null
git -C "$LEAN_SYMBOLS" config user.name t >/dev/null
printf '%s\n' '{ "symbols": true, "seed": [{ "from": "README.md", "to": "app.py#main" }] }' > "$LEAN_SYMBOLS/.true-up.json"
printf '%s\n' 'def main():' '    return 0' > "$LEAN_SYMBOLS/app.py"
printf '%s\n' '# lean optional-dependency fixture' > "$LEAN_SYMBOLS/README.md"
git -C "$LEAN_SYMBOLS" add -A && git -C "$LEAN_SYMBOLS" commit -qm init
set +e
lean_symbols_json="$($BIN --repo "$LEAN_SYMBOLS" --no-write --json 2>"$WORK/lean-symbols-missing.stderr")"; lean_symbols_rc=$?
set -e
{ [ "$lean_symbols_rc" -eq 2 ] && printf '%s' "$lean_symbols_json" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===false&&d.kind==="symbols-unavailable"?0:1)'; } \
  || fail "lean installed package did not fail loud with kind=symbols-unavailable when symbols were enabled (rc=$lean_symbols_rc)"

# Repeat the same fixture through the installed tarball with the exact-pinned optional runtime present.
# Copying the already-bootstrapped dependencies keeps this proof offline and leaves the lean sandbox
# intact for every subsequent package-boundary test. The true-up entry itself must still resolve inside
# the rich clean-install tree; only the optional peer packages come from the verified bootstrap.
RICH_SANDBOX="$WORK/sandbox-with-symbols"
cp -R "$SANDBOX" "$RICH_SANDBOX"
for dep in web-tree-sitter tree-sitter-wasms; do
  [ -d "$HERE/node_modules/$dep" ] || fail "exact-pinned optional dependency missing after bootstrap: $dep"
  cp -R "$HERE/node_modules/$dep" "$RICH_SANDBOX/node_modules/"
done
RICH_BIN="$RICH_SANDBOX/node_modules/.bin/true-up"
[ -x "$RICH_BIN" ] || fail "rich installed bin not found/executable: $RICH_BIN"
case "$(realpath "$RICH_BIN")" in
  "$RICH_SANDBOX"/*) ;;
  *) fail "rich installed true-up entry escaped its clean sandbox" ;;
esac
rich_symbols_json="$($RICH_BIN --repo "$LEAN_SYMBOLS" --no-write --json 2>"$WORK/rich-symbols.stderr")" \
  || { cat "$WORK/rich-symbols.stderr" >&2; fail "installed tarball failed with exact-pinned symbol dependencies present"; }
printf '%s' "$rich_symbols_json" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===true&&d.graph?.nodes?.["fact:app.py#main"]?0:1)' \
  || fail "rich installed package did not extract the enabled app.py#main symbol fact"

# ---------------------------------------------------------------------------
step "5/8" "run-from-tarball against a throwaway repo (build/check/gate/no-write/capabilities)"
TARGET="$WORK/target"
mkdir -p "$TARGET"
git -C "$TARGET" init -q
git -C "$TARGET" config user.email t@t >/dev/null
git -C "$TARGET" config user.name t >/dev/null
# A real steward->dependent edge so the gate is non-vacuous: anchored region + fact pointer.
printf '%s\n' 'def add(a, b):  # true-up:anchor id=add-impl' '    return a + b      # true-up:end' > "$TARGET/calc.py"
printf '%s\n' '# Calc' 'Adds two numbers. <!-- fact: calc.py#add-impl -->' > "$TARGET/README.md"
cat > "$TARGET/.true-up.json" <<'JSON'
{ "zones": [{ "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] }] }
JSON
git -C "$TARGET" add -A && git -C "$TARGET" commit -qm init

"$BIN" --repo "$TARGET" >/dev/null            || fail "build (default) failed"
"$BIN" --repo "$TARGET" --check >/dev/null     || fail "--check failed on a fresh graph"
"$BIN" --repo "$TARGET" gate >/dev/null        || fail "gate failed (should PASS on clean repo)"
"$BIN" --repo "$TARGET" capabilities | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.tool!=="true-up")process.exit(1)})' \
  || fail "capabilities did not emit valid JSON"
# --no-write must persist NOTHING (no .true-up/ created) in a separate clean target.
TARGET2="$WORK/target2"
mkdir -p "$TARGET2"; git -C "$TARGET2" init -q
git -C "$TARGET2" config user.email t@t >/dev/null; git -C "$TARGET2" config user.name t >/dev/null
printf '%s\n' '{}' > "$TARGET2/data.json"
cp "$TARGET/.true-up.json" "$TARGET2/.true-up.json"
git -C "$TARGET2" add -A && git -C "$TARGET2" commit -qm init
"$BIN" --repo "$TARGET2" --no-write --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.wrote!==false)process.exit(1)})' \
  || fail "--no-write --json did not report wrote:false"
[ ! -d "$TARGET2/.true-up" ] || fail "--no-write created .true-up/ (statelessness violated)"

# The source entries are covered in tests/engine.sh. Re-run the dedicated stdout, VCS-read, and JSON
# envelope oracles against the CLEAN INSTALLED tarball entry so package boundaries cannot mask drift.
node "$HERE/tests/large-json-transport.mjs" "$BIN" "$WORK/large-json-transport-installed" "$WORK/large-json-transport-installed.json" >/dev/null \
  || fail "installed tarball entry truncated or corrupted >64 KiB structured/human output"
node "$HERE/tests/large-vcs-output.mjs" "$BIN" "$WORK/large-vcs-output-installed" "$WORK/large-vcs-output-installed.json" >/dev/null \
  || fail "installed tarball entry lost or false-cleaned >1 MiB VCS output"
node "$HERE/tests/config-composition-package.mjs" \
  --entry "$BIN" \
  --scratch "$WORK/config-composition-package-installed" \
  --report "$WORK/config-composition-package-installed.json" \
  >"$WORK/config-composition-package-installed.stdout" 2>"$WORK/config-composition-package-installed.stderr" \
  || { cat "$WORK/config-composition-package-installed.stderr" >&2; fail "installed tarball failed native composition positive/negative conformance"; }
PACKAGED_EXAMPLE="$WORK/packaged-composition-example"
cp -R "$SANDBOX/node_modules/true-up/examples/config-composition" "$PACKAGED_EXAMPLE"
git -C "$PACKAGED_EXAMPLE" init -q
git -C "$PACKAGED_EXAMPLE" config user.email t@t >/dev/null
git -C "$PACKAGED_EXAMPLE" config user.name t >/dev/null
git -C "$PACKAGED_EXAMPLE" add -A && git -C "$PACKAGED_EXAMPLE" commit -qm init
"$BIN" --repo "$PACKAGED_EXAMPLE" --no-write --json | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const g=d.graph||{};const sources=(g.configSources||[]).map(x=>x.path);process.exit(d.ok===true&&d.wrote===false&&g.composition?.fragmentCount===2&&sources.includes("config/true-up/core.json")&&sources.includes("config/true-up/docs.json")&&g.nodes?.["fact:data/commands.json#commands.build"]?0:1)' \
  || fail "packaged config-composition example did not build as a coherent no-write graph"
[ ! -d "$PACKAGED_EXAMPLE/.true-up" ] || fail "packaged config-composition example wrote cache state under --no-write"
# The envelope helper derives its entry from its own checkout root. Assemble that root entirely from
# the clean installed package (plus the source-only harness/docs oracle) so no source engine can mask
# a packaging-boundary regression.
JSON_ENVELOPE_INSTALLED="$WORK/json-envelope-contract-installed-root"
mkdir -p "$JSON_ENVELOPE_INSTALLED/tests"
cp "$HERE/tests/json-envelope-contract.mjs" "$JSON_ENVELOPE_INSTALLED/tests/"
cp "$HERE/AGENTS.md" "$JSON_ENVELOPE_INSTALLED/"
cp "$SANDBOX/node_modules/true-up/package.json" "$JSON_ENVELOPE_INSTALLED/"
cp -R "$SANDBOX/node_modules/true-up/bin" "$SANDBOX/node_modules/true-up/lib" "$JSON_ENVELOPE_INSTALLED/"
TRUE_UP_JSON_ENVELOPE_SCRATCH="$WORK/json-envelope-contract-installed" node "$JSON_ENVELOPE_INSTALLED/tests/json-envelope-contract.mjs" >/dev/null \
  || fail "installed tarball entry violated the uniform JSON envelope contract"

# ---------------------------------------------------------------------------
step "6/8" "negative gate check — mutated anchor must report STALE (exit 1)"
printf '%s\n' 'def add(a, b):  # true-up:anchor id=add-impl' '    return a + b + 0  # true-up:end' > "$TARGET/calc.py"
if "$BIN" --repo "$TARGET" --check >/dev/null 2>&1; then
  fail "--check passed after mutating an anchored region (gate is not real)"
fi

# ---------------------------------------------------------------------------
step "7/8" "tarball hygiene — no dev cruft, all runtime files present"
LISTING="$(tar tzf "$TGZ")"
if printf '%s\n' "$LISTING" | grep -Eq '(^|/)(tests/|\.github/|AGENTS\.md|bun\.lock|meta/build-contract\.mjs)|^package/\.true-up\.json$'; then
  printf '%s\n' "$LISTING" | grep -E '(tests/|\.github/|AGENTS\.md|bun\.lock|build-contract|^package/\.true-up\.json$)' >&2
  fail "tarball ships dev cruft (add/fix the \"files\" allowlist)"
fi
for f in package/bin/true-up package/lib/config.mjs package/lib/engine.mjs package/lib/symbols.mjs package/README.md package/LICENSE package/CHANGELOG.md; do
  printf '%s\n' "$LISTING" | grep -qx "$f" || fail "tarball is missing required runtime file: $f"
done
for f in package/workflows/README.md package/workflows/maintenance.workflow.js package/workflows/audit.workflow.js; do
  printf '%s\n' "$LISTING" | grep -qx "$f" || fail "tarball is missing required external-agent workflow file: $f"
done
for f in \
  package/examples/config-composition/.true-up.json \
  package/examples/config-composition/README.md \
  package/examples/config-composition/config/true-up/core.json \
  package/examples/config-composition/config/true-up/docs.json \
  package/examples/config-composition/data/commands.json \
  package/examples/config-composition/docs/commands.md; do
  printf '%s\n' "$LISTING" | grep -qx "$f" || fail "tarball is missing required composed-config example file: $f"
done

# ---------------------------------------------------------------------------
step "8/8" "version coherence — package.json == CHANGELOG top, and (on publish) HEAD is tagged"
PKG_VER="$(node -p 'require("./package.json").version')"
CHANGE_VER="$(read_latest_released_version CHANGELOG.md)"
[ "$PKG_VER" = "$CHANGE_VER" ] || fail "version mismatch: package.json=$PKG_VER CHANGELOG=$CHANGE_VER"
check_changelog_timeline_anchors CHANGELOG.md || fail "source CHANGELOG Version timeline contains broken local anchors"
# TAG COHERENCE: defined at the top of this script (check_tag_coherence) so the guard is one source of
# truth, also reachable via `ci.sh --tag-coherence-check <ver>` for the hermetic regression test. It
# prints the WARN itself on the dev path and the block reason on the publish path; the `|| fail` adds
# the consistent CI-FAILED footer + cleanup-trap exit. HARD-FAIL only under prepublishOnly.
check_tag_coherence "$PKG_VER" || fail "release tag coherence: HEAD is not tagged v$PKG_VER — create it before publish (annotated): git tag -a v$PKG_VER -m v$PKG_VER"

printf '\n\033[32m✓ Local CI passed\033[0m — fixtures + self-gate + contract + pack + clean-sandbox install + lean core + run-from-tarball + real gate + tarball hygiene + version coherence (v%s). Remaining release actions: final commit/tag, registry preflight, npm publish with credentials, then safe-push if authorized.\n' "$PKG_VER"
