#!/usr/bin/env bash
# true-up:ignore-file true-up-markers
# tests/engine.sh — fixture-based regression harness for the true-up engine.
#
# Tests ARE the harness. This builds a SYNTHETIC target repo from scratch and runs the
# real CLI against it via --repo, proving true-up is repo-agnostic (config-driven, not
# wired to its own directory) and pinning every load-bearing invariant + incident guard.
# Fast (<60s). Run: bash tests/engine.sh   (or: npm test)
set -uo pipefail

# HERMETIC ISOLATION (load-bearing safety): this suite runs the REAL `true-up hooks --install`, which
# resolves its target via `git rev-parse --git-path hooks` and therefore HONORS `core.hooksPath`. On a
# machine with a GLOBAL core.hooksPath set, an unisolated run would overwrite the developer's real
# global git hooks (pre-commit/pre-push) — and `hooks --uninstall` would leave them removed. That
# incident is why this block exists: neutralize global/system git config (so hooksDir resolves to each
# throwaway repo's own .git/hooks) and point HOME at a throwaway so nothing reads the dev's real config.
# NEVER remove this — T32b asserts hooks land INSIDE the test repo, which only holds under isolation.
# NOTE: the git-hooks safety is enforced by the GIT_CONFIG_* overrides below (they neutralize global +
# system git config regardless of HOME); the throwaway HOME is defense-in-depth for the dev's dotfiles,
# NOT the load-bearing part. We capture the pre-isolation HOME first because some `jj` installs are
# safety WRAPPERS that resolve their real binary relative to $HOME (e.g. $HOME/.local/lib/jj-real) — such
# a wrapper is non-functional under a throwaway HOME, so the jj probe (below) falls back to this captured
# HOME for the jj subsuite ONLY. This keeps the repo GENERAL (no machine paths in-tree) while letting the
# jj tests actually RUN on a machine whose jj is $HOME-relative, instead of spurious-failing.
ORIG_HOME="$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export HOME="$(mktemp -d)"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TU="node ${HERE}/bin/true-up"
pass=0 ; fail=0 ; skip=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
sk(){ printf '  \033[33mSKIP\033[0m %s\n' "$1"; skip=$((skip + 1)); }
# Optional Tier-2 deps (tree-sitter). Absent on a bare clone → Tier-2 tests SKIP (honest), never FAIL.
# Dir check (NOT `require.resolve` — web-tree-sitter is ESM-only, so require.resolve throws even when present).
HAS_TS=0; { [ -d "$HERE/node_modules/web-tree-sitter" ] && [ -d "$HERE/node_modules/tree-sitter-wasms" ]; } && HAS_TS=1
# jj capability PROBE (not mere presence): prove a WORKING jj and pick the HOME under which it works.
# `command -v jj` succeeding does NOT mean jj functions here — a $HOME-relative jj wrapper fails under the
# throwaway HOME above but works under ORIG_HOME. If jj works nowhere (absent, or broken everywhere) we
# SKIP — a broken/absent jj must NEVER spurious-FAIL the suite (that would falsely block `npm run ci` /
# publish; the engine's jj paths are also exercised directly). Incident: a local jj wrapper hardcoded
# $HOME/.local/lib/jj-real, so the isolated-HOME run failed `jj git init` and FAILED 9 jj tests on a
# machine where jj is actually fine — this probe is the "never again" guard.
jj_works(){ local d; d="$(mktemp -d)"; if HOME="$1" jj git init --no-colocate "$d" >/dev/null 2>&1 && [ -d "$d/.jj" ]; then rm -rf "$d"; return 0; fi; rm -rf "$d"; return 1; }
HAS_JJ=0; JJ_HOME="$HOME"; JJ_SKIP="jj binary not installed"
if command -v jj >/dev/null 2>&1; then
  if   jj_works "$HOME";      then HAS_JJ=1; JJ_HOME="$HOME"
  elif jj_works "$ORIG_HOME"; then HAS_JJ=1; JJ_HOME="$ORIG_HOME"
  else JJ_SKIP="jj present but non-functional under test isolation (e.g. a \$HOME-relative wrapper)"; fi
fi
# Hermetic jj identity (HOME-independent via JJ_CONFIG, which jj honors over all config files): commits in
# the jj subsuite need user.name/email — pin a throwaway identity so the suite is deterministic and never
# depends on (or writes to) the dev's personal jj config, on any machine.
JJCFG="$(mktemp)"; printf '[user]\nname = "true-up tests"\nemail = "tests@true-up.invalid"\n' > "$JJCFG"; export JJ_CONFIG="$JJCFG"

FIX="$(mktemp -d)"; H=""; C=""; CG=""; P=""; E=""; V=""; M=""; IR_SRC=""; IR_DST=""; IR_BAD=""; IR_LIVE=""; IR_UNTRACKED=""; IR_SYM=""; IR_FUZZ=""; S=""; Y=""; Z=""; G=""; K=""; SD=""; MG=""; PD=""; SY=""; WTBASE=""; WTLINK=""; WTCWD=""; CYC=""; JJO=""; JJC=""
trap 'rm -rf "$FIX" "$H" "$C" "$CG" "$P" "$E" "$V" "$M" "$IR_SRC" "$IR_DST" "$IR_BAD" "$IR_LIVE" "$IR_UNTRACKED" "$IR_SYM" "$IR_FUZZ" "$S" "$Y" "$Z" "$G" "$K" "$SD" "$MG" "$PD" "$SY" "$WTBASE" "$WTLINK" "$WTCWD" "$CYC" "$JJO" "$JJC" "$JJCFG"' EXIT

# --- synthesize a target repo: steward data + a generated view + an anchored doc + a symlink ---
git -C "$FIX" init -q
cat > "$FIX/.true-up.json" <<'JSON'
{
  "facts": { "data.json": [["items", "id"]] },
  "zones": [
    { "path": "secret/", "visibility": "private", "audience": "team", "intent": "encrypted-notes", "rules": ["must-be-ciphertext"] },
    { "path": "", "visibility": "public", "audience": "world", "intent": "public-default", "rules": ["no-machine-local-paths"] }
  ],
  "seed": [ { "from": "doc.md", "to": "data.json", "kind": "derives-facts-from" } ]
}
JSON
printf '%s\n' '{ "items": [ { "id": "a", "v": 1 }, { "id": "b", "v": 2 } ] }' > "$FIX/data.json"
printf '%s\n' '# generated view' '<!-- generated by build.mjs from data.json -->' 'a=1 b=2' > "$FIX/gen.md"
printf '%s\n' '# doc' 'item a has value 1.' '<!-- fact: data.json#items.a -->' > "$FIX/doc.md"
ln -s doc.md "$FIX/link.md"
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm init

# T1 — engine runs on a FOREIGN repo via --repo, writes into the target
$TU --repo "$FIX" >/dev/null 2>&1 && ok "build runs on a foreign repo (--repo)" || no "build runs on a foreign repo"
[ -f "$FIX/.true-up/depgraph.json" ] && ok "writes .true-up/depgraph.json into the target" || no "writes depgraph.json into target"
$TU --repo "$FIX" --check >/dev/null 2>&1 && ok "--check passes when in sync" || no "--check passes when in sync"

# T2 — config-driven fact nodes + anchored edge resolve (repo-agnostic)
$TU --repo "$FIX" --impact 'data.json#items.a' 2>/dev/null | grep -q 'doc.md' && ok "anchored fact-edge resolves (doc.md <- data.json#items.a)" || no "anchored fact-edge resolves"

# T2b — `graph`: first-try graph inspection is read-only and emits full nodes/edges JSON.
rm -rf "$FIX/.true-up"
js="$($TU --repo "$FIX" graph --json 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 0 ] && [ ! -e "$FIX/.true-up" ] && printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===true&&d.wrote===false&&d.graph&&d.graph.nodes&&Array.isArray(d.graph.edges)&&d.graph.edges.some(e=>e.from==="file:doc.md")?0:1)'; } && ok "graph: read-only full graph dump (--json) writes nothing" || no "graph --json must dump graph and write nothing (rc=$rc)"
$TU --repo "$FIX" graph 2>/dev/null | grep -q 'dependent -> source-of-truth' && ok "graph: human output renders the edge direction" || no "graph human output must explain edge direction"
$TU --repo "$FIX" >/dev/null 2>&1

# T3/T4 — structural edges from conventions
grep -q 'generated-from' "$FIX/.true-up/depgraph.json" && ok "generated-from edge from self-describing marker" || no "generated-from edge"
grep -q 'alias-of' "$FIX/.true-up/depgraph.json" && ok "symlink alias-of edge (link.md -> doc.md)" || no "symlink alias-of edge"

# T5 — fail-loud on an unresolved fact-anchor
printf '%s\n' '<!-- fact: data.json#items.NOPE -->' > "$FIX/bad.md"
$TU --repo "$FIX" >/dev/null 2>&1 && no "build must FAIL on unresolved anchor" || ok "fail-loud on unresolved anchor"
rm -f "$FIX/bad.md"; $TU --repo "$FIX" >/dev/null 2>&1

# T5b — INCIDENT: anchor/marker EXAMPLES in code formatting (a doc explaining true-up's syntax)
# must NOT be parsed as live anchors (else any repo documenting true-up would fail-loud).
printf '%s\n' '# how-to' 'Anchor inline like `<!-- fact: example.json#x.y -->`, or fenced:' '```' '<!-- fact: another.json#z.w -->' '```' > "$FIX/howto.md"
$TU --repo "$FIX" >/dev/null 2>&1 && ok "anchor examples in code formatting do not fail-loud" || no "anchor examples in code must not fail-loud"
rm -f "$FIX/howto.md"; $TU --repo "$FIX" >/dev/null 2>&1

# T5c — source fixtures can quote true-up marker syntax without becoming live marker data.
printf '%s\n' '# true-up:ignore-file true-up-markers' "printf '%s\n' '# true-up:anchor id=demo' '<!-- fact: missing.json#x -->'" > "$FIX/fixture.sh"
$TU --repo "$FIX" --no-write --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const ns=Object.keys(d.graph.nodes);process.exit(d.ok===true&&ns.includes("file:fixture.sh")&&!ns.some(n=>n.startsWith("fact:fixture.sh#"))?0:1)' && ok "marker suppression: source fixture remains a node but quoted markers are inert" || no "true-up:ignore-file true-up-markers must suppress marker extraction only"
rm -f "$FIX/fixture.sh"; $TU --repo "$FIX" >/dev/null 2>&1

# T6 — externality detection (machine-local leak). NB: --externalities now GATES (exit 1 on a leak),
# so assert on captured OUTPUT, not the pipeline exit (pipefail would otherwise mask the grep).
printf '%s\n' 'path: /home/someuser/x' > "$FIX/leak.md" # true-up:ignore-line no-machine-local-paths
out="$($TU --repo "$FIX" --externalities 2>/dev/null)"; echo "$out" | grep -q '\[high\]' && ok "--externalities flags a /home leak" || no "--externalities flags a leak"
rm -f "$FIX/leak.md"
out="$($TU --repo "$FIX" --externalities 2>/dev/null)"; echo "$out" | grep -q ': 0 (0 high)' && ok "--externalities clean otherwise" || no "--externalities clean otherwise"

# T7 — zone/policy gate clean
$TU --repo "$FIX" --policy 2>/dev/null | grep -q 'policy violations: 0' && ok "--policy reports 0 violations" || no "--policy reports 0 violations"

# T8 — the deterministic true-up loop reaches GREEN on a clean target
$TU --repo "$FIX" run --since HEAD 2>/dev/null | grep -q 'GREEN' && ok "run --since reaches GREEN on a clean repo" || no "run reaches GREEN"

# T9 — HIGH-1: --policy / --externalities are GATES (exit nonzero on violations), with --report opt-out
printf '%s\n' 'see /home/bob/secret/x' > "$FIX/leak2.md" # true-up:ignore-line no-machine-local-paths
$TU --repo "$FIX" --policy >/dev/null 2>&1; rc=$?;        [ "$rc" -ne 0 ] && ok "HIGH-1: --policy EXITS NONZERO on a violation" || no "HIGH-1: --policy must gate"
$TU --repo "$FIX" --externalities >/dev/null 2>&1; rc=$?; [ "$rc" -ne 0 ] && ok "HIGH-1: --externalities EXITS NONZERO on a leak" || no "HIGH-1: --externalities must gate"
$TU --repo "$FIX" --policy --report >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "HIGH-1: --policy --report stays exit 0 (report-only)" || no "HIGH-1: --report must exit 0"
rm -f "$FIX/leak2.md"; $TU --repo "$FIX" >/dev/null 2>&1
$TU --repo "$FIX" --policy >/dev/null 2>&1; rc=$?;        [ "$rc" -eq 0 ] && ok "HIGH-1: --policy exits 0 when clean" || no "--policy must exit 0 when clean"

# T10 — HIGH-2: a machine-local path shown inside CODE formatting (docs explaining a rule) is NOT a leak
printf '%s\n' '# privacy policy' 'We reject paths like `/home/alice/private/` in values.' '```' 'example: /home/bob/scratch/' '```' > "$FIX/privacy.md"
$TU --repo "$FIX" --externalities >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "HIGH-2: /home in inline+fenced code is not flagged (stripCode in detectors)" || no "HIGH-2: code-span paths must not be flagged"
rm -f "$FIX/privacy.md"; $TU --repo "$FIX" >/dev/null 2>&1

# T11 — suppression directives mute a legit path-example in prose; scope is per-line
printf '%s\n' '# notes' 'avoid /home/eve/x/ here <!-- true-up:ignore-line -->' '<!-- true-up:ignore-next no-machine-local-paths -->' 'and /home/eve/y/ here' > "$FIX/sup.md" # true-up:ignore-line no-machine-local-paths
$TU --repo "$FIX" --externalities >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "suppression: ignore-line + ignore-next mute path findings" || no "suppression directives must mute findings"
printf '%s\n' '# true-up:ignore-file no-machine-local-paths' 'leak /home/file-suppress/x' > "$FIX/sup-file.md" # true-up:ignore-line no-machine-local-paths
$TU --repo "$FIX" --externalities >/dev/null 2>&1; rc=$?; [ "$rc" -ne 0 ] && ok "suppression: ignore-file is marker-only and cannot hide leak scanners" || no "ignore-file must not suppress no-machine-local-paths"
rm -f "$FIX/sup-file.md"
printf '%s\n' '# notes' 'and /home/eve/z/ here (no directive)' > "$FIX/sup.md" # true-up:ignore-line no-machine-local-paths
$TU --repo "$FIX" --externalities >/dev/null 2>&1; rc=$?; [ "$rc" -ne 0 ] && ok "suppression is per-line (an unmarked leak still flags)" || no "unmarked leak must still flag"
rm -f "$FIX/sup.md"; $TU --repo "$FIX" >/dev/null 2>&1

# T12 — MED: --impact --since <bad ref> is exit 2, NOT a silent "0 dependents" exit 0
$TU --repo "$FIX" --impact --since deadbeefb0gusref >/dev/null 2>&1; rc=$?; [ "$rc" -eq 2 ] && ok "MED: --impact --since <bad ref> exits 2 (distinct from 0 impact)" || no "bad --since ref must exit 2"

# T13 — HIGH-4: --help and unknown args WRITE NOTHING into the target repo
H="$(mktemp -d)"; git -C "$H" init -q
$TU --repo "$H" --help >/dev/null 2>&1; rc=$?;  { [ "$rc" -eq 0 ] && [ ! -e "$H/.true-up" ]; } && ok "HIGH-4: --help exits 0 and writes nothing" || no "HIGH-4: --help must not write"
$TU --repo "$H" --bogus >/dev/null 2>&1; rc=$?; { [ "$rc" -eq 2 ] && [ ! -e "$H/.true-up" ]; } && ok "HIGH-4: unknown command exits 2 and writes nothing" || no "HIGH-4: unknown arg must exit 2, no write"
$TU --repo "$H" >/dev/null 2>&1; [ -e "$H/.true-up/depgraph.json" ] && ok "build (no args) still writes the graph" || no "build must write"

# T14 — HIGH-3: --check --committed is the real drift gate (untracked / stale committed blob both fail)
C="$(mktemp -d)"; git -C "$C" init -q
printf '%s\n' '{ "items": [ { "id": "a", "v": 1 } ] }' > "$C/data.json"
printf '%s\n' '{ "facts": { "data.json": [["items","id"]] }, "zones": [ {"path":"","visibility":"public","audience":"world","intent":"public","rules":["no-machine-local-paths"]} ], "seed": [] }' > "$C/.true-up.json"
git -C "$C" add -A && git -C "$C" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$C" >/dev/null 2>&1
$TU --repo "$C" --check --committed >/dev/null 2>&1; rc=$?; [ "$rc" -ne 0 ] && ok "HIGH-3: --check --committed FAILS when the graph is untracked" || no "HIGH-3: untracked graph must fail --committed"
$TU --repo "$C" --check >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "HIGH-3: plain --check (working-tree freshness) passes on a fresh on-disk graph" || no "HIGH-3: worktree --check must pass when fresh"
git -C "$C" add .true-up/depgraph.json && git -C "$C" -c user.email=t@t -c user.name=t commit -qm graph
$TU --repo "$C" --check --committed >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "HIGH-3: --check --committed passes when the committed graph is fresh" || no "HIGH-3: fresh committed graph must pass"
printf '%s\n' '{ "items": [ { "id": "a", "v": 999 } ] }' > "$C/data.json"
$TU --repo "$C" --check --committed >/dev/null 2>&1; rc=$?; [ "$rc" -ne 0 ] && ok "HIGH-3: --check --committed catches a STALE committed blob" || no "HIGH-3: stale committed graph must fail"

