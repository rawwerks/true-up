#!/usr/bin/env bash
# true-up:ignore-file true-up-markers
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
if printf '%s\n' "$LISTING" | grep -Eq '(^|/)(tests/|\.github/|AGENTS\.md|bun\.lock|\.true-up\.json|meta/build-contract\.mjs)'; then
  printf '%s\n' "$LISTING" | grep -E '(tests/|\.github/|AGENTS\.md|bun\.lock|\.true-up\.json|build-contract)' >&2
  fail "tarball ships dev cruft (add/fix the \"files\" allowlist)"
fi
for f in package/bin/true-up package/lib/engine.mjs package/lib/symbols.mjs package/README.md package/LICENSE package/CHANGELOG.md; do
  printf '%s\n' "$LISTING" | grep -qx "$f" || fail "tarball is missing required runtime file: $f"
done
for f in package/workflows/README.md package/workflows/maintenance.workflow.js package/workflows/audit.workflow.js; do
  printf '%s\n' "$LISTING" | grep -qx "$f" || fail "tarball is missing required external-agent workflow file: $f"
done

# ---------------------------------------------------------------------------
step "8/8" "version coherence — package.json == CHANGELOG top, and (on publish) HEAD is tagged"
PKG_VER="$(node -p 'require("./package.json").version')"
CHANGE_VER="$(grep -m1 -E '^## \[' CHANGELOG.md | sed -E 's/^## \[([^]]+)\].*/\1/')"
[ "$PKG_VER" = "$CHANGE_VER" ] || fail "version mismatch: package.json=$PKG_VER CHANGELOG=$CHANGE_VER"
# TAG COHERENCE: a publish must come from a HEAD tagged v$PKG_VER, so the published bytes map to a real
# release commit (the prior gate checked only package.json==CHANGELOG and could not catch an untagged
# publish — audit finding). HARD-FAIL under prepublishOnly (the actual publish path); WARN on a manual
# `npm run ci` so pre-tag dev validation still works. (Run from a Git checkout; skip if no git.)
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git tag --points-at HEAD 2>/dev/null | grep -qx "v$PKG_VER"; then
    :
  elif [ "${npm_lifecycle_event:-}" = "prepublishOnly" ]; then
    fail "publish blocked: HEAD is not tagged v$PKG_VER — create it first (annotated, like the prior tags): git tag -a v$PKG_VER -m v$PKG_VER"
  else
    printf '\033[33m  ⚠ HEAD is not tagged v%s\033[0m — fine for local validation, but REQUIRED before `npm publish` (prepublishOnly will block).\n' "$PKG_VER" >&2
  fi
fi

printf '\n\033[32m✓ Local CI passed\033[0m — fixtures + self-gate + contract + pack + clean-sandbox install + lean core + run-from-tarball + real gate + tarball hygiene + version coherence (v%s). Remaining release actions: final commit/tag, registry preflight, npm publish with credentials, then safe-push if authorized.\n' "$PKG_VER"
