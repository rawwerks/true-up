#!/usr/bin/env bash
# scripts/ci.sh — true-up's TRUSTED LOCAL CI / release gate.
# Tests ARE the harness: one command runs the whole publish-readiness chain and exits
# nonzero on ANY failure. prepublishOnly invokes this, so a broken build cannot publish.
# Sub-minute (npm test dominates). Not dependent on GitHub Actions.
#   Run: npm run ci   (or: bash scripts/ci.sh)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# Single trap covers every temp artifact on any exit path (success, failure, or signal).
WORK="$(mktemp -d)"
TGZ=""
cleanup() { rm -rf "$WORK"; [ -n "$TGZ" ] && rm -f "$TGZ" || true; }
trap cleanup EXIT INT TERM

step() { printf '\n\033[1m[%s]\033[0m %s\n' "$1" "$2"; }
fail() { printf '\033[31mCI FAILED:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "1/8" "fixture suite + self-gate + contract --check (npm test)"
npm test

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
( cd "$SANDBOX" && npm init -y >/dev/null 2>&1 && npm install --omit=optional "$TGZ" >/dev/null 2>&1 ) \
  || fail "clean-sandbox install of the tarball failed"
BIN="$SANDBOX/node_modules/.bin/true-up"
[ -x "$BIN" ] || fail "installed bin not found/executable: $BIN"
[ -f "$SANDBOX/node_modules/true-up/lib/engine.mjs" ] || fail "lib/engine.mjs missing from installed package"
[ -f "$SANDBOX/node_modules/true-up/lib/symbols.mjs" ] || fail "lib/symbols.mjs missing from installed package"

# ---------------------------------------------------------------------------
step "4/8" "LEAN check — tree-sitter grammars must NOT be auto-installed"
if [ -e "$SANDBOX/node_modules/web-tree-sitter" ] || [ -e "$SANDBOX/node_modules/tree-sitter-wasms" ]; then
  fail "tree-sitter grammars were pulled into a lean install (peerDependencies + peerDependenciesMeta{optional:true} should keep them out)"
fi

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

# ---------------------------------------------------------------------------
step "6/8" "negative gate check — mutated anchor must report STALE (exit 1)"
printf '%s\n' 'def add(a, b):  # true-up:anchor id=add-impl' '    return a + b + 0  # true-up:end' > "$TARGET/calc.py"
if "$BIN" --repo "$TARGET" --check >/dev/null 2>&1; then
  fail "--check passed after mutating an anchored region (gate is not real)"
fi

# ---------------------------------------------------------------------------
step "7/8" "tarball hygiene — no dev cruft, all runtime files present"
LISTING="$(tar tzf "$TGZ")"
if printf '%s\n' "$LISTING" | grep -Eq '(^|/)(tests/|\.github/|workflows/|AGENTS\.md|bun\.lock|\.true-up\.json|meta/build-contract\.mjs)'; then
  printf '%s\n' "$LISTING" | grep -E '(tests/|\.github/|workflows/|AGENTS\.md|bun\.lock|\.true-up\.json|build-contract)' >&2
  fail "tarball ships dev cruft (add/fix the \"files\" allowlist)"
fi
for f in package/bin/true-up package/lib/engine.mjs package/lib/symbols.mjs package/README.md package/LICENSE package/CHANGELOG.md; do
  printf '%s\n' "$LISTING" | grep -qx "$f" || fail "tarball is missing required runtime file: $f"
done

# ---------------------------------------------------------------------------
step "8/8" "version coherence — package.json == CHANGELOG top"
PKG_VER="$(node -p 'require("./package.json").version')"
CHANGE_VER="$(grep -m1 -E '^## \[' CHANGELOG.md | sed -E 's/^## \[([^]]+)\].*/\1/')"
[ "$PKG_VER" = "$CHANGE_VER" ] || fail "version mismatch: package.json=$PKG_VER CHANGELOG=$CHANGE_VER"

printf '\n\033[32m✓ Local CI passed\033[0m — fixtures + self-gate + contract + pack + clean-sandbox install + lean core + run-from-tarball + real gate + tarball hygiene + version coherence (v%s). Remaining action: npm publish (creds only).\n' "$PKG_VER"