# T14b — a committed generated graph is allowed even when `.true-up.json` explicitly names the default
# out path. 0.1.1 over-rejected this as "tracked content", breaking the committed-graph discipline.
CG="$(mktemp -d)"; git -C "$CG" init -q
printf '{"out":".true-up/depgraph.json","facts":{"data.json":[["items","id"]]},"seed":[{"from":"doc.md","to":"data.json#items.a"}]}' > "$CG/.true-up.json"
printf '{"items":[{"id":"a","v":1}]}\n' > "$CG/data.json"; printf 'a <!-- fact: data.json#items.a -->\n' > "$CG/doc.md"
$TU --repo "$CG" >/dev/null 2>&1
git -C "$CG" add -A && git -C "$CG" -c user.email=t@t -c user.name=t commit -qm graph
$TU --repo "$CG" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "committed graph: explicit tracked .true-up/depgraph.json remains writable" || no "explicit tracked graph path must not be mistaken for content"
$TU --repo "$CG" gate >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "committed graph: gate accepts explicit tracked .true-up/depgraph.json" || no "gate must not reject an explicit tracked generated graph"
$TU --repo "$CG" gate --committed >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "committed graph: gate --committed accepts explicit tracked .true-up/depgraph.json" || no "gate --committed must not reject an explicit tracked generated graph"

# T15 — LIMITATION fix: a declared (seed) edge to a code file (e.g. .py) is not silently dropped
P="$(mktemp -d)"; git -C "$P" init -q
printf '%s\n' 'def f(): pass' > "$P/registry.py"
printf '%s\n' '# doc' 'derived from the registry' > "$P/doc.md"
printf '%s\n' '{ "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[ {"from":"doc.md","to":"registry.py","kind":"derives-facts-from"} ] }' > "$P/.true-up.json"
git -C "$P" add -A && git -C "$P" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$P" >/dev/null 2>&1
grep -q 'registry.py' "$P/.true-up/depgraph.json" && ok "seed edge to a .py creates a node (edge not dropped)" || no "seed edge to code file must resolve"
$TU --repo "$P" --impact registry.py 2>/dev/null | grep -q 'doc.md' && ok "--impact on a code source shows its dependent" || no "--impact .py must show dependent"

