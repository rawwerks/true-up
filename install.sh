#!/usr/bin/env bash
# true-up installer — deterministic, git-native truing-up for any repo.
#
#   curl -fsSL https://raw.githubusercontent.com/rawwerks/true-up/main/install.sh?cb=$(date +%s) | bash
#
# Or, from a local checkout (works while the repo is private / pre-release):
#   bash install.sh                      # installs from this checkout
#   bash install.sh --with-symbols       # + optional tree-sitter symbol extraction (Tier 2)
#
# Flags:
#   --with-symbols     also install the OPTIONAL tree-sitter deps (enables "symbols": true)
#   --from <dir>       install from a local true-up checkout instead of fetching
#   --ref <tag>        pin a version/tag when fetching (default: latest)
#   --prefix <dir>     where to symlink the `true-up` launcher  (default: ~/.local/bin)
#   --home <dir>       where to place the tool files            (default: ~/.local/share/true-up)
#   --no-skill         do not install the agent SKILL.md
#   --force            reinstall even if the same version is present
#   --quiet            errors only
#   --no-gum           plain ANSI output (no gum styling)
#   --uninstall        remove true-up (launcher + home + skills)
#   --help             this help
#
# true-up is a Node CLI (no compiled binary): the only requirement is Node >= 18. Tier 1 (span
# anchors) and the whole core are zero-dependency; only `--with-symbols` pulls anything in.
set -euo pipefail
shopt -s lastpipe 2>/dev/null || true
umask 022

# ---------------------------------------------------------------- config + flags
REPO_SLUG="rawwerks/true-up"
RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}"
CODELOAD="https://codeload.github.com/${REPO_SLUG}/tar.gz"
TU_HOME="${TRUEUP_HOME:-$HOME/.local/share/true-up}"
PREFIX="${TRUEUP_PREFIX:-$HOME/.local/bin}"
REF="${TRUEUP_REF:-main}"
SRC_DIR="${TRUEUP_SRC:-}"
WITH_SYMBOLS=0 ; NO_SKILL=0 ; FORCE=0 ; QUIET=0 ; NO_GUM=0 ; DO_UNINSTALL=0
MIN_NODE_MAJOR=18

while [ $# -gt 0 ]; do
  case "$1" in
    --with-symbols) WITH_SYMBOLS=1 ;;
    --from) SRC_DIR="${2:?--from needs a dir}"; shift ;;
    --ref) REF="${2:?--ref needs a tag}"; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a dir}"; shift ;;
    --home) TU_HOME="${2:?--home needs a dir}"; shift ;;
    --no-skill) NO_SKILL=1 ;;
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    --no-gum) NO_GUM=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- output (gum + ANSI fallback)
HAS_GUM=0
if command -v gum >/dev/null 2>&1 && [ -t 1 ]; then HAS_GUM=1; fi
info() { [ "$QUIET" -eq 1 ] && return 0; if [ "$HAS_GUM" -eq 1 ] && [ "$NO_GUM" -eq 0 ]; then gum style --foreground 39 "→ $*"; else printf '\033[0;34m→\033[0m %s\n' "$*"; fi; }
ok()   { [ "$QUIET" -eq 1 ] && return 0; if [ "$HAS_GUM" -eq 1 ] && [ "$NO_GUM" -eq 0 ]; then gum style --foreground 42 "✓ $*"; else printf '\033[0;32m✓\033[0m %s\n' "$*"; fi; }
warn() { [ "$QUIET" -eq 1 ] && return 0; if [ "$HAS_GUM" -eq 1 ] && [ "$NO_GUM" -eq 0 ]; then gum style --foreground 214 "! $*"; else printf '\033[1;33m!\033[0m %s\n' "$*"; fi; }
err()  { if [ "$HAS_GUM" -eq 1 ] && [ "$NO_GUM" -eq 0 ]; then gum style --foreground 196 "✗ $*"; else printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; fi; }
run_step() { local t="$1"; shift; if [ "$HAS_GUM" -eq 1 ] && [ "$NO_GUM" -eq 0 ] && [ "$QUIET" -eq 0 ]; then gum spin --spinner dot --title "$t" -- "$@"; else info "$t"; "$@"; fi; }