# T15b — graph file universe parity: --verify-scope must see every path build can node. The builder
# includes extensionless bin/* entrypoints; a stale KEEP_RE-only scope filter used to ignore them.
mkdir -p "$P/bin"
printf '%s\n' '#!/usr/bin/env bash' 'echo one' > "$P/bin/tool"
printf '%s\n' '# Tool' 'wrapper docs' > "$P/tool.md"
printf '%s\n' '{ "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[ {"from":"tool.md","to":"bin/tool","kind":"derives-facts-from"} ] }' > "$P/.true-up.json"
git -C "$P" add -A && git -C "$P" -c user.email=t@t -c user.name=t commit -qm bin-tool
$TU --repo "$P" >/dev/null 2>&1
printf '%s\n' '#!/usr/bin/env bash' 'echo two' > "$P/bin/tool"
js="$($TU --repo "$P" --verify-scope --since HEAD --json 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.changed.includes("bin/tool")&&d.explained.includes("tool.md")?0:1)'; } && ok "--verify-scope uses the same file universe as build (extensionless bin/* is guarded)" || no "--verify-scope must not ignore graph-tracked extensionless bin/* files"

# T16 — init scaffolds a config and refuses to clobber one
E="$(mktemp -d)"; git -C "$E" init -q
$TU --repo "$E" init >/dev/null 2>&1; rc=$?; { [ "$rc" -eq 0 ] && [ -f "$E/.true-up.json" ]; } && ok "init scaffolds .true-up.json" || no "init must write .true-up.json"
# init is IDEMPOTENT: re-running never clobbers an existing config (safety) AND exits 0 (not 1 — exit 1
# means a gate FAILED everywhere else; a benign "already scaffolded" must not collide with that).
printf '{"_sentinel":"keep-me"}' > "$E/.true-up.json"
$TU --repo "$E" init >/dev/null 2>&1; rc=$?; { [ "$rc" -eq 0 ] && grep -q 'keep-me' "$E/.true-up.json"; } && ok "init is idempotent (exit 0) and never clobbers an existing config" || no "init must be idempotent + no-clobber"

# T17 — empty-graph NOTICE: distinguish "nothing changed" from "you declared nothing to track"
out="$($TU --repo "$E" 2>&1)"
echo "$out" | grep -q 'NOTICE' && ok "empty-graph NOTICE warns when nothing is declared (inert graph)" || no "must warn on an inert graph"

# T18 — HIGH-3 hygiene: --check --committed on an untracked graph must not leak raw git "fatal:" noise
# (P's graph was built in T15 but never committed -> untracked). stderr only:
err="$($TU --repo "$P" --check --committed 2>&1 1>/dev/null)"
echo "$err" | grep -q 'fatal:' && no "blob() must suppress git fatal: noise on untracked graph" || ok "--check --committed (untracked) emits no raw git fatal: noise"

# T19 — cross-repo hygiene: a stale-graph regenerate hint must be generic, not an ugly ../.. engine path
# (C's on-disk graph is stale after T14 changed data.json). stderr only:
err="$($TU --repo "$C" --check 2>&1 1>/dev/null)"
echo "$err" | grep -q '\.\./\.\.' && no "cross-repo regenerate hint leaks a ../.. path" || ok "cross-repo regenerate hint is generic (no ../.. path)"

# T20 — --verify-scope: the deterministic anti-code-golf gate (empirically: unguarded LLMs hit the decoy 3/3)
V="$(mktemp -d)"; git -C "$V" init -q
printf '%s\n' '{ "items": [ { "id": "a", "v": 1 } ] }' > "$V/data.json"
printf '%s\n' '# dep' 'a is 1 <!-- fact: data.json#items.a -->' > "$V/dep.md"
printf '%s\n' '# leaf' 'a is mentioned here but is not anchored to any fact.' > "$V/leaf.md"
printf '%s\n' '{ "facts": { "data.json": [["items","id"]] }, "zones": [ {"path":"","visibility":"public","audience":"world","intent":"public","rules":[]} ], "seed": [] }' > "$V/.true-up.json"
node "$TU" --repo "$V" >/dev/null 2>&1
git -C "$V" add -A && git -C "$V" -c user.email=t@t -c user.name=t commit -qm good
# in-scope maintenance: move the fact + update ONLY its anchored dependent
printf '%s\n' '{ "items": [ { "id": "a", "v": 2 } ] }' > "$V/data.json"
printf '%s\n' '# dep' 'a is 2 <!-- fact: data.json#items.a -->' > "$V/dep.md"
$TU --repo "$V" --verify-scope --since HEAD >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "--verify-scope PASSES when edits stay in the blast radius" || no "--verify-scope must pass in-scope edits"
# now ALSO edit the unanchored leaf (the decoy) -> out of scope -> FAIL, naming it
printf '%s\n' '# leaf' 'a is 2 now (an out-of-scope tidy).' > "$V/leaf.md"
out="$($TU --repo "$V" --verify-scope --since HEAD 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'leaf.md'; } && ok "--verify-scope FAILS on an out-of-blast-radius (code-golf) edit, naming it" || no "--verify-scope must catch out-of-scope edits"

# T21 — must-be-ciphertext is STRUCTURE-AWARE: a plaintext file that merely MENTIONS sops must FAIL
M="$(mktemp -d)"; git -C "$M" init -q; mkdir -p "$M/private"
printf '%s\n' '# notes' 'we use sops to encrypt this directory.' > "$M/private/notes.md"
printf '%s\n' '{ "zones": [ {"path":"private/","visibility":"private","audience":"team","intent":"enc","rules":["must-be-ciphertext"]}, {"path":"","visibility":"public","audience":"world","intent":"pub","rules":[]} ] }' > "$M/.true-up.json"
git -C "$M" add -A && git -C "$M" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$M" --policy --report 2>&1 | grep -q 'must-be-ciphertext' && ok "must-be-ciphertext FLAGS plaintext that merely mentions 'sops'" || no "must-be-ciphertext must reject plaintext mentioning sops"
printf '%s\n' 'data: ENC[AES256_GCM,data:Zm9v,iv:YmFy,tag:YmF6,type:str]' 'sops:' '    mac: ENC[AES256_GCM,data:abc,type:str]' > "$M/private/notes.md"
$TU --repo "$M" --policy --report 2>&1 | grep -q 'must-be-ciphertext' && no "real ENC[…] ciphertext must pass must-be-ciphertext" || ok "real ENC[…] ciphertext passes must-be-ciphertext"

# T22 — ergonomics: --version + capabilities (the machine-readable contract, Axiom 9)
$TU --repo "$FIX" --version 2>&1 | grep -qE '[0-9]+\.[0-9]+' && ok "--version prints a version" || no "--version must print a version"
$TU --repo "$FIX" capabilities 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.exit_codes&&d.commands&&d.version?0:1)' && ok "capabilities is valid JSON with version/commands/exit_codes" || no "capabilities must be a valid JSON contract"

# T23 — ergonomics: --json on read-side gates is pure, valid JSON on stdout (Axiom 8/4)
$TU --repo "$FIX" --policy --json --report 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(Array.isArray(d.violations)&&typeof d.count==="number"?0:1)' && ok "--policy --json is valid structured JSON" || no "--policy --json must be valid JSON"
$TU --repo "$FIX" --externalities --json --report 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(Array.isArray(d.hits)?0:1)' && ok "--externalities --json is valid structured JSON" || no "--externalities --json must be valid JSON"
$TU --repo "$FIX" --impact --json 'data.json#items.a' 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(Array.isArray(d.advisory)?0:1)' && ok "--impact --json is valid structured JSON" || no "--impact --json must be valid JSON"

# T23b — INTER-REPO PRIVACY: federation is explicit exported/imported SNAPSHOTS, never live ../ reads.
# Public export is allowlist-only and path-minimizing: the exported snapshot contains stable public ids
# + hashes, but not raw private source paths/fact names/topology.
IR_SRC="$(mktemp -d)"; git -C "$IR_SRC" init -q; mkdir -p "$IR_SRC/secret"
cat > "$IR_SRC/.true-up.json" <<'JSON'
{
  "repoId": "payments-service",
  "facts": { "secret/internal.json": [["items", "id"]] },
  "zones": [
    { "path": "secret/", "visibility": "private", "audience": "team", "intent": "private-source", "rules": [] },
    { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] }
  ],
  "exports": [
    { "id": "api.timeout", "from": "secret/internal.json#items.timeout", "audience": "public", "declassify": true },
    { "id": "internal.discount", "from": "secret/internal.json#items.discount", "audience": "internal", "declassify": true }
  ]
}
JSON
printf '%s\n' '{ "items": [ { "id": "timeout", "ms": 30000 }, { "id": "discount", "rate": 0.4 } ] }' > "$IR_SRC/secret/internal.json"
git -C "$IR_SRC" add -A && git -C "$IR_SRC" -c user.email=t@t -c user.name=t commit -qm init
pubsnap="$IR_SRC/public.true-up-import.json"
$TU --repo "$IR_SRC" export --audience public > "$pubsnap" 2>/dev/null; rc=$?
{ [ "$rc" -eq 0 ] && node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");const d=JSON.parse(s);process.exit(d.kind==="true-up-import-snapshot"&&d.repoId==="payments-service"&&d.audience==="public"&&d.facts["api.timeout"]&&!d.facts["internal.discount"]&&!("sourceCommit" in d)&&!s.includes("secret/internal.json")&&!s.includes("discount")?0:1)' "$pubsnap"; } && ok "inter-repo export: public snapshot is allowlist-only and does not leak private paths/facts/commit ids" || no "public export must be explicit and path-minimizing"

# Exporting a private source fact to a lower audience is allowed only with explicit declassification.
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));delete d.exports[0].declassify;fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$IR_SRC/.true-up.json"
out="$($TU --repo "$IR_SRC" export --audience public 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'declassify'; } && ok "inter-repo privacy: private-source public export requires explicit declassify:true" || no "private-to-public export must require explicit declassification"
git -C "$IR_SRC" checkout -- .true-up.json 2>/dev/null

# Visibility is the enforceable privacy lattice. Unknown labels must fail closed instead of silently
# downgrading a private-ish source to public.
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.zones[0].visibility="team";delete d.exports[0].declassify;fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$IR_SRC/.true-up.json"
out="$($TU --repo "$IR_SRC" export --audience public 2>&1)"; rc=$?
{ [ "$rc" -eq 2 ] && echo "$out" | grep -q 'visibility'; } && ok "inter-repo privacy: unknown zone visibility fails closed, not public" || no "unknown visibility must not downgrade to public"
git -C "$IR_SRC" checkout -- .true-up.json 2>/dev/null

# Failed public-export JSON must not echo private source paths/fact keys.
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.exports=[{id:"api.missing",from:"secret/internal.json#items.missing",audience:"public",declassify:true}];fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$IR_SRC/.true-up.json"
out="$($TU --repo "$IR_SRC" export --audience public --json 2>/dev/null)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'api.missing' && ! echo "$out" | grep -q 'secret/' && ! echo "$out" | grep -q '#items'; } && ok "inter-repo privacy: public export JSON errors do not leak private source paths" || no "public export errors must be path-minimized"
git -C "$IR_SRC" checkout -- .true-up.json 2>/dev/null

# Public export must also sanitize generic graph-build errors before they reach JSON stdout. A bad seed
# used to leak `secret/internal.json#items.missing` via failGraphBuildIfNeeded().
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.seed=[{from:"secret/internal.json",to:"secret/internal.json#items.missing",kind:"derives-facts-from"}];fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$IR_SRC/.true-up.json"
out="$($TU --repo "$IR_SRC" export --audience public --json 2>/dev/null)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'graph-build-errors' && ! echo "$out" | grep -q 'secret/' && ! echo "$out" | grep -q '#items'; } && ok "inter-repo privacy: public export graph-build errors are sanitized" || no "public export graph-build errors must not leak private source paths"
git -C "$IR_SRC" checkout -- .true-up.json 2>/dev/null

# A consumer repo imports the snapshot as a read-only namespace and declares a marker-free edge to it.
IR_DST="$(mktemp -d)"; git -C "$IR_DST" init -q; mkdir -p "$IR_DST/imports"
cp "$pubsnap" "$IR_DST/imports/payments.true-up.json"
printf '%s\n' '# consumer' 'timeout is documented here.' > "$IR_DST/README.md"
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "imports": { "payments": { "path": "imports/payments.true-up.json", "repoId": "payments-service", "audience": "public" } },
  "zones": [ { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] } ],
  "seed": [ { "from": "README.md", "to": "@payments:api.timeout", "kind": "derives-facts-from" } ]
}
JSON
git -C "$IR_DST" add -A && git -C "$IR_DST" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$IR_DST" build >/dev/null 2>&1 && ok "inter-repo import: build resolves a namespaced imported fact snapshot" || no "imported snapshot fact must resolve"
$TU --repo "$IR_DST" --impact '@payments:api.timeout' 2>/dev/null | grep -q 'README.md' && ok "inter-repo import: --impact on @alias:fact lists local dependents" || no "--impact must accept imported fact targets"

# Imported snapshots are ordinary tracked inputs: editing a referenced imported fact stales dependents,
# while editing an unrelated fact in the same imported snapshot does not.
git -C "$IR_DST" add -A && git -C "$IR_DST" -c user.email=t@t -c user.name=t commit -qm imported-base
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.facts["api.unrelated"]={hash:"unrelated1",audience:"public",visibility:"public",kind:"imported-fact",taint:[]};fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$IR_DST/imports/payments.true-up.json"
$TU --repo "$IR_DST" build >/dev/null 2>&1
$TU --repo "$IR_DST" --impact --since HEAD 2>/dev/null | grep -q 'README.md' && no "inter-repo import: unrelated imported fact change must not stale README (early-cutoff)" || ok "inter-repo import: unrelated imported fact change does not stale dependent"
git -C "$IR_DST" checkout -- imports/payments.true-up.json 2>/dev/null
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.facts["api.timeout"].hash="changed-timeout";fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$IR_DST/imports/payments.true-up.json"
$TU --repo "$IR_DST" build >/dev/null 2>&1
$TU --repo "$IR_DST" --impact --since HEAD 2>/dev/null | grep -q 'README.md' && ok "inter-repo import: changed imported fact stales dependent via --since" || no "imported fact hash change must stale dependent"
git -C "$IR_DST" checkout -- imports/payments.true-up.json 2>/dev/null; $TU --repo "$IR_DST" build >/dev/null 2>&1

# Namespaces are not paths. Aliases with traversal/separators/reserved words fail loud.
printf '%s\n' '{ "imports": { "../bad": { "path": "imports/payments.true-up.json" } }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$IR_DST/.true-up.json"
out="$($TU --repo "$IR_DST" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'import alias'; } && ok "inter-repo privacy: import alias validation rejects traversal/separators" || no "bad import aliases must fail loud"
git -C "$IR_DST" checkout -- .true-up.json 2>/dev/null

# Import declarations must pin both sides of the mirror: a repo identity and the audience exported.
printf '%s\n' '{ "imports": { "payments": { "path": "imports/payments.true-up.json", "repoId": "payments-service" } }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$IR_DST/.true-up.json"
out="$($TU --repo "$IR_DST" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'audience'; } && ok "inter-repo handshake: consumer import must pin exported audience" || no "imports must require an explicit audience pin"
printf '%s\n' '{ "imports": { "payments": { "path": "imports/payments.true-up.json", "audience": "public" } }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$IR_DST/.true-up.json"
out="$($TU --repo "$IR_DST" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'repoId'; } && ok "inter-repo handshake: consumer import must pin source repoId" || no "imports must require an explicit repoId pin"
git -C "$IR_DST" checkout -- .true-up.json 2>/dev/null

# This is a one-way mirror, not a live bidirectional relationship: the source exports for an audience
# without knowing consumers, while the consumer pins the source identity/audience it agreed to mirror.
printf '%s\n' '{ "imports": { "payments": { "path": "imports/payments.true-up.json", "repoId": "wrong-repo", "audience": "public" } }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$IR_DST/.true-up.json"
out="$($TU --repo "$IR_DST" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'repoId'; } && ok "inter-repo handshake: consumer-pinned repoId mismatch fails loud" || no "import repoId mismatch must fail loud"
printf '%s\n' '{ "imports": { "payments": { "path": "imports/payments.true-up.json", "repoId": "payments-service", "audience": "internal" } }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$IR_DST/.true-up.json"
out="$($TU --repo "$IR_DST" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'audience'; } && ok "inter-repo handshake: consumer-pinned audience mismatch fails loud" || no "import audience mismatch must fail loud"
git -C "$IR_DST" checkout -- .true-up.json 2>/dev/null

# Non-public imported facts are allowed as graph data, but a public local file depending on them is a
# policy violation. This is cross-repo no-public->private-deps, not a raw path heuristic.
intsnap="$IR_SRC/internal.true-up-import.json"
$TU --repo "$IR_SRC" export --audience internal > "$intsnap" 2>/dev/null
cp "$intsnap" "$IR_DST/imports/payments-internal.true-up.json"
git -C "$IR_DST" add imports/payments-internal.true-up.json
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "imports": { "payint": { "path": "imports/payments-internal.true-up.json", "repoId": "payments-service", "audience": "internal" } },
  "zones": [ { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] } ],
  "seed": [ { "from": "README.md", "to": "@payint:internal.discount", "kind": "derives-facts-from" } ]
}
JSON
$TU --repo "$IR_DST" build >/dev/null 2>&1 && ok "inter-repo import: build may model an internal imported fact" || no "internal import should build so policy can gate it"
out="$($TU --repo "$IR_DST" --policy 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'no-public->nonpublic-import'; } && ok "inter-repo privacy: public files cannot depend on internal imported facts" || no "policy must block public -> internal imported fact"

# Non-public import taint must propagate through local files too; a public file cannot depend on an
# internal local summary that derives from an internal import.
mkdir -p "$IR_DST/internal"
printf '%s\n' '# internal summary' > "$IR_DST/internal/summary.md"
printf '%s\n' '# consumer' 'summary reference' > "$IR_DST/README.md"
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "imports": { "payint": { "path": "imports/payments-internal.true-up.json", "repoId": "payments-service", "audience": "internal" } },
  "zones": [
    { "path": "internal/", "visibility": "internal", "audience": "team", "intent": "internal", "rules": [] },
    { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] }
  ],
  "seed": [
    { "from": "internal/summary.md", "to": "@payint:internal.discount", "kind": "derives-facts-from" },
    { "from": "README.md", "to": "internal/summary.md", "kind": "derives-facts-from" }
  ]
}
JSON
$TU --repo "$IR_DST" build >/dev/null 2>&1 && ok "inter-repo import: transitive local taint fixture builds" || no "transitive import taint fixture should build"
out="$($TU --repo "$IR_DST" --policy 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'tainted by payint'; } && ok "inter-repo privacy: imported taint propagates through local files into policy" || no "policy must block public -> local -> internal import"

# Effective imported visibility includes snapshot taint/visibility, not just the fact audience string.
cat > "$IR_DST/imports/payments-tainted.true-up.json" <<'JSON'
{
  "kind": "true-up-import-snapshot",
  "repoId": "payments-service",
  "audience": "public",
  "facts": {
    "tainted.public": {
      "hash": "tainted1",
      "audience": "public",
      "visibility": "public",
      "kind": "imported-fact",
      "taint": [ { "alias": "upstream", "repoId": "upstream-private", "audience": "internal", "id": "secret.fact" } ]
    }
  }
}
JSON
git -C "$IR_DST" add imports/payments-tainted.true-up.json
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "imports": { "tainted": { "path": "imports/payments-tainted.true-up.json", "repoId": "payments-service", "audience": "public" } },
  "zones": [ { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] } ],
  "seed": [ { "from": "README.md", "to": "@tainted:tainted.public", "kind": "derives-facts-from" } ]
}
JSON
$TU --repo "$IR_DST" build >/dev/null 2>&1 && ok "inter-repo import: tainted public-looking snapshot builds for policy review" || no "tainted public-looking import should build so policy can gate it"
out="$($TU --repo "$IR_DST" --policy 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'no-public->nonpublic-import'; } && ok "inter-repo privacy: imported taint blocks public local dependency even when fact audience says public" || no "policy must use effective imported taint, not only fact audience"

# Malformed public snapshots must not smuggle commit ids, raw values, private paths, or arbitrary taint
# fields into graph JSON.
cat > "$IR_DST/imports/payments-malformed.true-up.json" <<'JSON'
{
  "kind": "true-up-import-snapshot",
  "repoId": "payments-service",
  "audience": "public",
  "sourceCommit": "deadbeef",
  "secret/internal.json": "poison-key",
  "facts": {
    "malformed.public": {
      "hash": "mal1",
      "audience": "public",
      "visibility": "public",
      "kind": "imported-fact",
      "taint": [ { "alias": "upstream", "repoId": "upstream-private", "audience": "internal", "id": "secret/internal.json#x", "path": "machine-local-secret-path", "raw": "raw-secret" } ]
    }
  }
}
JSON
git -C "$IR_DST" add imports/payments-malformed.true-up.json
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "imports": { "malformed": { "path": "imports/payments-malformed.true-up.json", "repoId": "payments-service", "audience": "public" } },
  "zones": [ { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] } ],
  "seed": []
}
JSON
out="$($TU --repo "$IR_DST" graph --json 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && ! echo "$out" | grep -q 'machine-local-secret-path' && ! echo "$out" | grep -q 'raw-secret' && ! echo "$out" | grep -q 'secret/internal'; } && ok "inter-repo privacy: malformed public snapshots cannot smuggle private metadata into graph output" || no "malformed public snapshot metadata must fail closed without echoing payload"
out="$($TU --repo "$IR_DST" --policy 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && ! echo "$out" | grep -q 'machine-local-secret-path' && ! echo "$out" | grep -q 'raw-secret' && ! echo "$out" | grep -q 'secret/internal'; } && ok "inter-repo privacy: policy fails closed on malformed import snapshots" || no "policy must not pass when import snapshot parsing/build has failed"

# Import snapshots must be local, in-repo artifacts. A path escape would turn gates into live sibling-repo
# reads and leak local topology, so it fails loud before any graph can pass.
IR_BAD="$(mktemp -d)"; git -C "$IR_BAD" init -q
printf '%s\n' '# bad' > "$IR_BAD/README.md"
printf '%s\n' '{ "imports": { "bad": { "path": "../other/export.json" } }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$IR_BAD/.true-up.json"
git -C "$IR_BAD" add -A && git -C "$IR_BAD" -c user.email=t@t -c user.name=t commit -qm init
out="$($TU --repo "$IR_BAD" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'import' && echo "$out" | grep -q 'outside repo'; } && ok "inter-repo privacy: import snapshot path escapes fail loud" || no "import paths must be confined to the repo"

# Import snapshots must be staged/committed local files, not invisible untracked agreement.
IR_UNTRACKED="$(mktemp -d)"; git -C "$IR_UNTRACKED" init -q; mkdir -p "$IR_UNTRACKED/imports"
cp "$pubsnap" "$IR_UNTRACKED/imports/payments.true-up.json"
printf '%s\n' '# untracked import' > "$IR_UNTRACKED/README.md"
cat > "$IR_UNTRACKED/.true-up.json" <<'JSON'
{
  "imports": { "payments": { "path": "imports/payments.true-up.json", "repoId": "payments-service", "audience": "public" } },
  "zones": [ { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] } ],
  "seed": [ { "from": "README.md", "to": "@payments:api.timeout" } ]
}
JSON
git -C "$IR_UNTRACKED" add .true-up.json README.md && git -C "$IR_UNTRACKED" -c user.email=t@t -c user.name=t commit -qm init
out="$($TU --repo "$IR_UNTRACKED" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'not tracked'; } && ok "inter-repo privacy: import snapshot must be tracked/staged, not untracked" || no "untracked import snapshot must fail loud"

# A tracked symlink inside imports/ must not be followed to a live sibling checkout.
IR_SYM="$(mktemp -d)"; git -C "$IR_SYM" init -q; mkdir -p "$IR_SYM/imports" "$IR_SYM/sibling"
cp "$pubsnap" "$IR_SYM/sibling/live.true-up-import.json"
ln -s ../sibling/live.true-up-import.json "$IR_SYM/imports/live.true-up-import.json"
printf '%s\n' '# symlink import' > "$IR_SYM/README.md"
cat > "$IR_SYM/.true-up.json" <<'JSON'
{
  "imports": { "payments": { "path": "imports/live.true-up-import.json", "repoId": "payments-service", "audience": "public" } },
  "zones": [ { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] } ],
  "seed": [ { "from": "README.md", "to": "@payments:api.timeout" } ]
}
JSON
git -C "$IR_SYM" add .true-up.json README.md imports/live.true-up-import.json && git -C "$IR_SYM" -c user.email=t@t -c user.name=t commit -qm init
out="$($TU --repo "$IR_SYM" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'symlink'; } && ok "inter-repo privacy: import snapshot symlink is rejected (no live sibling mirror)" || no "symlinked import snapshot must fail loud"

# Direct live ../ seed endpoints remain rejected; users must import a sanitized snapshot instead.
IR_LIVE="$(mktemp -d)"; git -C "$IR_LIVE" init -q
printf '%s\n' '# live' > "$IR_LIVE/README.md"
printf '%s\n' "{ \"zones\":[{\"path\":\"\",\"visibility\":\"public\",\"audience\":\"world\",\"intent\":\"public\",\"rules\":[]}], \"seed\":[{\"from\":\"README.md\",\"to\":\"../$(basename "$IR_SRC")/secret/internal.json\",\"kind\":\"derives-facts-from\"}] }" > "$IR_LIVE/.true-up.json"
git -C "$IR_LIVE" add -A && git -C "$IR_LIVE" -c user.email=t@t -c user.name=t commit -qm init
out="$($TU --repo "$IR_LIVE" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'not tracked / not found'; } && ok "inter-repo privacy: live ../ seed dependency is rejected" || no "live sibling-repo seed must not be accepted"

# Imported mechanical/generator metadata is inert: true-up run must never execute a `via` that arrived
# from an import snapshot.
cat > "$IR_DST/imports/payments.true-up.json" <<'JSON'
{
  "kind": "true-up-import-snapshot",
  "repoId": "payments-service",
  "audience": "public",
  "facts": {
    "generated.table": {
      "hash": "gen1",
      "audience": "public",
      "visibility": "public",
      "kind": "generated-from",
      "via": "scripts/evil.sh",
      "taint": []
    }
  }
}
JSON
printf '%s\n' '# generated table' > "$IR_DST/README.md"
printf '%s\n' 'SHOULD_NOT_RUN' > "$IR_DST/sentinel.txt"
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "imports": { "payments": { "path": "imports/payments.true-up.json", "repoId": "payments-service", "audience": "public" } },
  "zones": [ { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] } ],
  "seed": [ { "from": "README.md", "to": "@payments:generated.table", "kind": "generated-from", "via": "scripts/evil.sh" } ]
}
JSON
git -C "$IR_DST" add -A && git -C "$IR_DST" -c user.email=t@t -c user.name=t commit -qm imported-generator
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.facts["generated.table"].hash="gen2";fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$IR_DST/imports/payments.true-up.json"
out="$($TU --repo "$IR_DST" build 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && ! echo "$out" | grep -q 'scripts/evil' && ! echo "$out" | grep -q 'via' && grep -q 'SHOULD_NOT_RUN' "$IR_DST/sentinel.txt"; } && ok "inter-repo safety: imported/generated metadata is rejected without echoing executable fields" || no "imported generators must be fail-closed and never execute"

# Taint propagation: after importing internal facts, a local private summary derived from them cannot be
# re-exported to a lower (public) audience.
mkdir -p "$IR_DST/private"
printf '%s\n' '# private summary' 'discount details' > "$IR_DST/private/summary.md"
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "repoId": "consumer-service",
  "imports": { "payint": { "path": "imports/payments-internal.true-up.json", "repoId": "payments-service", "audience": "internal" } },
  "zones": [
    { "path": "private/", "visibility": "private", "audience": "team", "intent": "private", "rules": [] },
    { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] }
  ],
  "seed": [ { "from": "private/summary.md", "to": "@payint:internal.discount", "kind": "derives-facts-from" } ],
  "exports": [ { "id": "summary.discount", "from": "private/summary.md", "audience": "public", "declassify": true } ]
}
JSON
out="$($TU --repo "$IR_DST" export --audience public 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'taint' && echo "$out" | grep -q 'payint'; } && ok "inter-repo privacy: internal-import taint blocks public re-export" || no "public export must reject local artifacts tainted by internal imports"

# Fact nodes extracted from a tainted local file inherit the file's import taint. Exporting the fact
# directly must not wash the taint away.
mkdir -p "$IR_DST/secure"
printf '%s\n' '{ "items": [ { "id": "summary", "text": "discount summary" } ] }' > "$IR_DST/secure/summary.json"
cat > "$IR_DST/.true-up.json" <<'JSON'
{
  "repoId": "consumer-service",
  "facts": { "secure/summary.json": [["items", "id"]] },
  "imports": { "payint": { "path": "imports/payments-internal.true-up.json", "repoId": "payments-service", "audience": "internal" } },
  "zones": [
    { "path": "secure/", "visibility": "private", "audience": "team", "intent": "private", "rules": [] },
    { "path": "", "visibility": "public", "audience": "world", "intent": "public", "rules": [] }
  ],
  "seed": [ { "from": "secure/summary.json", "to": "@payint:internal.discount", "kind": "derives-facts-from" } ],
  "exports": [ { "id": "summary.fact", "from": "secure/summary.json#items.summary", "audience": "public", "declassify": true } ]
}
JSON
out="$($TU --repo "$IR_DST" export --audience public 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'taint' && echo "$out" | grep -q 'payint'; } && ok "inter-repo privacy: local fact exports inherit host-file import taint" || no "fact export must not wash host file import taint"

# Deterministic structure-aware fuzzing around the import/export boundary. This is intentionally not
# byte-random: the parser boundary is JSON config/snapshot shape, so we mutate schema-valid-ish objects
# and assert the privacy invariants that must hold for every accepted case.
IR_FUZZ="$(mktemp -d)"
node - "$HERE" "$IR_FUZZ" <<'NODE'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const here = process.argv[2]
const root = process.argv[3]
const tool = path.join(here, 'bin/true-up')
const poison = ['secret/internal.json', 'machine-local-secret-path', 'raw-secret', 'deadbeefcafebabe', 'vip-private-value']
let seed = 0x5eed1234
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x100000000
}
function pick(xs) { return xs[Math.floor(rnd() * xs.length)] }
function shuffleObj(obj) {
  const out = {}
  for (const k of Object.keys(obj).sort(() => rnd() - 0.5)) out[k] = obj[k]
  return out
}
function run(args, cwd) {
  return spawnSync(process.execPath, [tool, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
}
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
}
function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function assertNoPoison(text, label) {
  for (const p of poison) assert(!String(text).includes(p), `${label} leaked ${p}`)
}
function initRepo(name) {
  const repo = path.join(root, name)
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 't'])
  return repo
}
function baseSnapshot(id, audience = 'public', extras = {}) {
  return shuffleObj({
    kind: 'true-up-import-snapshot',
    repoId: 'payments-service',
    audience,
    facts: {
      [id]: shuffleObj({
        hash: `h${Math.floor(rnd() * 1e9).toString(16)}`,
        audience,
        visibility: audience,
        kind: 'imported-fact',
        taint: [],
        ...extras,
      }),
    },
  })
}
function importCase(i, mode) {
  const repo = initRepo(`import-${i}`)
  fs.mkdirSync(path.join(repo, 'imports'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.md'), '# consumer\n')
  fs.mkdirSync(path.join(repo, 'internal'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'internal/summary.md'), '# internal\n')
  const fact = `api.${i}`
  let alias = pick(['payments', 'pay_1', 'mirror.a', 'M-2'])
  let importPath = 'imports/payments.true-up.json'
  let pinRepo = 'payments-service'
  let pinAudience = 'public'
  let seedFrom = 'README.md'
  let seedTo = `@${alias}:${fact}`
  let snapshot = baseSnapshot(fact)
  let expectGraph = true
  let expectPolicy = 0

  if (mode === 1) {
    snapshot = { ...snapshot, sourceCommit: 'deadbeefcafebabe', sourcePath: 'secret/internal.json', 'secret/internal.json': 'poison-key' }
    expectGraph = false
  } else if (mode === 2) {
    snapshot.facts[fact].raw = 'raw-secret'
    snapshot.facts[fact].path = 'machine-local-secret-path'
    expectGraph = false
  } else if (mode === 3) {
    snapshot.facts[fact].via = 'scripts/evil.sh'
    expectGraph = false
  } else if (mode === 4) {
    snapshot.facts[fact].taint = [{ alias: 'upstream', repoId: 'private-source', audience: 'internal', id: 'secret.fact' }]
    expectPolicy = 1
  } else if (mode === 5) {
    snapshot = baseSnapshot(fact, 'internal')
    pinAudience = 'internal'
    expectPolicy = 1
  } else if (mode === 6) {
    snapshot = baseSnapshot(fact, 'internal')
    pinAudience = 'internal'
    seedFrom = 'internal/summary.md'
    expectPolicy = 0
  } else if (mode === 7) {
    alias = pick(['../bad', 'bad/name', 'import', 'main'])
    seedTo = '@payments:api.0'
    expectGraph = false
  } else if (mode === 8) {
    importPath = '../outside.json'
    expectGraph = false
  } else if (mode === 9) {
    pinRepo = 'wrong-service'
    expectGraph = false
  } else if (mode === 10) {
    pinAudience = 'private'
    expectGraph = false
  } else if (mode === 11) {
    snapshot = baseSnapshot('bad/id')
    seedTo = `@${alias}:bad/id`
    expectGraph = false
  } else if (mode === 12) {
    snapshot.facts[fact].taint = [{ alias: 'u', repoId: 'r', audience: 'internal', id: 'secret.fact', raw: 'raw-secret', path: 'machine-local-secret-path' }]
    expectGraph = false
  }

  fs.writeFileSync(path.join(repo, 'imports/payments.true-up.json'), JSON.stringify(snapshot, null, 2) + '\n')
  writeJSON(path.join(repo, '.true-up.json'), {
    imports: { [alias]: { path: importPath, repoId: pinRepo, audience: pinAudience } },
    zones: [
      { path: 'internal/', visibility: 'internal', audience: 'team', intent: 'internal', rules: [] },
      { path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] },
    ],
    seed: [{ from: seedFrom, to: seedTo, kind: 'derives-facts-from' }],
  })
  git(repo, ['add', '-A'])
  const g = run(['--repo', repo, 'graph', '--json'], repo)
  const combined = `${g.stdout}\n${g.stderr}`
  assertNoPoison(combined, `import case ${i}`)
  if (!expectGraph) {
    assert(g.status !== 0, `import case ${i} unexpectedly built`)
    const p = run(['--repo', repo, '--policy'], repo)
    assertNoPoison(`${p.stdout}\n${p.stderr}`, `import case ${i} policy`)
    assert(p.status !== 0, `import case ${i} policy passed despite graph/import errors`)
    return
  }
  assert(g.status === 0, `import case ${i} failed graph: ${combined}`)
  const graph = JSON.parse(g.stdout)
  const graphText = JSON.stringify(graph)
  assertNoPoison(graphText, `import case ${i} graph`)
  for (const [id, node] of Object.entries(graph.nodes || {})) {
    if (id.startsWith('import:')) assert(!('via' in node), `import case ${i} preserved executable via metadata`)
  }
  const p = run(['--repo', repo, '--policy'], repo)
  if (expectPolicy) assert(p.status !== 0, `import case ${i} policy unexpectedly passed`)
  else assert(p.status === 0, `import case ${i} policy unexpectedly failed: ${p.stdout}${p.stderr}`)
}
function exportCase(i, mode) {
  const repo = initRepo(`export-${i}`)
  fs.mkdirSync(path.join(repo, 'secret'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'secret/internal.json'), '{ "items": [ { "id": "timeout", "value": "vip-private-value" } ] }\n')
  const exportEntry = { id: `api.${i}`, from: 'secret/internal.json#items.timeout', audience: 'public' }
  if (mode !== 0) exportEntry.declassify = true
  if (mode === 2) exportEntry.from = 'secret/internal.json#items.missing'
  const seed = mode === 4 ? [{ from: 'secret/internal.json', to: 'secret/internal.json#items.missing', kind: 'derives-facts-from' }] : []
  writeJSON(path.join(repo, '.true-up.json'), {
    repoId: 'payments-service',
    facts: { 'secret/internal.json': [['items', 'id']] },
    zones: [
      { path: 'secret/', visibility: mode === 3 ? 'team' : 'private', audience: 'team', intent: 'private', rules: [] },
      { path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] },
    ],
    exports: [exportEntry],
    seed,
  })
  git(repo, ['add', '-A'])
  const r = run(['--repo', repo, 'export', '--audience', 'public', '--json'], repo)
  const combined = `${r.stdout}\n${r.stderr}`
  assertNoPoison(combined, `export case ${i}`)
  if (mode === 0 || mode === 2 || mode === 3 || mode === 4) {
    assert(r.status !== 0, `export case ${i} unexpectedly succeeded`)
    return
  }
  assert(r.status === 0, `export case ${i} failed: ${combined}`)
  const snap = JSON.parse(r.stdout)
  const text = JSON.stringify(snap)
  assertNoPoison(text, `export case ${i} snapshot`)
  assert(snap.kind === 'true-up-import-snapshot' && snap.repoId === 'payments-service' && snap.audience === 'public', `export case ${i} bad envelope`)
}

for (let i = 0; i < 52; i++) importCase(i, i % 13)
for (let i = 0; i < 20; i++) exportCase(i, i % 5)
NODE
rc=$?
[ "$rc" -eq 0 ] && ok "inter-repo fuzz: structure-aware boundary corpus preserves privacy invariants" || no "inter-repo fuzz must preserve import/export privacy invariants"

# T24 — ergonomics: a mistyped command gets a 'did you mean' suggestion (Axiom 7 intent inference)
err="$($TU --repo "$FIX" --externalites 2>&1)"; rc=$?
{ [ "$rc" -eq 2 ] && echo "$err" | grep -q 'did you mean: --externalities'; } && ok "did-you-mean suggests the nearest command on a typo" || no "must suggest nearest command on a typo"

# T25 — Tier 1: language-agnostic SPAN ANCHORS make CODE a content-hashed source-of-truth.
# A paired comment-token region (any language; here Python — the .py-is-inert gap) becomes a
# fact node; a doc that anchors to it gets an advisory derives-facts-from edge.
S="$(mktemp -d)"; git -C "$S" init -q
printf '%s\n' '# true-up:anchor id=parse_config' 'def parse_config(path):' '    return load(path)' '# true-up:end id=parse_config' > "$S/parser.py"
printf '%s\n' '# API' 'parse_config loads the config. <!-- fact: parser.py#parse_config -->' > "$S/api.md"
printf '%s\n' '{ "zones": [ {"path":"","visibility":"public","audience":"world","intent":"public","rules":[]} ], "seed": [] }' > "$S/.true-up.json"
git -C "$S" add -A && git -C "$S" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$S" >/dev/null 2>&1 && ok "Tier1: build succeeds with a code span anchor + doc anchor" || no "Tier1: build must succeed with a code span anchor"
$TU --repo "$S" --impact 'parser.py#parse_config' 2>/dev/null | grep -q 'api.md' && ok "Tier1: a doc derives-facts-from a CODE span (language-agnostic)" || no "Tier1: code span fact-edge must resolve"

# T25b — a malformed span is harmless ON ITS OWN (so files can document the token without self-tripping),
# but a doc that ANCHORS to a span which never formed a complete pair FAILS LOUD (unresolved-anchor backstop).
printf '%s\n' '# true-up:anchor id=orphan' 'def f(): return 1' > "$S/lonely.py"
$TU --repo "$S" >/dev/null 2>&1 && ok "Tier1: a lone unclosed span nobody depends on is harmless (no self-trip)" || no "Tier1: lone unclosed span must not fail the build"
printf '%s\n' 'see <!-- fact: lonely.py#orphan -->' > "$S/needsit.md"
out="$($TU --repo "$S" 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'lonely.py#orphan'; } && ok "Tier1: a doc anchoring to a non-formed span FAILS LOUD (names it)" || no "Tier1: anchor to a missing span must fail-loud"
rm -f "$S/lonely.py" "$S/needsit.md"; $TU --repo "$S" >/dev/null 2>&1

# T25c — INCIDENT guard (mirror of T5b): span-anchor EXAMPLES inside markdown code formatting
# (a doc explaining THIS feature) must NOT be parsed as live spans.
printf '%s\n' '# how-to' 'Bracket a region:' '```' '# true-up:anchor id=demo' 'code here' '# true-up:end id=demo' '```' > "$S/howto.md"
$TU --repo "$S" >/dev/null 2>&1 && ok "Tier1: span examples in markdown code fences do not fail-loud" || no "Tier1: fenced span examples must not fail-loud"
grep -q 'fact:howto.md#demo' "$S/.true-up/depgraph.json" && no "Tier1: a fenced span example must NOT create a live fact node" || ok "Tier1: fenced span example is inert (no spurious fact node)"
rm -f "$S/howto.md"; $TU --repo "$S" >/dev/null 2>&1

# T25d — EARLY-CUTOFF for span facts: editing a span's BODY stales its anchored doc via --since;
# editing the file OUTSIDE the span does NOT (the whole point of fact-granular hashing).
git -C "$S" checkout -- parser.py 2>/dev/null
printf '%s\n' '# true-up:anchor id=parse_config' 'def parse_config(path):' '    return load2(path)  # body changed' '# true-up:end id=parse_config' > "$S/parser.py"
$TU --repo "$S" >/dev/null 2>&1
$TU --repo "$S" --impact --since HEAD 2>/dev/null | grep -q 'api.md' && ok "Tier1: editing a span BODY stales its anchored doc (--since early-cutoff)" || no "Tier1: span-body change must stale the doc via --since"
git -C "$S" checkout -- parser.py 2>/dev/null
printf '%s\n' '# true-up:anchor id=parse_config' 'def parse_config(path):' '    return load(path)' '# true-up:end id=parse_config' '' 'def unrelated(): pass  # outside the span' > "$S/parser.py"
$TU --repo "$S" >/dev/null 2>&1
$TU --repo "$S" --impact --since HEAD 2>/dev/null | grep -q 'api.md' && no "Tier1: an edit OUTSIDE the span must NOT stale the doc (early-cutoff)" || ok "Tier1: edit outside the span does not stale the doc (early-cutoff)"
git -C "$S" checkout -- parser.py 2>/dev/null; $TU --repo "$S" >/dev/null 2>&1

# T25e — a repo whose ONLY facts come from span anchors (no config "facts") is NOT inert: it has
# real edges, so build must NOT cry INERT (the dogfood bug: `inert` ignored span facts).
out="$($TU --repo "$S" 2>&1)"
echo "$out" | grep -q 'INERT' && no "Tier1: a span-anchored repo must NOT be reported INERT" || ok "Tier1: span-anchored repo is not INERT (has real edges)"

# T26 — Tier 2: tree-sitter SYMBOL extraction (config-driven "symbols": true) auto-lifts code
# definitions to fact nodes with NO manual markers; a doc anchors to a symbol by name. (Opt-in,
# optional dependency; the zero-dep core never loads tree-sitter.)
# GUARD: Tier-2 needs the optional tree-sitter devDeps. On a bare clone they're absent — SKIP these
# (honest), don't FAIL. `npm install` (or `bun install`) pulls them and these run for real. This makes
# a fresh `git clone && npm test` GREEN instead of 4 cryptic failures that read like a broken tool.
if [ "$HAS_TS" = 1 ]; then
Y="$(mktemp -d)"; git -C "$Y" init -q
printf '%s\n' 'import os' '' 'def parse_config(path):' '    return load(path)' '' 'class Cfg:' '    def get(self):' '        return 1' > "$Y/app.py"
printf '%s\n' '# Guide' 'parse_config reads the config. <!-- fact: app.py#parse_config -->' > "$Y/guide.md"
printf '%s\n' '{ "symbols": true, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$Y/.true-up.json"
git -C "$Y" add -A && git -C "$Y" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$Y" >/dev/null 2>&1 && ok "Tier2: build succeeds with symbols enabled + a symbol anchor" || no "Tier2: symbols build must succeed"
$TU --repo "$Y" --impact 'app.py#parse_config' 2>/dev/null | grep -q 'guide.md' && ok "Tier2: a doc derives-facts-from an auto-extracted CODE SYMBOL (tree-sitter)" || no "Tier2: symbol fact-edge must resolve"

# T27 — Tier 2 EARLY-CUTOFF: editing a SYMBOL's body stales docs anchored to THAT symbol via --since;
# editing a different symbol does not (symbol-granular hashing).
git -C "$Y" add -A && git -C "$Y" -c user.email=t@t -c user.name=t commit -qm base
printf '%s\n' 'import os' '' 'def parse_config(path):' '    return load2(path)  # changed' '' 'class Cfg:' '    def get(self):' '        return 1' > "$Y/app.py"
$TU --repo "$Y" >/dev/null 2>&1
$TU --repo "$Y" --impact --since HEAD 2>/dev/null | grep -q 'guide.md' && ok "Tier2: editing a symbol BODY stales its anchored doc (--since)" || no "Tier2: symbol body change must stale the doc"
git -C "$Y" checkout -- app.py 2>/dev/null
printf '%s\n' 'import os' '' 'def parse_config(path):' '    return load(path)' '' 'class Cfg:' '    def get(self):' '        return 1' '' 'def helper():' '    return 2' > "$Y/app.py"
$TU --repo "$Y" >/dev/null 2>&1
$TU --repo "$Y" --impact --since HEAD 2>/dev/null | grep -q 'guide.md' && no "Tier2: editing a DIFFERENT symbol must NOT stale the doc (early-cutoff)" || ok "Tier2: edit of an unrelated symbol does not stale the doc"
git -C "$Y" checkout -- app.py 2>/dev/null; $TU --repo "$Y" >/dev/null 2>&1

# T28 — Tier 2 is genuinely multi-language: a C++ function's name lives in a DECLARATOR (not a name
# field), exercising the harder extraction path (geometry-central, the top dogfood gap, is C++).
Z="$(mktemp -d)"; git -C "$Z" init -q
printf '%s\n' '#include <string>' '' 'int parse_input(const char* p) {' '    return 0;' '}' > "$Z/api.cpp"
printf '%s\n' '# Docs' 'parse_input returns a status code. <!-- fact: api.cpp#parse_input -->' > "$Z/docs.md"
printf '%s\n' '{ "symbols": true, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[] }' > "$Z/.true-up.json"
git -C "$Z" add -A && git -C "$Z" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$Z" >/dev/null 2>&1
$TU --repo "$Z" --impact 'api.cpp#parse_input' 2>/dev/null | grep -q 'docs.md' && ok "Tier2: C++ function symbol extracted via declarator + anchored (multi-language)" || no "Tier2: C++ symbol must resolve"
else
  sk "Tier2 symbol tests (T26-T28): tree-sitter optional devDeps not installed — run \`npm install\` to enable"
fi

# T29 — P0 (ergonomics): per-command flag validation. A typo'd flag must be REJECTED (exit 2 +
# did-you-mean), never silently dropped. The worst case: --comitted downgrades the committed drift
# gate to the worktree check (exit 1→0) — a one-char typo defeating a CI gate. (verified live)
G="$(mktemp -d)"; git -C "$G" init -q
printf '%s\n' '{ "items": [ { "id": "a", "v": 1 } ] }' > "$G/data.json"
printf '%s\n' '{ "facts": { "data.json": [["items","id"]] }, "zones": [ {"path":"","visibility":"public","audience":"world","intent":"public","rules":[]} ], "seed": [] }' > "$G/.true-up.json"
git -C "$G" add -A && git -C "$G" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$G" >/dev/null 2>&1
git -C "$G" add .true-up/depgraph.json && git -C "$G" -c user.email=t@t -c user.name=t commit -qm graph
printf '%s\n' '{ "items": [ { "id": "a", "v": 999 } ] }' > "$G/data.json"
$TU --repo "$G" >/dev/null 2>&1   # worktree graph fresh, committed blob now stale
out="$($TU --repo "$G" --check --comitted 2>&1)"; rc=$?
{ [ "$rc" -eq 2 ] && echo "$out" | grep -q 'did you mean: --committed'; } && ok "P0: --comitted typo is REJECTED (exit 2 + did-you-mean), not a silent gate downgrade" || no "P0: --comitted must not silently downgrade the committed gate"
$TU --repo "$G" --impact --snice HEAD~1 >/dev/null 2>&1; rc=$?; [ "$rc" -eq 2 ] && ok "P0: --impact --snice (typo) exits 2, not a bogus positional '0 dependents'" || no "P0: --impact typo flag must exit 2"
$TU --repo "$G" --check --committed >/dev/null 2>&1; rc=$?; [ "$rc" -ne 2 ] && ok "P0: legit --committed still accepted (validator does not over-reject)" || no "P0: validator must not reject legit flags"

# T30 — P1 (ergonomics): the rebuild hint must be runnable. Against true-up's OWN repo, relative(self)
# is 'lib/engine.mjs' (no '..'), which is not executable — copy-paste → exit 126. Hint must say true-up.
err="$(cd "$HERE" && node bin/true-up bogus 2>&1)"
echo "$err" | grep -qE 'engine\.mjs|^lib/' && no "P1: self error-hint must not name the non-runnable engine path" || ok "P1: in-repo error hint is runnable (not lib/engine.mjs)"

# T31 — P0 (ergonomics): run --json and --version --json must emit JSON (the contract capabilities
# advertises). run is the mega-command agents script with | jq; both emitted human text. (verified)
$TU --repo "$FIX" run --since HEAD --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(typeof d.green==="boolean"&&d.verify?0:1)' && ok "P0: run --json is valid structured JSON" || no "P0: run --json must be valid JSON"
$TU --repo "$FIX" --version --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.version?0:1)' && ok "P0: --version --json is valid JSON" || no "P0: --version --json must be valid JSON"

# T32 — adoption: `true-up hooks` wires a per-repo gate. --install writes executable pre-commit +
# pre-push hooks running the leak/zone gate; idempotent; the installed hook actually BLOCKS a leak;
# --ci prints a version-pinned snippet; --uninstall removes only the managed hooks.
K="$(mktemp -d)"; git -C "$K" init -q
printf '%s' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":["no-machine-local-paths"]}]}' > "$K/.true-up.json"
git -C "$K" add -A && git -C "$K" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$K" hooks --install >/dev/null 2>&1
{ [ -x "$K/.git/hooks/pre-commit" ] && [ -x "$K/.git/hooks/pre-push" ]; } && ok "hooks: --install writes executable pre-commit + pre-push" || no "hooks --install must write executable hooks"
{ grep -q 'true-up --policy' "$K/.git/hooks/pre-commit" && grep -q 'true-up --externalities' "$K/.git/hooks/pre-commit"; } && ok "hooks: the gate runs --policy + --externalities" || no "hook must run the gates"
$TU --repo "$K" hooks --install >/dev/null 2>&1
[ "$(grep -c 'managed-by: true-up-hooks' "$K/.git/hooks/pre-commit")" -eq 1 ] && ok "hooks: --install is idempotent (no stacking)" || no "hooks --install must be idempotent"
mkdir -p "$K/shim"; printf '%s\n' '#!/bin/sh' "exec node \"$HERE/bin/true-up\" \"\$@\"" > "$K/shim/true-up"; chmod +x "$K/shim/true-up"
printf '%s\n' 'see /home/somebody/secret/x' > "$K/leak.md"; git -C "$K" add leak.md # true-up:ignore-line no-machine-local-paths
if PATH="$K/shim:$PATH" git -C "$K" -c user.email=t@t -c user.name=t commit -qm leak >/dev/null 2>&1; then no "hooks: pre-commit must BLOCK a leak commit"; else ok "hooks: the installed pre-commit BLOCKS a commit that adds a machine-local-path leak"; fi
git -C "$K" reset -q HEAD leak.md 2>/dev/null; rm -f "$K/leak.md"
$TU --repo "$K" hooks --ci 2>/dev/null | grep -q 'npx true-up@' && ok "hooks: --ci prints a version-pinned CI snippet" || no "hooks --ci must print a CI snippet"
$TU --repo "$K" hooks --uninstall >/dev/null 2>&1
{ [ ! -e "$K/.git/hooks/pre-commit" ] && [ ! -e "$K/.git/hooks/pre-push" ]; } && ok "hooks: --uninstall removes the managed hooks" || no "hooks --uninstall must remove them"

# T33 — gate: one CI stage = --check + --policy + --externalities; exit code is authoritative (a runner
# keys on it, not stdout). Exits 0 when clean, nonzero when ANY sub-check fails; --json per-check status.
$TU --repo "$FIX" >/dev/null 2>&1
$TU --repo "$FIX" gate >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "gate: exits 0 on a clean repo (check+policy+externalities)" || no "gate must pass when clean"
$TU --repo "$FIX" gate --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===true&&d.checks&&typeof d.checks.policy==="boolean"?0:1)' && ok "gate --json reports per-check status" || no "gate --json must be structured"
printf '%s\n' 'leak /home/someone/y/z' > "$FIX/gateleak.md" # true-up:ignore-line no-machine-local-paths
$TU --repo "$FIX" gate >/dev/null 2>&1; rc=$?; [ "$rc" -ne 0 ] && ok "gate: EXITS NONZERO when a sub-check fails (a leak)" || no "gate must fail on any sub-check failure"
rm -f "$FIX/gateleak.md"; $TU --repo "$FIX" >/dev/null 2>&1

# T34 — strictSpans (consumer ask): "strictSpans": true makes a malformed span anchor FATAL so a CI
# gate can't be fooled by a silently-dropped span; default stays lenient (no self-trip on doc'd tokens).
printf '%s' '{"strictSpans":true,"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}]}' > "$K/.true-up.json"
printf '%s\n' '# true-up:anchor id=dup' 'a' '# true-up:end id=dup' '# true-up:anchor id=dup' 'b' '# true-up:end id=dup' > "$K/dup.py"
out="$($TU --repo "$K" 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'dup'; } && ok "strictSpans: a malformed span (duplicate id) FAILS the build (names it)" || no "strictSpans must fail on a malformed span"
printf '%s' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}]}' > "$K/.true-up.json"
$TU --repo "$K" >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "default (no strictSpans): the same malformed span is lenient (no self-trip)" || no "default must stay lenient on malformed spans"
rm -f "$K/dup.py"

# T35 — THE READ-ONLY INVARIANT (keystone): no read-side command may modify, create, or delete ANY
# file outside .true-up/ (and .git/). This turns "true-up never touches your content — it writes only
# its own .true-up/ graph (+ .git/hooks on explicit hooks --install)" from a claim into an enforced gate.
# The before/after content hash subsumes a marker-injection check: an injected <!-- fact: -->/true-up:anchor
# would BE a content-byte change and trip this. --no-write build is included (must also touch nothing).
fp(){ ( cd "$1" && find . -type f -not -path './.git/*' -not -path './.true-up/*' | sort | while read -r f; do printf '%s:' "$f"; sha256sum "$f" | cut -d' ' -f1; done ); }
RO_OK=1
for cmd in "" "--no-write" "graph" "--check" "--impact data.json#items.a" "--policy --report" "--externalities --report" "--verify-scope --since HEAD" "gate" "capabilities" "--version" "--help"; do
  b="$(fp "$FIX")"; $TU --repo "$FIX" $cmd >/dev/null 2>&1; a="$(fp "$FIX")"
  [ "$b" = "$a" ] || { RO_OK=0; label="${cmd:-build}"; printf '    content CHANGED by: true-up %s\n' "$label"; }
done
[ "$RO_OK" = 1 ] && ok "INVARIANT: no read-side command touches any content file (writes only .true-up/)" || no "read-side commands must not modify content outside .true-up/"
[ -f "$FIX/.true-up/depgraph.json" ] && ok "INVARIANT: build's only write is its graph under .true-up/" || no "build must write its graph under .true-up/"

# T36 — MARKER-FREE fact-granular seed: a doc depends on a SPECIFIC fact via .true-up.json `seed`
# (to: path#fact), with NO inline <!-- fact: --> marker in the doc. Early-cutoff must still hold.
SD="$(mktemp -d)"; git -C "$SD" init -q
printf '%s\n' '{ "items": [ { "id": "a", "v": 1 }, { "id": "b", "v": 2 } ] }' > "$SD/data.json"
printf '%s\n' '# Guide' 'a is 1.' > "$SD/doc.md"   # deliberately NO inline anchor
printf '%s' '{ "facts": { "data.json": [["items","id"]] }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[ {"from":"doc.md","to":"data.json#items.a","kind":"derives-facts-from"} ] }' > "$SD/.true-up.json"
git -C "$SD" add -A && git -C "$SD" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$SD" >/dev/null 2>&1
$TU --repo "$SD" --impact 'data.json#items.a' 2>/dev/null | grep -q 'doc.md' && ok "marker-free: a fact-granular seed links doc→fact with NO inline marker" || no "fact-granular seed must resolve marker-free"
git -C "$SD" add -A && git -C "$SD" -c user.email=t@t -c user.name=t commit -qm base
printf '%s\n' '{ "items": [ { "id": "a", "v": 1 }, { "id": "b", "v": 999 } ] }' > "$SD/data.json"
$TU --repo "$SD" >/dev/null 2>&1
$TU --repo "$SD" --impact --since HEAD 2>/dev/null | grep -q 'doc.md' && no "marker-free seed early-cutoff: an unrelated fact (items.b) must NOT stale doc.md" || ok "marker-free seed: early-cutoff holds (unrelated fact change does not stale the doc)"
git -C "$SD" checkout -- data.json 2>/dev/null
printf '%s\n' '{ "items": [ { "id": "a", "v": 5 }, { "id": "b", "v": 2 } ] }' > "$SD/data.json"
$TU --repo "$SD" >/dev/null 2>&1
$TU --repo "$SD" --impact --since HEAD 2>/dev/null | grep -q 'doc.md' && ok "marker-free seed: changing the CITED fact stales the doc (--since)" || no "marker-free seed: cited-fact change must stale the doc"
git -C "$SD" checkout -- data.json 2>/dev/null; $TU --repo "$SD" >/dev/null 2>&1

# T37 — fail-loud parity: a seed `to` naming a nonexistent fact or file is a hard error, not a
# silently-dropped edge (closes the one place sidecar edges were LESS safe than inline anchors).
printf '%s' '{ "facts": { "data.json": [["items","id"]] }, "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[ {"from":"doc.md","to":"data.json#items.NOPE"} ] }' > "$SD/.true-up.json"
out="$($TU --repo "$SD" 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'NOPE'; } && ok "fail-loud: a seed to a nonexistent fact errors (names it)" || no "bad seed fact target must fail-loud"
printf '%s' '{ "zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}], "seed":[ {"from":"doc.md","to":"gone.json"} ] }' > "$SD/.true-up.json"
out="$($TU --repo "$SD" 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'gone.json'; } && ok "fail-loud: a seed to a nonexistent file errors (names it)" || no "bad seed file target must fail-loud"

# T37b — marker-free MECHANICAL seed: generated artifacts can be declared in config without an inline
# generated-by marker, and run executes the declared in-repo generator when the source changes.
MG="$(mktemp -d)"; git -C "$MG" init -q
printf '%s\n' '{"v":1}' > "$MG/data.json"
printf '%s\n' 'stale' > "$MG/out.md"
cat > "$MG/gen.mjs" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
const data = JSON.parse(readFileSync('data.json', 'utf8'))
writeFileSync('out.md', `v=${data.v}\n`)
JS
printf '%s' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}],"seed":[{"from":"out.md","to":"data.json","kind":"generated-from"}]}' > "$MG/.true-up.json"
git -C "$MG" add -A && git -C "$MG" -c user.email=t@t -c user.name=t commit -qm missing-via
out="$($TU --repo "$MG" 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q 'via'; } && ok "marker-free generated seed: missing via fails loud" || no "generated-from seed without via must not pass green"
printf '%s\n' 'stale-a' > "$MG/out-a.md"
printf '%s\n' 'stale-b' > "$MG/out-b.md"
printf '%s' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}],"seed":[{"from":"out.md","to":"data.json","kind":"generated-from","via":"gen.mjs"},{"from":"out-a.md","to":"data.json","kind":"generated-from","via":"gen.mjs"},{"from":"out-b.md","to":"data.json","kind":"generated-from","via":"gen.mjs"}]}' > "$MG/.true-up.json"
git -C "$MG" add -A && git -C "$MG" -c user.email=t@t -c user.name=t commit -qm init
$TU --repo "$MG" >/dev/null 2>&1
$TU --repo "$MG" --impact data.json --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.mechanical&&d.mechanical.some(x=>x.node==="file:out.md"&&x.via==="gen.mjs")?0:1)' && ok "marker-free generated seed: impact reports mechanical dependent + via" || no "generated-from seed must be mechanical and carry via"
impact="$($TU --repo "$MG" --impact data.json 2>/dev/null)"
{ echo "$impact" | grep -q '3 mechanical' && echo "$impact" | grep -q 'out.md' && echo "$impact" | grep -q 'out-a.md' && echo "$impact" | grep -q 'out-b.md'; } && ok "marker-free generated seed: impact lists EVERY generated dependent sharing one via" || no "impact must not collapse generated dependents that share a via"
$TU --repo "$MG" --impact data.json --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const got=new Set((d.mechanical||[]).map(x=>x.node));const via=new Set((d.mechanical||[]).map(x=>x.via));process.exit(d.counts.mechanical===3&&via.size===1&&via.has("gen.mjs")&&["file:out.md","file:out-a.md","file:out-b.md"].every(x=>got.has(x))?0:1)' && ok "marker-free generated seed: --json impact lists EVERY dependent sharing one via" || no "--impact --json must not collapse generated dependents that share a via"
printf '%s\n' '{"v":2}' > "$MG/data.json"
$TU --repo "$MG" run --since HEAD >/dev/null 2>&1
grep -qx 'v=2' "$MG/out.md" && ok "marker-free generated seed: run executes the declared generator" || no "run must execute generated-from seed via"
cat > "$MG/gen.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
v="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("data.json","utf8")).v))')"
printf 'v=%s\n' "$v" > out.md
SH
printf '%s' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}],"seed":[{"from":"out.md","to":"data.json","kind":"generated-from","via":"gen.sh"}]}' > "$MG/.true-up.json"
$TU --repo "$MG" >/dev/null 2>&1
git -C "$MG" add -A && git -C "$MG" -c user.email=t@t -c user.name=t commit -qm shell-via
printf '%s\n' '{"v":3}' > "$MG/data.json"
$TU --repo "$MG" run --since HEAD >/dev/null 2>&1
grep -qx 'v=3' "$MG/out.md" && ok "marker-free generated seed: shell via is repo-general (not Node-only)" || no "run must execute shell via without node-wrapping it"

# T37c — --impact --since is a "remaining stale" view. After a successful maintenance pass, changed
# downstream docs are seeds too, so they can disappear from the default dependent list. --proof is the
# audit view: changed fact -> dependents, marking which dependents were already edited in the range.
PF="$(mktemp -d)"; git -C "$PF" init -q
printf '%s' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}]}' > "$PF/.true-up.json"
printf '%s\n' '# true-up:anchor id=api' 'def command_surface():' '    return "old"' '# true-up:end' > "$PF/tool.py"
printf '%s\n' '# CLI' 'Old command surface. <!-- fact: tool.py#api -->' > "$PF/doc.md"
git -C "$PF" add -A && git -C "$PF" -c user.email=t@t -c user.name=t commit -qm base
$TU --repo "$PF" >/dev/null 2>&1
printf '%s\n' '# true-up:anchor id=api' 'def command_surface():' '    return "new"' '# true-up:end' > "$PF/tool.py"
printf '%s\n' '# CLI' 'New command surface. <!-- fact: tool.py#api -->' > "$PF/doc.md"
$TU --repo "$PF" >/dev/null 2>&1
js="$($TU --repo "$PF" --impact --since HEAD --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.changedFacts.includes("fact:tool.py#api")&&d.counts.total===0?0:1)' && ok "--impact --since: already-edited dependent can be absent from remaining-stale list" || no "--impact --since default should remain the current-stale view"
js="$($TU --repo "$PF" --impact --since HEAD --proof --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const src=(d.proof.sources||[]).find(s=>s.source==="fact:tool.py#api");const dep=src&&src.dependents.find(x=>x.node==="file:doc.md");process.exit(dep&&dep.status==="changed-in-range"&&d.proof.summary.changedInRange>=1?0:1)' && ok "--impact --proof: changed fact reports dependent already edited in-range" || no "--impact --proof must explain satisfied/edited dependents"
out="$($TU --repo "$PF" --impact --since HEAD --proof 2>/dev/null)"
{ echo "$out" | grep -q 'PROOF' && echo "$out" | grep -q 'doc.md' && echo "$out" | grep -q 'changed-in-range'; } && ok "--impact --proof: human output names edited dependent" || no "--impact --proof human output must show edited dependents"
$TU --repo "$PF" --impact tool.py#api --proof >/dev/null 2>&1; [ "$?" -eq 2 ] && ok "--impact --proof requires --since (usage error, no ambiguous explicit-target proof)" || no "--impact --proof without --since must fail loud"
$TU --repo "$PF" --impact --since HEAD extra >/dev/null 2>&1; [ "$?" -eq 2 ] && ok "--impact --since rejects stray explicit targets" || no "--impact --since must not silently ignore explicit targets"
$TU --repo "$PF" --impact --since HEAD --proof extra >/dev/null 2>&1; [ "$?" -eq 2 ] && ok "--impact --since --proof rejects stray explicit targets" || no "--impact --since --proof must not silently ignore explicit targets"
PD="$(mktemp -d)"; git -C "$PD" init -q
printf '%s\n' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}],"seed":[{"from":"doc.md","to":"tool.py#a","kind":"derives-facts-from"},{"from":"doc.md","to":"tool.py#b","kind":"derives-facts-from"}]}' > "$PD/.true-up.json"
printf '%s\n' '# true-up:anchor id=a' 'A = 1' '# true-up:end' '# true-up:anchor id=b' 'B = 1' '# true-up:end' > "$PD/tool.py"
printf 'A and B.\n' > "$PD/doc.md"
git -C "$PD" add -A && git -C "$PD" -c user.email=t@t -c user.name=t commit -qm base
$TU --repo "$PD" build >/dev/null 2>&1
printf '%s\n' '# true-up:anchor id=a' 'A = 2' '# true-up:end' '# true-up:anchor id=b' 'B = 2' '# true-up:end' > "$PD/tool.py"
printf 'A and B updated.\n' > "$PD/doc.md"
$TU --repo "$PD" build >/dev/null 2>&1
js="$($TU --repo "$PD" --impact --since HEAD --proof --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=d.proof.summary;process.exit(s.sourceDependentEdges===2&&s.dependents===2&&s.uniqueDependents===1&&s.uniqueChangedInRange===1?0:1)' && ok "--impact --proof summary includes unique dependent counts" || no "--impact --proof summary must distinguish entries from unique dependents"

# T37c2 — --proof's audit SIGNAL: a fact/source changed in the range but the dependent doc was NOT
# edited → it STILL needs a prose rewrite. The other T37c cases cover changed-in-range (already edited)
# and satisfied-by-live-alias; this pins the not-changed-in-range status + summary counters, the whole
# reason --proof exists (a completed-pass auditor must see the unedited dependents, not an empty list).
PN="$(mktemp -d)"; git -C "$PN" init -q
printf '%s' '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"public","rules":[]}]}' > "$PN/.true-up.json"
printf '%s\n' '# true-up:anchor id=api' 'def surface():' '    return "old"' '# true-up:end' > "$PN/tool.py"
printf '%s\n' '# CLI' 'Surface docs. <!-- fact: tool.py#api -->' > "$PN/doc.md"
git -C "$PN" add -A && git -C "$PN" -c user.email=t@t -c user.name=t commit -qm base
$TU --repo "$PN" >/dev/null 2>&1
# change ONLY the source/fact; leave the dependent doc UNTOUCHED (the unfinished-rewrite case)
printf '%s\n' '# true-up:anchor id=api' 'def surface():' '    return "new"' '# true-up:end' > "$PN/tool.py"
$TU --repo "$PN" >/dev/null 2>&1
js="$($TU --repo "$PN" --impact --since HEAD --proof --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const src=(d.proof.sources||[]).find(s=>s.source==="fact:tool.py#api");const dep=src&&src.dependents.find(x=>x.node==="file:doc.md");process.exit(dep&&dep.status==="not-changed-in-range"&&d.proof.summary.notChangedInRange>=1&&d.proof.summary.uniqueNotChangedInRange>=1?0:1)' && ok "--impact --proof: source changed but dependent unedited -> not-changed-in-range (still needs rewrite)" || no "--impact --proof must flag an unedited dependent as not-changed-in-range"

# T38 — --no-write: a fully-stateless audit that writes NOTHING — not even .true-up/. Query commands
# fall back to an in-memory build instead of "build the graph first". (The owner's "truly no file edits".)
rm -f "$FIX/.true-up/depgraph.json"; rmdir "$FIX/.true-up" 2>/dev/null
$TU --repo "$FIX" --no-write >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && [ ! -e "$FIX/.true-up" ]; } && ok "--no-write: bare build writes NOTHING (no .true-up/ created)" || no "--no-write must not create .true-up/"
$TU --repo "$FIX" --impact 'data.json#items.a' --no-write 2>/dev/null | grep -q 'doc.md' && ok "--no-write: --impact resolves via in-memory build (no on-disk graph, no exit 2)" || no "--impact --no-write must resolve in-memory"
[ ! -e "$FIX/.true-up" ] && ok "--no-write: --impact wrote nothing either" || no "--impact --no-write must not write"
$TU --repo "$FIX" --no-write --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.wrote===false&&d.graph&&Array.isArray(d.graph.edges)?0:1)' && ok "--no-write --json emits the in-memory graph (wrote:false)" || no "--no-write --json must emit the graph"
$TU --repo "$FIX" >/dev/null 2>&1   # restore the on-disk graph for any later use

# T39 — DETERMINISM: two builds over an unchanged tree produce a byte-identical graph (sorted, no
# timestamps) — the basis of an honest --check and of --check --committed being the verify gate.
$TU --repo "$FIX" >/dev/null 2>&1; g1="$(mktemp)"; cp "$FIX/.true-up/depgraph.json" "$g1"
$TU --repo "$FIX" >/dev/null 2>&1
cmp -s "$FIX/.true-up/depgraph.json" "$g1" && ok "DETERMINISM: rebuild is byte-identical (honest --check)" || no "build must be byte-deterministic"
rm -f "$g1"

# ============================================================================
# HARDENING REGRESSIONS (v0.1.0 usability + safety pass). Provenance: a 6-lens audit + dogfooding.
# Each case guards one fix so the failure mode can never silently return.
# ============================================================================

# T40 — resolveRoot normalizes --repo to the git TOPLEVEL: a --repo at a SUBDIR must still see the
# toplevel config and CATCH a toplevel leak. (GAP-H: subdir --repo saw an empty graph → false-clean.)
RR="$(mktemp -d)"; git -C "$RR" init -q; mkdir -p "$RR/pkg/deep"
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":["no-machine-local-paths"]}]}' > "$RR/.true-up.json"
printf 'see /home/victim/secret/x\n' > "$RR/README.md" # true-up:ignore-line no-machine-local-paths
git -C "$RR" add -A && git -C "$RR" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$RR/pkg" --externalities >/dev/null 2>&1; rc=$?; [ "$rc" -eq 1 ] && ok "resolveRoot: --repo <subdir> normalizes to toplevel + catches a toplevel leak (no GAP-H false-clean)" || no "resolveRoot must normalize --repo subdir to toplevel (rc=$rc)"

# T41 — a non-git --repo is a CLEAN exit 2, never a false-clean scan of an empty file set. (GAP-F.)
NG="$(mktemp -d)"; printf 'leak /home/victim/secret/y\n' > "$NG/README.md" # true-up:ignore-line no-machine-local-paths
out="$($TU --repo "$NG" --externalities 2>&1)"; rc=$?; { [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'clean'; } && ok "resolveRoot: --repo <non-git dir> exits 2 (no false-clean)" || no "non-git --repo must exit 2 (rc=$rc)"

# T42 — a nonexistent --repo exits 2 with ONE clean line, not raw git 'fatal:' noise. (ROOT-6/ROOT-8.)
out="$($TU --repo /no/such/path/xyz --policy 2>&1)"; rc=$?; { [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'fatal:'; } && ok "resolveRoot: nonexistent --repo exits 2, no raw git fatal: noise" || no "nonexistent --repo must exit 2 cleanly (rc=$rc)"

# T43 — --version is CLEAN outside any git repo (no eager-ROOT 'fatal:' leak to stderr). (ROOT-8.)
ND="$(mktemp -d)"; out="$(cd "$ND" && $TU --version 2>&1)"; { echo "$out" | grep -qE '[0-9]+\.[0-9]+' && ! echo "$out" | grep -q 'fatal:'; } && ok "--version outside a git repo prints cleanly (no git fatal: leak)" || no "--version must be clean outside a repo"

# T44 — hooks SAFETY: with core.hooksPath pointing OUTSIDE the repo, --install REFUSES (exit 2) and does
# NOT write there; --force is the explicit opt-in. This is the footgun that clobbered a dev's GLOBAL
# hooks during `npm test`. (Isolated fake-global config for this case only.)
HKEXT="$(mktemp -d)"; FAKEG="$(mktemp)"; printf '[core]\n\thooksPath = %s\n' "$HKEXT" > "$FAKEG"
HX="$(mktemp -d)"; GIT_CONFIG_GLOBAL="$FAKEG" git -C "$HX" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}]}' > "$HX/.true-up.json"
GIT_CONFIG_GLOBAL="$FAKEG" git -C "$HX" add -A && GIT_CONFIG_GLOBAL="$FAKEG" git -C "$HX" -c user.email=t@t -c user.name=t commit -qm i
GIT_CONFIG_GLOBAL="$FAKEG" $TU --repo "$HX" hooks --install >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 2 ] && [ -z "$(ls -A "$HKEXT")" ]; } && ok "hooks: REFUSES install into an out-of-repo (global) hooks dir; external dir untouched" || no "hooks must refuse external hooksPath without --force (rc=$rc)"
GIT_CONFIG_GLOBAL="$FAKEG" $TU --repo "$HX" hooks --install --force >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && [ -f "$HKEXT/pre-commit" ]; } && ok "hooks: --force writes into the external dir (explicit opt-in)" || no "hooks --force must allow external install (rc=$rc)"

# T45 — hooks SAFETY: --uninstall RESTORES the foreign hook backed up on install (no silent loss).
HR="$(mktemp -d)"; git -C "$HR" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}]}' > "$HR/.true-up.json"
printf '#!/bin/sh\necho ORIGINAL-FOREIGN-HOOK\n' > "$HR/.git/hooks/pre-commit"; chmod +x "$HR/.git/hooks/pre-commit"
$TU --repo "$HR" hooks --install >/dev/null 2>&1
$TU --repo "$HR" hooks --uninstall >/dev/null 2>&1
{ grep -q 'ORIGINAL-FOREIGN-HOOK' "$HR/.git/hooks/pre-commit" 2>/dev/null && [ ! -f "$HR/.git/hooks/pre-commit.bak" ]; } && ok "hooks: --uninstall restores the backed-up foreign hook (no silent loss) + clears .bak" || no "hooks --uninstall must restore the original hook"

# T32b — hooks land INSIDE the test repo under isolation (proves the harness is hermetic; if this fails,
# the suite is touching a shared/global hooks dir again — STOP and re-read the isolation block).
HI="$(mktemp -d)"; git -C "$HI" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}]}' > "$HI/.true-up.json"
$TU --repo "$HI" hooks --install >/dev/null 2>&1
[ -f "$HI/.git/hooks/pre-commit" ] && ok "hermetic: hooks --install writes INSIDE the repo's .git (harness isolation holds)" || no "harness isolation broken — hooks landed outside the repo"

# T46 — config FAIL-LOUD: a malformed .true-up.json is exit 2 (not swallowed → false-clean), with NO
# stack trace (a trace would leak the engine's own absolute path — ironic for a leak detector). ROOT-11.
BC="$(mktemp -d)"; git -C "$BC" init -q; printf '{ not json' > "$BC/.true-up.json"
printf 'x\n' > "$BC/a.md"; git -C "$BC" add -A && git -C "$BC" -c user.email=t@t -c user.name=t commit -qm i
out="$($TU --repo "$BC" --externalities 2>&1)"; rc=$?; { [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'engine.mjs'; } && ok "config: malformed .true-up.json exits 2 cleanly (no swallow, no stack trace)" || no "malformed config must fail loud + clean (rc=$rc)"

# T47 — config SHAPE validation: an ill-typed key exits 2 cleanly (was an uncaught TypeError stack). GAP-G.
WC="$(mktemp -d)"; git -C "$WC" init -q; printf '{"zones":"public"}' > "$WC/.true-up.json"
git -C "$WC" add -A && git -C "$WC" -c user.email=t@t -c user.name=t commit -qm i
out="$($TU --repo "$WC" --policy 2>&1)"; rc=$?; { [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'engine.mjs'; } && ok "config: ill-typed \"zones\" exits 2 cleanly (no TypeError stack trace)" || no "ill-typed config key must exit 2 cleanly (rc=$rc)"
printf '{"zones":[{"path":"","visibility":"public","audience":["agent"],"intent":"p","rules":[]}]}' > "$WC/.true-up.json"
out="$($TU --repo "$WC" graph --json 2>/dev/null)"; rc=$?; printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===false&&d.error==="invalid-config"?0:1)' && [ "$rc" -eq 2 ] && ok "config: zone audience is native but must be a string (arbitrary vocabulary, typed)" || no "zone audience must reject non-string values"

# T48 — write-invariant: `out` must not escape the repo (../) nor overwrite a tracked content file. ROOT-4.
OE="$(mktemp -d)"; git -C "$OE" init -q; printf '{"out":"../escape.json"}' > "$OE/.true-up.json"
printf 'x\n' > "$OE/a.md"; git -C "$OE" add -A && git -C "$OE" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$OE" >/dev/null 2>&1; rc=$?; { [ "$rc" -eq 2 ] && [ ! -f "$OE/../escape.json" ]; } && ok "out: a '../' path is REFUSED (exit 2); nothing written outside the repo" || no "out must not escape the repo (rc=$rc)"
OC="$(mktemp -d)"; git -C "$OC" init -q; printf 'KEEP-ME README\n' > "$OC/README.md"; printf '{"out":"README.md"}' > "$OC/.true-up.json"
git -C "$OC" add -A && git -C "$OC" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$OC" >/dev/null 2>&1; rc=$?; { [ "$rc" -eq 2 ] && grep -q 'KEEP-ME' "$OC/README.md"; } && ok "out: refuses to overwrite a tracked content file (README intact)" || no "out must not overwrite tracked content (rc=$rc)"

# T49 — --impact on an UNKNOWN target is a usage ERROR (exit 2), not a silent "0 dependents". ROOT-7.
IT="$(mktemp -d)"; git -C "$IT" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}]}' > "$IT/.true-up.json"
printf 'a\n' > "$IT/a.md"; git -C "$IT" add -A && git -C "$IT" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$IT" >/dev/null 2>&1
$TU --repo "$IT" --impact does/not/exist.md >/dev/null 2>&1; rc=$?; [ "$rc" -eq 2 ] && ok "--impact unknown target exits 2 (not a false '0 dependents')" || no "--impact unknown target must exit 2 (rc=$rc)"
# capture-then-parse: the command exits 2, so a `| node` pipe would mask the parse under pipefail (the
# documented pipefail trap). Capture stdout into a var (echo exits 0), then validate the JSON separately.
js="$($TU --repo "$IT" --impact does/not/exist.md --json 2>/dev/null)"; printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===false?0:1)' && ok "--impact unknown target --json emits {ok:false} on stdout (not empty)" || no "--impact --json error must emit JSON"

# T50 — --json error paths emit parseable JSON: a bad --since ref under --json is {ok:false}, not empty. ROOT-5.
js="$($TU --repo "$IT" --impact --since deadbeef --json 2>/dev/null)"; printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===false?0:1)' && ok "--json: a bad --since ref emits {ok:false} on stdout" || no "--json bad-ref must be parseable JSON"

# T51 — --check distinguishes 'not built' from 'stale' so an agent knows to BUILD vs debug a diff.
NB="$(mktemp -d)"; git -C "$NB" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}]}' > "$NB/.true-up.json"
printf 'a\n' > "$NB/a.md"; git -C "$NB" add -A && git -C "$NB" -c user.email=t@t -c user.name=t commit -qm i
js="$($TU --repo "$NB" --check --json 2>/dev/null)"; printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.reason==="not built"&&d.built===false?0:1)' && ok "--check on a never-built repo reports reason:'not built' (not 'stale')" || no "--check must distinguish not-built from stale"

# T52 — run surfaces a failing generator's stderr (was swallowed by stdio:'ignore'). GAP-E.
RG="$(mktemp -d)"; git -C "$RG" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[]}' > "$RG/.true-up.json"
printf 'process.stderr.write("BOOM-IN-GENERATOR\\n"); process.exit(1)\n' > "$RG/gen.mjs"
printf '<!-- generated by gen.mjs from a.json -->\nview\n' > "$RG/view.md"
printf '{"k":1}\n' > "$RG/a.json"
git -C "$RG" add -A && git -C "$RG" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$RG" >/dev/null 2>&1
printf '{"k":2}\n' > "$RG/a.json"
out="$($TU --repo "$RG" run --since HEAD 2>&1)"; echo "$out" | grep -q 'BOOM-IN-GENERATOR' && ok "run: a failing generator's stderr is surfaced (not swallowed)" || no "run must surface generator stderr"

# T53 — run refuses to EXECUTE a generator whose path escapes the repo (arbitrary out-of-tree code). P0#5.
RX="$(mktemp -d)"; git -C "$RX" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[]}' > "$RX/.true-up.json"
printf '<!-- generated by ../evil.mjs from a.json -->\nview\n' > "$RX/view.md"
printf '{"k":1}\n' > "$RX/a.json"
git -C "$RX" add -A && git -C "$RX" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$RX" >/dev/null 2>&1
printf '{"k":2}\n' > "$RX/a.json"
out="$($TU --repo "$RX" run --since HEAD 2>&1)"; echo "$out" | grep -q 'refusing to run generator OUTSIDE' && ok "run: refuses to execute a generator path that escapes the repo" || no "run must refuse out-of-repo generators"

# ============================================================================
# ERGONOMICS REGRESSIONS (v0.1.0 agent-ergonomics pass). Provenance: agent_ergonomics_audit/ (6-lens scoring).
# ============================================================================

# T64 — `status`: read-only ORIENTATION in one call, ALWAYS exit 0 (a probe, not a gate), writes nothing.
ST="$(mktemp -d)"; git -C "$ST" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}]}' > "$ST/.true-up.json"
printf 'a\n' > "$ST/a.md"; git -C "$ST" add -A && git -C "$ST" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$ST" status >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] && ok "status exits 0 even when not built (probe, not gate)" || no "status must exit 0 (rc=$rc)"
[ ! -e "$ST/.true-up" ] && ok "status writes nothing (read-only probe)" || no "status mutated the repo"
js="$($TU --repo "$ST" status --json 2>/dev/null)"; printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===true&&d.built===false&&Array.isArray(d.nextCommands)&&d.nextCommands.length>0&&d._v===1?0:1)' && ok "status --json carries ok/built/nextCommands/_v" || no "status --json shape"
js="$($TU --repo "$ST" status --since definitely-not-a-ref --json 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===false&&d.ref==="definitely-not-a-ref"&&/bad .*ref/.test(d.error||"")?0:1)'; } && ok "status --json exits 2 with {ok:false} for a bad --since ref" || no "status bad --since contract must be documented and parseable (rc=$rc)"

# T65 — `build` verb persists the graph (explicit, discoverable alias of bare true-up)
$TU --repo "$ST" build >/dev/null 2>&1; rc=$?; { [ "$rc" -eq 0 ] && [ -f "$ST/.true-up/depgraph.json" ]; } && ok "build verb persists the graph" || no "build must persist (rc=$rc)"

# T65a — workspace identity: agents in subdirs, linked worktrees, or leaked TRUE_UP_REPO must see
# exactly which repo/workspace true-up targeted before they act on nextCommands.
WTBASE="$(mktemp -d)"; git -C "$WTBASE" init -q
printf '{"facts":{"data.json":[["items","id"]]},"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[{"from":"doc.md","to":"data.json#items.a"}]}\n' > "$WTBASE/.true-up.json"
printf '{"items":[{"id":"a","v":1}]}\n' > "$WTBASE/data.json"
printf 'a <!-- fact: data.json#items.a -->\n' > "$WTBASE/doc.md"
$TU --repo "$WTBASE" build >/dev/null 2>&1
git -C "$WTBASE" add -A && git -C "$WTBASE" -c user.email=t@t -c user.name=t commit -qm base
WTLINK="$(mktemp -d)"; rm -rf "$WTLINK"; git -C "$WTBASE" worktree add -q -b wt-linked "$WTLINK"
mkdir -p "$WTLINK/sub/dir"
js="$(cd "$WTLINK/sub/dir" && $TU status --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.workspace&&d.workspace.vcs==="git"&&d.workspace.repoSource==="cwd"&&d.workspace.cwdRelative==="sub/dir"&&d.workspace.git&&d.workspace.git.linkedWorktree===true&&d.workspace.root===process.argv[1]?0:1)' "$WTLINK" && ok "status --json identifies cwd-selected Git linked worktree + cwdRelative" || no "status must expose linked worktree identity"
out="$(cd "$WTLINK/sub/dir" && $TU status 2>/dev/null)"
{ echo "$out" | grep -q 'git linked-worktree' && echo "$out" | grep -q 'selected: cwd'; } && ok "status human output names linked worktree target selection" || no "status human output must name linked worktree selection"
rm -rf "$WTBASE/.true-up"
WTCWD="$(mktemp -d)"; git -C "$WTCWD" init -q; mkdir -p "$WTCWD/nested"
js="$(cd "$WTCWD/nested" && TRUE_UP_REPO="$WTBASE" $TU status --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const w=d.workspace||{};const nc=(d.nextCommands||[]).join("\n");process.exit(w.repoSource==="$TRUE_UP_REPO"&&w.root===process.argv[1]&&w.cwd===process.argv[2]&&Array.isArray(w.warnings)&&w.warnings.some(x=>x.kind==="cwd-target-mismatch")&&w.commandPrefix&&w.commandPrefix.includes("--repo")&&nc.includes("--repo")?0:1)' "$WTBASE" "$WTCWD/nested" && ok "status warns on cwd/target mismatch and repo-qualifies nextCommands" || no "status must warn and qualify nextCommands on cwd/target mismatch"
cmd="$(printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((d.nextCommands.find(c=>c.includes(" build"))||"").split("#")[0].trim())')"
cmd="${cmd/#true-up/$TU}"
( cd "$WTCWD/nested" && bash -lc "$cmd" ) >/dev/null 2>&1
{ [ -f "$WTBASE/.true-up/depgraph.json" ] && [ ! -e "$WTCWD/.true-up/depgraph.json" ]; } && ok "repo-qualified nextCommand affects TRUE_UP_REPO target, not caller CWD repo" || no "qualified nextCommand must not retarget to caller CWD"

# T65a2 — graph writes are atomic enough for parallel builds: many agents rebuilding the cache should
# never leave a truncated/non-JSON depgraph behind.
reader_fail="$WTBASE/reader.fail"; rm -f "$reader_fail"
( for _ in $(seq 1 200); do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WTBASE/.true-up/depgraph.json" >/dev/null 2>&1 || { printf fail > "$reader_fail"; exit 1; }; done ) &
reader_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do $TU --repo "$WTBASE" build >/dev/null 2>&1 & done
wait
wait "$reader_pid" >/dev/null 2>&1 || true
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WTBASE/.true-up/depgraph.json" && ok "parallel builds leave a valid JSON graph (atomic write)" || no "parallel builds must not leave a torn graph"
[ ! -e "$reader_fail" ] && ok "concurrent reader never saw a torn graph during parallel builds" || no "concurrent reader saw torn graph during writes"

# T65a2b — DETERMINISTIC atomic-write guard (the race above only tears ~2MB+, so it can't catch a
# regression at real graph size). The write goes temp-file + rename: rename() swaps in a FRESH inode
# every build, whereas an in-place writeFileSync(path,...) keeps the same inode (O_TRUNC reuses it). So
# a changing inode across two builds proves the rename path; a revert to writeFileSync would pin it.
# Plus: no `*.tmp` residue may survive under .true-up/ (a half-done atomic write would leak one).
$TU --repo "$WTBASE" build >/dev/null 2>&1
ino1="$(stat -c %i "$WTBASE/.true-up/depgraph.json" 2>/dev/null)"
$TU --repo "$WTBASE" build >/dev/null 2>&1
ino2="$(stat -c %i "$WTBASE/.true-up/depgraph.json" 2>/dev/null)"
{ [ -n "$ino1" ] && [ "$ino1" != "$ino2" ]; } && ok "graph write is atomic rename (inode changes each build; not in-place writeFileSync)" || no "graph write must be rename-based (inode should change) so parallel readers never tear"
ls "$WTBASE"/.true-up/*.tmp >/dev/null 2>&1 && no "atomic write must not leave .tmp residue under .true-up/" || ok "atomic write leaves no .tmp residue under .true-up/"

# T65a2c — release tag-coherence guard (regression: the prepublishOnly HARD-FAIL must NOT be silently
# downgradable to a warn). Provenance: v0.1.4 changed package.json prepublishOnly from `npm run ci` to
# `bash scripts/ci.sh` because the nested `npm run ci` reset npm_lifecycle_event to 'ci', turning the
# untagged-publish block into a warn — an untagged release could slip through. This exercises the EXACT
# guard ci.sh calls, via `ci.sh --tag-coherence-check <ver>`, in a throwaway repo (hermetic).
TCG="$(mktemp -d)"; git -C "$TCG" init -q
printf 'x\n' > "$TCG/f"; git -C "$TCG" add -A && git -C "$TCG" -c user.email=t@t -c user.name=t commit -qm base
out="$(cd "$TCG" && npm_lifecycle_event=prepublishOnly bash "$HERE/scripts/ci.sh" --tag-coherence-check 9.9.9 2>&1)"; rc=$?
{ [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'publish blocked'; } && ok "tag-coherence: untagged HEAD under prepublishOnly HARD-FAILS (publish blocked, no silent warn)" || no "untagged publish must be BLOCKED under prepublishOnly"
out="$(cd "$TCG" && npm_lifecycle_event=ci bash "$HERE/scripts/ci.sh" --tag-coherence-check 9.9.9 2>&1)"; rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'not tagged'; } && ok "tag-coherence: untagged HEAD in local validation WARNs but passes (exit 0)" || no "local validation should warn, not block, on an untagged HEAD"
# annotated tag needs a tagger identity — the suite runs under an isolated HOME with no global git
# config (GIT_CONFIG_GLOBAL=/dev/null), so pass -c like the commits above or the tag silently won't form.
git -C "$TCG" -c user.email=t@t -c user.name=t tag -a v9.9.9 -m v9.9.9
( cd "$TCG" && npm_lifecycle_event=prepublishOnly bash "$HERE/scripts/ci.sh" --tag-coherence-check 9.9.9 >/dev/null 2>&1 ); [ "$?" -eq 0 ] && ok "tag-coherence: HEAD correctly tagged v<ver> passes under prepublishOnly" || no "a correctly tagged HEAD must pass the publish guard"

# T65a3 — cycles are legal graph data but traversal must dedupe and terminate.
CYC="$(mktemp -d)"; git -C "$CYC" init -q
printf '{"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[{"from":"a.md","to":"b.md","kind":"derives-facts-from"},{"from":"b.md","to":"a.md","kind":"derives-facts-from"}]}\n' > "$CYC/.true-up.json"
printf 'a\n' > "$CYC/a.md"; printf 'b\n' > "$CYC/b.md"
git -C "$CYC" add -A && git -C "$CYC" -c user.email=t@t -c user.name=t commit -qm base
$TU --repo "$CYC" build >/dev/null 2>&1
js="$($TU --repo "$CYC" --impact a.md --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const all=[...(d.mechanical||[]),...(d.advisory||[])].map(x=>x.node);process.exit(d.counts.total===1&&all[0]==="file:b.md"?0:1)' && ok "cycle traversal terminates and dedupes dependents" || no "cycles must not recurse forever or report the seed as its own dependent"

# T65b..f — NEW-USER ONBOARDING regressions (v0.1.3). Provenance: a 3-agent new-user onboarding workflow
# found that `status` (the advertised first command) said "GREEN ✓ (nothing to do)" on an un-wired
# (INERT) graph — telling a brand-new adopter they were DONE while the tool tracked nothing. These pin
# the fix: an inert graph is an ORIENTATION state that routes to the wire-up recipe, never a false green.
# (capture-then-grep, not pipe-through: status exits 0, but keep the harness's no-pipe-through-gate rule.)
# T65b — built + clean + INERT must NOT claim GREEN; it must route to wiring (the load-bearing fix).
out="$($TU --repo "$ST" status 2>&1)"
{ echo "$out" | grep -q 'TRACKING NOTHING' && ! echo "$out" | grep -q 'GREEN ✓ (nothing to do)'; } && ok "status on a built INERT graph does NOT say GREEN — routes to wiring" || no "inert status must not claim GREEN/nothing-to-do"
js="$($TU --repo "$ST" status --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const nc=d.nextCommands.join("\n");process.exit(d.tracking===false&&d.green===false&&d.graph.declaredEdges===0&&!d.nextCommands.includes("(green — nothing to do)")&&/seed|robot-docs|declare/.test(nc)?0:1)' && ok "status --json (inert): green=false + tracking=false + nextCommands routes to wiring (structured agrees with text)" || no "status --json inert must report green=false + route to wiring"
# T65c — an auto-detected symlink edge must NOT mask an un-wired repo (declaredEdges excludes symlink basis).
SY="$(mktemp -d)"; git -C "$SY" init -q
printf 'd\n' > "$SY/doc.md"; ln -s doc.md "$SY/link.md"; git -C "$SY" add -A && git -C "$SY" -c user.email=t@t -c user.name=t commit -qm i
js="$($TU --repo "$SY" status --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.graph.edges>=1&&d.graph.declaredEdges===0&&d.tracking===false?0:1)' && ok "symlink-only repo stays INERT (auto symlink edge does not mask an un-wired repo)" || no "symlink must not flip tracking true"
# build/graph --json expose the SAME tracking signal as status (structured consumers see it too).
bj="$($TU --repo "$SY" --no-write --json 2>/dev/null)"
printf '%s' "$bj" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.edges>=1&&d.declaredEdges===0&&d.tracking===false?0:1)' && ok "build --json exposes declaredEdges/tracking (symlink-only ⇒ tracking=false)" || no "build --json must expose tracking signal"
printf '{"facts":{"data.json":[["items","id"]]},"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[{"from":"doc.md","to":"data.json#items.a"}]}\n' > "$SY/.true-up.json"
printf '{"items":[{"id":"a","v":1}]}\n' > "$SY/data.json"
printf 'd v1 <!-- fact: data.json#items.a -->\n' > "$SY/doc.md"
$TU --repo "$SY" build >/dev/null 2>&1; git -C "$SY" add -A && git -C "$SY" -c user.email=t@t -c user.name=t commit -qm wired
printf 'd v2 <!-- fact: data.json#items.a -->\n' > "$SY/doc.md"; $TU --repo "$SY" build >/dev/null 2>&1
js="$($TU --repo "$SY" --impact doc.md --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit((d.mechanical||[]).some(x=>x.kind==="alias-of"&&x.node==="file:link.md")?0:1)' && ok "explicit impact still reports symlink alias dependents" || no "explicit impact must keep alias-of in blast-radius list"
js="$($TU --repo "$SY" --impact --since HEAD --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.counts.total===0&&!(d.mechanical||[]).some(x=>x.kind==="alias-of")?0:1)' && ok "--impact --since does not report live symlink aliases as remaining stale work" || no "--impact --since must not treat live symlink aliases as stale"
js="$($TU --repo "$SY" --impact --since HEAD --proof --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const deps=(d.proof.sources||[]).flatMap(s=>s.dependents||[]);process.exit(deps.some(x=>x.node==="file:link.md"&&x.status==="satisfied-by-live-alias")&&d.proof.summary.uniqueSatisfiedByAlias===1?0:1)' && ok "--impact --proof marks live symlink aliases as satisfied, not missing edits" || no "--impact --proof must distinguish live alias satisfaction"
js="$($TU --repo "$SY" run --since HEAD --no-write --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.mechanical===0&&Array.isArray(d.wouldRegenerate)&&d.wouldRegenerate.length===0?0:1)' && ok "run --no-write does not count live symlink aliases as mechanical work" || no "run must not report symlink aliases as runnable mechanical work"
js="$($TU --repo "$SY" status --since HEAD --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const nc=d.nextCommands.join("\n");process.exit(d.tracking===true&&d.gateGreen===true&&d.impactPending===false&&d.green===true&&d.impact.mechanical.length===0&&!/regenerate/.test(nc)?0:1)' && ok "status does not loop on already-satisfied symlink alias impact" || no "status must not ask agents to regenerate live symlink aliases"
# T65d — once a REAL edge is wired, status returns to a normal GREEN verdict (no false onboarding alarm).
WI="$(mktemp -d)"; git -C "$WI" init -q
printf '{"facts":{"data.json":[["items","id"]]},"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[{"from":"doc.md","to":"data.json#items.a","kind":"derives-facts-from"}]}' > "$WI/.true-up.json"
printf '{"items":[{"id":"a","v":1}]}' > "$WI/data.json"; printf 'a <!-- fact: data.json#items.a -->\n' > "$WI/doc.md"
$TU --repo "$WI" build >/dev/null 2>&1; git -C "$WI" add -A && git -C "$WI" -c user.email=t@t -c user.name=t commit -qm i
js="$($TU --repo "$WI" status --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.tracking===true&&d.graph.declaredEdges>=1&&d.green===true?0:1)' && ok "wired repo: status tracking=true + GREEN (no false onboarding alarm)" || no "wired repo must read tracking/green"
# T65e — status `.green` must mean "no required truing-up work", not merely "cache/gates are clean".
# A changed source with an unedited advisory dependent is work pending; after the dependent is edited in
# the same range, status may be green and must not emit rewrite-flavored nextCommands.
SG="$(mktemp -d)"; git -C "$SG" init -q
printf '{"facts":{"data.json":[["items","id"]]},"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[{"from":"doc.md","to":"data.json#items.a"}]}\n' > "$SG/.true-up.json"
printf '{"items":[{"id":"a","v":1}]}\n' > "$SG/data.json"
printf 'a is 1. <!-- fact: data.json#items.a -->\n' > "$SG/doc.md"
git -C "$SG" add -A && git -C "$SG" -c user.email=t@t -c user.name=t commit -qm base
$TU --repo "$SG" build >/dev/null 2>&1
printf '{"items":[{"id":"a","v":2}]}\n' > "$SG/data.json"
$TU --repo "$SG" build >/dev/null 2>&1
js="$($TU --repo "$SG" status --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const nc=d.nextCommands.join("\n");process.exit(d.green===false&&d.impactPending===true&&/--proof/.test(nc)&&/review 1 advisory/.test(nc)&&/--since \x27HEAD\x27/.test(nc)?0:1)' && ok "status: pending advisory impact makes green=false + shell-quoted proof-oriented nextCommand" || no "status must not be green while advisory impact is pending"
printf 'a is 2. <!-- fact: data.json#items.a -->\n' > "$SG/doc.md"
$TU --repo "$SG" build >/dev/null 2>&1
js="$($TU --repo "$SG" status --json 2>/dev/null)"
printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const nc=d.nextCommands.join("\n");process.exit(d.green===true&&d.impactPending===false&&nc.includes("(green — nothing to do)")&&!/rewrite|review [0-9]+ advisory/.test(nc)?0:1)' && ok "status: already-edited dependent returns green with no rewrite-flavored nextCommand" || no "green status must not emit rewrite/review nextCommands"

# T65f — init scaffolds a copy-paste _seed_example and points to the IN-TOOL robot-docs (NOT docs/CONFIG.md, which an adopter's repo lacks).
IN="$(mktemp -d)"; git -C "$IN" init -q; printf 'x\n' > "$IN/f"; git -C "$IN" add -A && git -C "$IN" -c user.email=t@t -c user.name=t commit -qm i
initout="$($TU --repo "$IN" init 2>&1)"
{ echo "$initout" | grep -q 'robot-docs' && ! echo "$initout" | grep -q 'docs/CONFIG.md'; } && ok "init message points to in-tool robot-docs, not the dead docs/CONFIG.md breadcrumb" || no "init must point to robot-docs"
node -e 'const c=require("'"$IN"'/.true-up.json");process.exit(c._seed_example&&c._seed_example.from&&c._seed_example.to&&c._seed_example.kind==="derives-facts-from"?0:1)' && ok "init scaffolds a _seed_example edge showing the shape" || no "init must scaffold _seed_example"
$TU --repo "$IN" --no-write >/dev/null 2>&1 && ok "scaffold with _seed_example builds cleanly (unknown key ignored, not fatal)" || no "_seed_example must not break build"
# T65g — build INERT NOTICE points to robot-docs (in-tool), not the dead docs/CONFIG.md breadcrumb.
nb="$($TU --repo "$IN" 2>&1)"
{ echo "$nb" | grep -q 'NOTICE' && echo "$nb" | grep -q 'robot-docs' && ! echo "$nb" | grep -q 'docs/CONFIG.md'; } && ok "build INERT NOTICE points to robot-docs, not docs/CONFIG.md" || no "build NOTICE breadcrumb must be in-tool"

# T66 — `robot-docs`: in-tool handbook, works OUTSIDE a git repo (like --help), writes nothing.
ND2="$(mktemp -d)"; out="$(cd "$ND2" && $TU robot-docs 2>&1)"; rc=$?
{ [ "$rc" -eq 0 ] && echo "$out" | grep -q 'true-up status' && echo "$out" | grep -q 'true-up graph --json' && echo "$out" | grep -Fq '"seed": [{' && echo "$out" | grep -q '"from": "doc.md"' && echo "$out" | grep -q '"generated-from"' && [ -z "$(ls -A "$ND2")" ]; } && ok "robot-docs prints a handbook outside a repo + graph/seed/generated examples + writes nothing" || no "robot-docs must work anywhere + include graph/seed/generated examples + write nothing (rc=$rc)"

# T67 — intent inference: semantic + cross-prefix + global-flag guesses redirect to the RIGHT command.
# (capture-then-grep: these commands exit 2, so a direct `| grep` would mask the match under pipefail.)
o="$($TU --repo "$FIX" update 2>&1)";       echo "$o" | grep -q 'did you mean: run'        && ok "intent: update → run (synonym, not lexical 'gate')" || no "update→run synonym"
o="$($TU --repo "$FIX" docs 2>&1)";         echo "$o" | grep -q 'did you mean: robot-docs' && ok "intent: docs → robot-docs" || no "docs→robot-docs"
o="$($TU --repo "$FIX" imapct x 2>&1)";     echo "$o" | grep -q -- '--impact'              && ok "intent: imapct → --impact (cross-prefix)" || no "imapct→--impact"
o="$($TU --repo "$FIX" --jsno --check 2>&1)"; echo "$o" | grep -q -- '--json'              && ok "intent: --jsno → --json (global-flag typo)" || no "--jsno→--json"

# T68 — discovery errors honor --json (unknown command/flag emit {ok:false} on stdout, not empty). ROOT-5.
js="$($TU --repo "$FIX" --json zzzcmd 2>/dev/null)"; printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===false&&d.kind==="unknown-command"?0:1)' && ok "unknown-command --json → {ok:false,kind}" || no "unknown-command json"
js="$($TU --repo "$FIX" --json --check --comitted 2>/dev/null)"; printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.kind==="unknown-flag"&&d.didYouMean==="--committed"?0:1)' && ok "unknown-flag --json → kind + didYouMean" || no "unknown-flag json"

# T69 — Axiom 14: a stray positional on a no-positional command is exit 2 (gate zzz no longer PASSes).
$TU --repo "$FIX" gate zzz >/dev/null 2>&1; [ $? -eq 2 ] && ok "gate <stray-arg> exits 2 (no silent PASS)" || no "gate must reject stray positionals"
$TU --repo "$FIX" status extra >/dev/null 2>&1; [ $? -eq 2 ] && ok "status <stray-arg> exits 2" || no "status must reject stray positionals"

# T70 — uniform envelope: every read-side command answers .ok (boolean) + ._v (one jq question works everywhere).
UE="$(mktemp -d)"; git -C "$UE" init -q
printf '{"facts":{"data.json":[["items","id"]]},"zones":[{"path":"","visibility":"public","audience":"world","intent":"p","rules":[]}],"seed":[{"from":"doc.md","to":"data.json#items.a"}]}' > "$UE/.true-up.json"
printf '{"items":[{"id":"a","v":1}]}' > "$UE/data.json"; printf 'a <!-- fact: data.json#items.a -->\n' > "$UE/doc.md"
git -C "$UE" add -A && git -C "$UE" -c user.email=t@t -c user.name=t commit -qm i
$TU --repo "$UE" build >/dev/null 2>&1
ok_v=1
for spec in "--check" "--policy" "--externalities" "--verify-scope" "--impact data.json#items.a" "gate" "status"; do
  js="$($TU --repo "$UE" $spec --json 2>/dev/null)"
  printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(typeof d.ok==="boolean"&&d._v===1?0:1)' || ok_v=0
done
[ "$ok_v" = 1 ] && ok "every read-side command emits .ok (boolean) + ._v (uniform envelope)" || no "read-side envelope must carry .ok + ._v"

# T71 — run --json REAL path carries advisoryWorklist (parity with --no-write; no second --impact call). ROOT-5.
printf '{"items":[{"id":"a","v":2}]}' > "$UE/data.json"
js="$($TU --repo "$UE" run --since HEAD --json 2>/dev/null)"; printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(Array.isArray(d.advisoryWorklist)&&d.advisoryWorklist[0]&&d.advisoryWorklist[0].doc==="doc.md"?0:1)' && ok "run --json (real path) emits advisoryWorklist (doc←fact)" || no "run advisoryWorklist asymmetry"
git -C "$UE" checkout -q data.json 2>/dev/null

# T72 — capabilities completeness (contract-drift guard): quickstart + entrypoints + cmd_flags present;
# every CMD_FLAGS flag visible (so --force/--uninstall can't silently drop); --print gone; new cmds listed.
caps="$($TU --repo "$FIX" capabilities 2>/dev/null)"
printf '%s' "$caps" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const t=JSON.stringify(d);process.exit(d.quickstart&&d.entrypoints&&d.cmd_flags&&t.includes("--force")&&t.includes("--uninstall")&&!t.includes("--print")?0:1)' && ok "capabilities: quickstart/entrypoints/cmd_flags present; --force/--uninstall documented; --print gone" || no "capabilities contract completeness"
printf '%s' "$caps" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const n=d.commands.map(c=>c.name.split(" ")[0]);process.exit(n.includes("status")&&n.includes("graph")&&n.includes("build")&&n.includes("robot-docs")?0:1)' && ok "capabilities lists status/graph/build/robot-docs" || no "new commands missing from capabilities"
printf '%s' "$caps" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=d.source_of_truth&&d.source_of_truth.declared_seed_edges||"";process.exit(s.includes("\"seed\"")&&s.includes("\"from\"")&&s.includes("\"to\"")&&s.includes("path#fact")&&s.includes("generated-from")&&s.includes("\"via\"")?0:1)' && ok "capabilities documents marker-free advisory + generated seed shapes" || no "capabilities must include concrete seed/generated guidance"

# T73 — DOCS-IN-SYNC GATE (harness-engineering: true-up's OWN README once went stale — documenting a
# tool whose whole job is keeping things in sync. NEVER AGAIN). The user/agent-facing docs (README.md,
# SKILL.md) MUST document every command in `true-up capabilities`. Add/rename/remove a command without
# updating the docs → this FAILS (in npm test + CI), so a drifted doc can't ship. AGENTS.md (maintainer)
# is tracked separately via the .true-up.json contract seed.
caps_cmds=$($TU capabilities --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const names=d.commands.map(c=>c.name.split(/[ \[]/)[0]).filter(n=>n&&!n.startsWith("("));process.stdout.write([...new Set(names)].join("\n"))')
docs_missing=""
for cmd in $caps_cmds; do
  grep -qF -- "$cmd" "$HERE/README.md" || docs_missing="$docs_missing README:$cmd"
  grep -qF -- "$cmd" "$HERE/SKILL.md"   || docs_missing="$docs_missing SKILL:$cmd"
done
[ -z "$docs_missing" ] && ok "DOCS-IN-SYNC: every \`capabilities\` command is documented in README.md + SKILL.md" || no "docs out of sync — undocumented commands:$docs_missing"

# T74 — MARKER-FREE SELF-DOGFOOD GATE. true-up trues up its OWN repo with ZERO inline markers: every edge
# is a sidecar `seed` (declared) in .true-up.json, or a symlink alias. This was CLAIMED in AGENTS.md but
# never asserted. Now it is: the self-build must have NO 'anchored' or 'generator' edges (the inline-marker
# bases). Drop a <!-- fact: --> or true-up:anchor into a true-up source file and this fails — use a seed.
marker_edges=$($TU --repo "$HERE" --no-write --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const b=d.byDirectionBasis||{};process.stdout.write(String((b.anchored||0)+(b.generator||0)))')
[ "$marker_edges" = "0" ] && ok "MARKER-FREE: true-up's own repo has 0 inline-marker edges (all declared seed / symlink)" || no "true-up's own repo grew an inline-marker edge (anchored+generator=$marker_edges) — declare it as a .true-up.json seed instead"
self_guidance=$($TU --repo "$HERE" --no-write --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const edges=d.graph&&d.graph.edges||[];const hasGuide=(d.graph&&d.graph.nodes&&d.graph.nodes["fact:meta/contract.json#agent_guidance.declared-seed-edge"]);const hasConfig=edges.some(e=>e.from==="file:docs/CONFIG.md"&&e.to==="fact:meta/contract.json#agent_guidance.declared-seed-edge"&&e.directionBasis==="declared");const hasReadme=edges.some(e=>e.from==="file:README.md"&&e.to==="fact:meta/contract.json#agent_guidance.declared-seed-edge"&&e.directionBasis==="declared");process.stdout.write(hasGuide&&hasConfig&&hasReadme?"yes":"no")')
[ "$self_guidance" = "yes" ] && ok "SELF-TRUE-UP: marker-free seed guidance is a contract fact linked to README + docs/CONFIG" || no "seed guidance must be represented in meta/contract and linked by .true-up.json"
self_docs=$($TU --repo "$HERE" --no-write --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const g=d.graph||{};const n=g.nodes||{};const e=g.edges||[];const requiredNodes=["file:.gitignore","file:.true-up.json","file:README.md","file:SKILL.md","file:AGENTS.md","file:CLAUDE.md","file:docs/CONFIG.md","file:PUBLISHING.md","file:CHANGELOG.md","file:package.json","file:bun.lock","file:scripts/ci.sh","file:tests/engine.sh","file:bin/true-up","file:lib/engine.mjs","file:lib/symbols.mjs","file:meta/build-contract.mjs","file:meta/contract.json","file:install.sh","file:workflows/README.md","file:workflows/maintenance.workflow.js","file:workflows/audit.workflow.js"];const nodesOk=requiredNodes.every(x=>n[x])&&!n["file:.github/workflows/true-up.yml"];const nodeOk=n["file:README.md"]?.audience==="external-users-and-agents"&&n["file:SKILL.md"]?.audience==="external-agents"&&n["file:AGENTS.md"]?.audience==="maintainer-agents"&&n["file:CLAUDE.md"]?.audience==="maintainer-agents"&&n["file:docs/CONFIG.md"]?.audience==="adopters-and-agents"&&n["file:PUBLISHING.md"]?.audience==="credentialed-release-agents"&&n["file:scripts/ci.sh"]?.audience==="release-agents-and-maintainers"&&n["file:.true-up.json"]?.audience==="maintainer-agents";const edge=(from,to,kind)=>e.some(x=>x.from===from&&x.to===to&&x.directionBasis==="declared"&&(!kind||x.kind===kind));const edgeOk=edge("file:README.md","file:docs/CONFIG.md")&&edge("file:README.md","file:.true-up.json")&&edge("file:SKILL.md","file:README.md")&&edge("file:SKILL.md","file:docs/CONFIG.md")&&edge("file:AGENTS.md","file:README.md")&&edge("file:AGENTS.md","file:SKILL.md")&&edge("file:AGENTS.md","file:docs/CONFIG.md")&&edge("file:AGENTS.md","file:tests/engine.sh")&&edge("file:AGENTS.md","file:lib/engine.mjs")&&edge("file:AGENTS.md","file:scripts/ci.sh")&&edge("file:PUBLISHING.md","file:package.json")&&edge("file:PUBLISHING.md","file:bun.lock")&&edge("file:PUBLISHING.md","file:CHANGELOG.md")&&edge("file:PUBLISHING.md","file:scripts/ci.sh")&&edge("file:workflows/README.md","file:workflows/maintenance.workflow.js")&&edge("file:workflows/README.md","file:workflows/audit.workflow.js")&&edge("file:meta/contract.json","file:lib/engine.mjs","generated-from")&&edge("file:meta/contract.json","file:meta/build-contract.mjs","generated-from");process.stdout.write(nodesOk&&nodeOk&&edgeOk?"yes":"no")')
[ "$self_docs" = "yes" ] && ok "SELF-TRUE-UP: first-class files, audiences, release/local-CI/workflow deps are graph data" || no "self graph must model first-class files, audiences, and release/local-CI/workflow deps"
workflow_audiences=$($TU --repo "$HERE" --no-write --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const n=d.graph?.nodes||{};process.stdout.write(n["file:workflows/README.md"]?.audience==="external-agents"&&n["file:workflows/maintenance.workflow.js"]?.audience==="external-agents"&&n["file:workflows/audit.workflow.js"]?.audience==="external-agents"?"yes":"no")')
[ "$workflow_audiences" = "yes" ] && ok "SELF-TRUE-UP: workflow templates are explicitly external-agent artifacts" || no "workflow templates must be audience-stamped as external-agent artifacts"
readme_cmd_edges=$($TU --repo "$HERE" --no-write --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const nodes=d.graph?.nodes||{};const edges=d.graph?.edges||[];const facts=Object.keys(nodes).filter(k=>k.startsWith("fact:meta/contract.json#commands."));const missing=facts.filter(to=>!edges.some(e=>e.from==="file:README.md"&&e.to===to&&e.directionBasis==="declared"));process.stdout.write(missing.join("\\n"))')
[ -z "$readme_cmd_edges" ] && ok "SELF-TRUE-UP: README has declared edges to every command fact" || no "README missing command-fact seed edges:$readme_cmd_edges"

# ── DOC-TRUTH gates (a doc-fact-check workflow found drift the command-coverage gate was blind to) ──

# T75 — DOCS FLAG-COVERAGE: every per-command flag in capabilities.cmd_flags must be documented in
# README.md (the canonical reference). Catches a flag added to the engine but never documented — the
# `status --committed` class (a flag in the contract that no command actually honored).
caps_flags=$($TU capabilities --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const f=d.cmd_flags||{};const o=[];for(const k of Object.keys(f))for(const fl of f[k])o.push(fl);process.stdout.write([...new Set(o)].join("\n"))')
flags_missing=""
for fl in $caps_flags; do grep -qF -- "$fl" "$HERE/README.md" || flags_missing="$flags_missing $fl"; done
[ -z "$flags_missing" ] && ok "DOCS-FLAGS: every capabilities cmd-flag is documented in README.md" || no "undocumented flags in README:$flags_missing"

# T76 — NO STALE init EXIT-1 CLAIM. init is idempotent (capabilities exits:[0]). PROVE it by running
# init twice, THEN assert no user/agent doc still claims init "refuses to overwrite … exit 1".
IT76="$(mktemp -d)"; git -C "$IT76" init -q
$TU --repo "$IT76" init >/dev/null 2>&1
$TU --repo "$IT76" init >/dev/null 2>&1; rc76=$?
init_bad=""
for f in README.md SKILL.md docs/CONFIG.md; do grep -nE 'refuses to overwrite' "$HERE/$f" 2>/dev/null | grep -qE 'exit 1' && init_bad="$init_bad $f"; done
{ [ "$rc76" -eq 0 ] && [ -z "$init_bad" ]; } && ok "init is idempotent (exit 0) and no doc claims 'refuses to overwrite … exit 1'" || no "init exit-1 drift (second-run rc=$rc76; stale docs:$init_bad)"

# T77 — NO INTERNAL JARGON in user-facing surfaces. Tier 1/Tier 2 and Axiom N are maintainer-only
# (AGENTS.md / CLAUDE.md). Scan the user/agent docs AND the installer's user-visible --help output.
jargon_hits=""
for f in README.md SKILL.md docs/CONFIG.md CHANGELOG.md; do grep -Eq "Tier 1|Tier 2|Axiom [0-9]" "$HERE/$f" 2>/dev/null && jargon_hits="$jargon_hits $f"; done
ihelp="$(bash "$HERE/install.sh" --help 2>/dev/null)"
echo "$ihelp" | grep -Eq "Tier 1|Tier 2|Axiom [0-9]" && jargon_hits="$jargon_hits install.sh(--help)"
[ -z "$jargon_hits" ] && ok "NO-JARGON: user-facing docs + installer --help carry no Tier/Axiom internal jargon" || no "internal jargon leaked to users in:$jargon_hits"

# T78 — INSTALLER --help MUST NOT LEAK SOURCE (the help handler seds a comment range; an over-wide
# range prints real code — the audit caught exactly this).
echo "$ihelp" | grep -qE 'set -euo pipefail|^REPO_SLUG=|umask |shopt -s' && no "install.sh --help leaks source code (sed range overshoots the comment header)" || ok "install.sh --help renders only the comment header (no source leak)"

# ============================================================================
# JJ-ONLY VCS CONFORMANCE. These are harness-engineering guardrails for the bug class:
# true-up used to require `git rev-parse --show-toplevel`, which excludes non-colocated jj repos
# (`jj git init --no-colocate`: .jj exists, no .git in the worktree). Colocated jj already works via
# Git plumbing; these tests pin the jj-only adapter surface directly.
# ============================================================================
if [ "$HAS_JJ" = 1 ]; then
  export HOME="$JJ_HOME"   # run the jj subsuite under the HOME where jj actually works (see probe above);
                           # git-hooks safety is unaffected (GIT_CONFIG_* overrides neutralize it regardless).
  JJO="$(mktemp -d)"
  jj git init --no-colocate "$JJO" >/dev/null 2>&1
  cat > "$JJO/.true-up.json" <<'JSON'
{
  "facts": { "data.json": [["items", "id"]] },
  "zones": [
    { "path": "", "visibility": "public", "audience": "world", "intent": "public-default", "rules": ["no-machine-local-paths"] }
  ],
  "seed": [
    { "from": "doc.md", "to": "data.json#items.a", "kind": "derives-facts-from" },
    { "from": "span-doc.md", "to": "tool.py#api", "kind": "derives-facts-from" }
  ]
}
JSON
  printf '{"items":[{"id":"a","v":1}]}\n' > "$JJO/data.json"
  printf 'a <!-- fact: data.json#items.a -->\n' > "$JJO/doc.md"
  printf 'span <!-- fact: tool.py#api -->\n' > "$JJO/span-doc.md"
  printf '%s\n' '# true-up:anchor id=api' 'def f():' '    return 1' '# true-up:end' > "$JJO/tool.py"

  js="$($TU --repo "$JJO" --json build 2>/dev/null)"; rc=$?
  { [ "$rc" -eq 0 ] && printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===true&&d.inert===false&&d.factNodes>=2&&d.edges>=3?0:1)'; } && ok "jj-only: build creates a non-inert graph with JSON + span facts" || no "jj-only build must work without a worktree .git (rc=$rc)"
  $TU --repo "$JJO" --check >/dev/null 2>&1 && ok "jj-only: --check passes after build" || no "jj-only --check must pass after build"
  mkdir -p "$JJO/deep/subdir"
	  js="$(cd "$JJO/deep/subdir" && $TU status --json 2>/dev/null)"; rc=$?
	  { [ "$rc" -eq 0 ] && printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.workspace&&d.workspace.vcs==="jj"&&d.workspace.root===process.argv[1]&&d.workspace.cwdRelative==="deep/subdir"&&d.workspace.since==="@-"&&d.workspace.git===null&&d.workspace.jj&&d.workspace.jj.colocated===false?0:1)' "$JJO"; } && ok "jj-only: status works from nested subdirs and exposes uniform workspace schema" || no "jj-only nested subdir status must resolve workspace root (rc=$rc)"
	  $TU --repo "$JJO/no-such-dir" status >/dev/null 2>&1; [ "$?" -eq 2 ] && ok "jj-only: explicit nonexistent --repo path fails closed" || no "jj-only nonexistent --repo must not retarget parent workspace"
	  $TU --repo "$JJO/data.json" status >/dev/null 2>&1; [ "$?" -eq 2 ] && ok "jj-only: explicit file --repo path fails closed" || no "jj-only file --repo must not retarget parent workspace"
	  $TU --repo "$JJO" --impact 'data.json#items.a' 2>/dev/null | grep -q 'doc.md' && ok "jj-only: --impact resolves JSON fact dependents" || no "jj-only --impact JSON fact"
  $TU --repo "$JJO" --impact 'tool.py#api' 2>/dev/null | grep -q 'span-doc.md' && ok "jj-only: span anchors are discovered without git grep" || no "jj-only span anchor impact"

  jj -R "$JJO" commit -m init --no-pager >/dev/null 2>&1
  printf '{"items":[{"id":"a","v":2}]}\n' > "$JJO/data.json"
  out="$($TU --repo "$JJO" --impact --since @- 2>/dev/null)"; echo "$out" | grep -q 'doc.md' && ok "jj-only: --impact --since @- uses jj revsets" || no "jj-only --since @- impact"
  $TU --repo "$JJO" --impact --since not-a-real-jj-rev >/dev/null 2>&1; [ "$?" -eq 2 ] && ok "jj-only: bad --since revset exits 2" || no "jj-only bad --since must fail loud"
  js="$($TU --repo "$JJO" --check --committed --json 2>/dev/null)"; rc=$?
  { [ "$rc" -eq 1 ] && printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===false&&d.mode==="committed"?0:1)'; } && ok "jj-only: --check --committed fails on stale graph in @" || no "jj-only committed gate must fail on stale graph (rc=$rc)"
  $TU --repo "$JJO" build >/dev/null 2>&1
  $TU --repo "$JJO" --check --committed >/dev/null 2>&1 && ok "jj-only: --check --committed passes once @ includes rebuilt graph" || no "jj-only committed gate must pass after rebuild"
  printf 'path: /home/someuser/secret\n' > "$JJO/leak.md" # true-up:ignore-line no-machine-local-paths
  out="$($TU --repo "$JJO" --externalities 2>/dev/null)"; echo "$out" | grep -q '\[high\]' && ok "jj-only: externalities scans jj files" || no "jj-only externalities must scan files"
  $TU --repo "$JJO" hooks --install >/dev/null 2>&1; [ "$?" -eq 2 ] && ok "jj-only: hooks --install fails loud without git hooks" || no "jj-only hooks install must fail loud"

  JJC="$(mktemp -d)"
  jj git init --colocate "$JJC" >/dev/null 2>&1
  printf '{"facts":{"data.json":[["items","id"]]},"seed":[{"from":"doc.md","to":"data.json#items.a"}]}\n' > "$JJC/.true-up.json"
  printf '{"items":[{"id":"a","v":1}]}\n' > "$JJC/data.json"
  printf 'a <!-- fact: data.json#items.a -->\n' > "$JJC/doc.md"
  $TU --repo "$JJC" build >/dev/null 2>&1
  jj -R "$JJC" commit -m init --no-pager >/dev/null 2>&1
  js="$($TU --repo "$JJC" status --json 2>/dev/null)"
  printf '%s' "$js" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.workspace&&d.workspace.vcs==="git"&&d.workspace.jj&&d.workspace.jj.mode==="git-backed"?0:1)' && ok "colocated jj: status reports Git-backed jj workspace identity" || no "colocated jj status must expose git-backed jj mode"
  $TU --repo "$JJC" --check --committed >/dev/null 2>&1 && ok "colocated jj: existing Git-backed behavior still passes" || no "colocated jj regression"
else
  sk "jj-only VCS conformance ($JJ_SKIP)"
fi

echo
echo "engine tests: ${pass} passed, ${fail} failed, ${skip} skipped"
[ "$skip" = 0 ] || echo "  (skipped suites need optional devDeps — run \`npm install\` to enable them)"
[ "$fail" = 0 ] || exit 1