draw_box() { # draw_box "title line" "line" ...  — double-line box, ANSI-stripped width
  local lines=("$@") w=0 s
  for s in "${lines[@]}"; do local clean; clean=$(printf '%s' "$s" | sed 's/\x1b\[[0-9;]*m//g'); [ ${#clean} -gt "$w" ] && w=${#clean}; done
  local bar; bar=$(printf '═%.0s' $(seq 1 $((w + 2))))
  printf '╔%s╗\n' "$bar"
  for s in "${lines[@]}"; do local clean; clean=$(printf '%s' "$s" | sed 's/\x1b\[[0-9;]*m//g'); printf '║ %s%*s ║\n' "$s" $((w - ${#clean})) ''; done
  printf '╚%s╝\n' "$bar"
}

# ---------------------------------------------------------------- temp + locking
TMP="$(mktemp -d "${TMPDIR:-/tmp}/true-up-install.XXXXXX")"
LOCK="${TMPDIR:-/tmp}/true-up-install.lock"
cleanup() { rm -rf "$TMP"; rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
if ! mkdir "$LOCK" 2>/dev/null; then err "another true-up install is running (lock: $LOCK). If stale: rmdir '$LOCK'"; exit 1; fi

# ---------------------------------------------------------------- uninstall
if [ "$DO_UNINSTALL" -eq 1 ]; then
  info "Uninstalling true-up"
  [ -L "$PREFIX/true-up" ] && rm -f "$PREFIX/true-up" && ok "removed launcher $PREFIX/true-up"
  [ -d "$TU_HOME" ] && rm -rf "$TU_HOME" && ok "removed $TU_HOME"
  for d in "$HOME/.claude/skills/true-up" "$HOME/.codex/skills/true-up" "$HOME/.gemini/skills/true-up"; do
    [ -d "$d" ] && rm -rf "$d" && ok "removed skill $d"
  done
  ok "true-up uninstalled. (Per-repo .git/hooks and .true-up.json are left untouched — remove them in each repo if desired.)"
  exit 0
fi

# ---------------------------------------------------------------- banner
if [ "$QUIET" -eq 0 ]; then
  if [ "$HAS_GUM" -eq 1 ] && [ "$NO_GUM" -eq 0 ]; then
    gum style --border normal --border-foreground 39 --padding "0 1" --margin "1 0" \
      "$(gum style --foreground 42 --bold 'true-up installer')" \
      "$(gum style --foreground 245 'deterministic, git-native truing-up for any repo')"
  else
    printf '\n\033[1;32mtrue-up installer\033[0m\n\033[0;90mdeterministic, git-native truing-up for any repo\033[0m\n\n'
  fi
fi

# ---------------------------------------------------------------- preflight: node >= 18
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required but not found. Install Node >= ${MIN_NODE_MAJOR} (https://nodejs.org), then re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  err "Node $(node -v) is too old; true-up needs Node >= ${MIN_NODE_MAJOR}."
  exit 1
fi
ok "node $(node -v) (>= ${MIN_NODE_MAJOR})"
mkdir -p "$PREFIX" "$(dirname "$TU_HOME")" || { err "cannot create $PREFIX / $(dirname "$TU_HOME")"; exit 1; }

# ---------------------------------------------------------------- acquire the tool files into $TMP/src
# Auto-detect local checkout when run as `bash install.sh` from a clone (BASH_SOURCE is a real path).
if [ -z "$SRC_DIR" ]; then
  self="${BASH_SOURCE[0]:-$0}"
  if [ -f "$self" ]; then
    cand="$(cd "$(dirname "$self")" && pwd)"
    [ -f "$cand/bin/true-up" ] && [ -f "$cand/lib/engine.mjs" ] && SRC_DIR="$cand"
  fi
fi

SRC=""
if [ -n "$SRC_DIR" ]; then
  [ -f "$SRC_DIR/bin/true-up" ] && [ -f "$SRC_DIR/lib/engine.mjs" ] || { err "--from '$SRC_DIR' is not a true-up checkout"; exit 1; }
  info "Installing from local checkout: $SRC_DIR"
  SRC="$SRC_DIR"
else
  PROXY_ARGS=()
  [ -n "${HTTPS_PROXY:-}" ] && PROXY_ARGS=(--proxy "$HTTPS_PROXY") || { [ -n "${HTTP_PROXY:-}" ] && PROXY_ARGS=(--proxy "$HTTP_PROXY"); }
  info "Fetching true-up @ ${REF} from ${REPO_SLUG}"
  TARBALL="$TMP/true-up.tar.gz"
  fetched=0
  # Tier 1: a published release asset (with checksum) — preferred once releases exist.
  REL="https://github.com/${REPO_SLUG}/releases/download/${REF}/true-up-${REF}.tar.gz"
  if curl -fsSL "${PROXY_ARGS[@]}" "$REL" -o "$TARBALL" 2>/dev/null; then
    if curl -fsSL "${PROXY_ARGS[@]}" "${REL}.sha256" -o "$TMP/sum" 2>/dev/null; then
      expected="$(awk '{print $1}' "$TMP/sum")"
      if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$TARBALL" | awk '{print $1}')"; else actual="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"; fi
      [ "$expected" = "$actual" ] || { err "checksum mismatch for release asset (expected $expected got $actual)"; exit 1; }
      ok "release asset checksum verified"
    else
      warn "no .sha256 alongside the release asset — skipping checksum (publish one for supply-chain safety)"
    fi
    fetched=1
  # Tier 2: codeload source tarball for the ref (no checksum available; archive of the tree).
  elif curl -fsSL "${PROXY_ARGS[@]}" "${CODELOAD}/${REF}" -o "$TARBALL" 2>/dev/null && [ -s "$TARBALL" ]; then
    warn "no release asset; using the source archive for ${REF} (no checksum to verify)"
    fetched=1
  fi
  if [ "$fetched" -ne 1 ]; then
    err "could not fetch true-up. The repo may be private or have no release yet."
    err "From a local checkout instead:  bash install.sh --from /path/to/true-up"
    exit 1
  fi
  mkdir -p "$TMP/x"; tar -xzf "$TARBALL" -C "$TMP/x"
  SRC="$(find "$TMP/x" -maxdepth 4 -name engine.mjs -path '*/lib/*' -exec dirname {} \; | head -1 | xargs dirname 2>/dev/null || true)"
  [ -n "$SRC" ] && [ -f "$SRC/bin/true-up" ] || { err "extracted archive missing bin/true-up + lib/engine.mjs"; exit 1; }
fi

# version that we're installing (best-effort)
NEW_VER="$(node -e 'try{process.stdout.write(require(process.argv[1]).version)}catch{process.stdout.write("0.0.0")}' "$SRC/package.json" 2>/dev/null || echo 0.0.0)"

# already-installed short-circuit (idempotent; still (re)installs the skill below)
if [ "$FORCE" -eq 0 ] && [ -x "$PREFIX/true-up" ]; then
  CUR_VER="$("$PREFIX/true-up" --version 2>/dev/null | awk '{print $2}' || echo '')"
  if [ "$CUR_VER" = "$NEW_VER" ] && [ -n "$CUR_VER" ]; then
    ok "true-up $CUR_VER already installed — use --force to reinstall"
  else
    FORCE=1  # version differs → upgrade
  fi
fi

# ---------------------------------------------------------------- install files + launcher
if [ "$FORCE" -eq 1 ] || [ ! -x "$PREFIX/true-up" ]; then
  run_step "Installing tool files → $TU_HOME" bash -c '
    set -e
    rm -rf "$1.new"; mkdir -p "$1.new"
    cp -R "$2/bin" "$2/lib" "$2/package.json" "$1.new/"
    [ -f "$2/bun.lock" ] && cp "$2/bun.lock" "$1.new/"               # pin Tier 2 deps deterministically
    [ -f "$2/package-lock.json" ] && cp "$2/package-lock.json" "$1.new/"
    [ -f "$2/docs/CONFIG.md" ] && { mkdir -p "$1.new/docs"; cp "$2/docs/CONFIG.md" "$1.new/docs/"; }
    [ -f "$2/SKILL.md" ] && cp "$2/SKILL.md" "$1.new/"
    rm -rf "$1"; mv "$1.new" "$1"
    chmod 0755 "$1/bin/true-up"
  ' _ "$TU_HOME" "$SRC"
  # launcher symlink (atomic via -f)
  ln -sf "$TU_HOME/bin/true-up" "$PREFIX/true-up"
  ok "installed true-up $NEW_VER → $TU_HOME (launcher: $PREFIX/true-up)"
fi

# ---------------------------------------------------------------- optional Tier 2 deps
SYMBOLS_STATUS="skipped (Tier 1 span anchors need no deps; re-run with --with-symbols to enable)"
if [ "$WITH_SYMBOLS" -eq 1 ]; then
  PM=""; command -v bun >/dev/null 2>&1 && PM="bun"; [ -z "$PM" ] && command -v npm >/dev/null 2>&1 && PM="npm"
  if [ -z "$PM" ]; then
    warn "--with-symbols needs npm or bun; neither found. Tier 2 (tree-sitter symbols) NOT enabled."
    SYMBOLS_STATUS="FAILED (no npm/bun)"
  else
    if [ "$PM" = "bun" ]; then run_step "Installing tree-sitter deps (bun)" bash -c 'cd "$1" && bun install' _ "$TU_HOME"; else run_step "Installing tree-sitter deps (npm)" bash -c 'cd "$1" && npm install --omit=dev' _ "$TU_HOME"; fi
    if [ -d "$TU_HOME/node_modules/web-tree-sitter" ] && [ -d "$TU_HOME/node_modules/tree-sitter-wasms" ]; then
      ok "Tier 2 enabled (web-tree-sitter + tree-sitter-wasms)"; SYMBOLS_STATUS="enabled ($PM)"
    else
      warn "tree-sitter deps did not install — Tier 2 not enabled"; SYMBOLS_STATUS="install attempted (unverified)"
    fi
  fi
fi

# ---------------------------------------------------------------- agent SKILL (true-up is repo-scoped:
# we install the SKILL so agents know HOW to use it; we do NOT register a global hook like dcg.)
SKILL_STATUS="skipped"
if [ "$NO_SKILL" -eq 0 ] && [ -f "$TU_HOME/SKILL.md" ]; then
  installed_to=()
  for base in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills"; do
    parent="$(dirname "$base")"
    if [ -d "$parent" ]; then
      mkdir -p "$base/true-up"
      cp "$TU_HOME/SKILL.md" "$base/true-up/SKILL.md"
      installed_to+=("$(basename "$parent")")
    fi
  done
  if [ "${#installed_to[@]}" -gt 0 ]; then SKILL_STATUS="installed → ${installed_to[*]}"; ok "SKILL.md → ${installed_to[*]}"; else SKILL_STATUS="no agents detected"; fi
fi

# ---------------------------------------------------------------- PATH + self-test
PATH_NOTE="on PATH"
case ":$PATH:" in
  *:"$PREFIX":*) : ;;
  *) PATH_NOTE="NOT on PATH — add it:  export PATH=\"$PREFIX:\$PATH\""; warn "$PREFIX is not on your PATH" ;;
esac
if "$PREFIX/true-up" --version >/dev/null 2>&1; then ok "self-test: $("$PREFIX/true-up" --version)"; else err "self-test failed: $PREFIX/true-up --version did not run"; exit 1; fi

# ---------------------------------------------------------------- summary
if [ "$QUIET" -eq 0 ]; then
  echo
  draw_box \
    "true-up $NEW_VER installed" \
    "" \
    "launcher   $PREFIX/true-up  ($PATH_NOTE)" \
    "home       $TU_HOME" \
    "symbols    $SYMBOLS_STATUS" \
    "skill      $SKILL_STATUS" \
    "" \
    "Adopt it in a repo (run inside the target):" \
    "  true-up init             # scaffold .true-up.json" \
    "  true-up hooks --install  # pre-commit + pre-push gate" \
    "  true-up gate             # one CI stage: check + policy + externalities (exit nonzero on any)" \
    "  true-up hooks --ci       # print a CI snippet" \
    "" \
    "Pin a version for deterministic gates:  npx true-up@$NEW_VER (once published)" \
    "Uninstall:  bash install.sh --uninstall"
  echo
fi
