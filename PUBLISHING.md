# Publishing true-up@0.1.2 to npm — handoff for a credentialed agent

**Status: the repo is publish-ready for `true-up@0.1.2`.** The package is unscoped and public. The
release metadata, changelog, docs, harness, local commit, and local annotated tag are prepared; the
credentialed agent should only supply npm credentials, re-run the trust anchor, publish, and then push
the already-prepared commit/tag if authorized. Do not edit source, metadata, or the version.

The trust anchor is the local CI — **`npm run ci`** ([`scripts/ci.sh`](scripts/ci.sh)) — which runs the
whole chain and exits nonzero on any failure: fixture suite + self-gate + contract `--check` + `npm pack`
+ clean-sandbox install of the tarball + lean check (tree-sitter NOT auto-pulled) + run-from-tarball
(build/`--check`/`gate`/`--no-write`/`capabilities`) + a negative gate check + tarball hygiene + version
coherence. It is **not** dependent on GitHub Actions (that workflow only mirrors this command).

## Preflight (all must hold — abort if any fails)

```sh
cd <true-up repo>
git fetch --tags origin
git checkout main                                 # publish from the local release commit
git tag --points-at HEAD | grep -qx 'v0.1.2'      # MUST be tagged exactly for this release
git status --porcelain                            # MUST be empty (clean tree)
node -p "require('./package.json').private"        # MUST print: undefined  (the private gate is gone)
npm whoami                                         # MUST print your npm user (publish rights). Else: npm login
npm view true-up version                           # At handoff time this was 0.1.1; re-confirm it is != 0.1.2.
npm view true-up@0.1.2 version                     # MUST be E404/404. If it prints 0.1.2 → STOP, already published.
npm run ci                                         # MUST exit 0 — the trust anchor. If red, STOP and report.
```

> Do **not** trust `npm publish --dry-run` as the gate — it exits 0 even with `private:true` and skips the
> private check. The real gate is `npm run ci` green + `private` removed (both already done here).

## Publish (exact command)

```sh
npm publish
```

- `true-up` is **unscoped**, so it is public by default — do **not** add `--access public` (that flag is
  only for scoped `@org/name` packages).
- `prepublishOnly` re-runs `npm run ci` automatically and fail-closes if anything broke.

## Post-publish verification (from a clean dir, e.g. `cd $(mktemp -d)`)

```sh
npm view true-up version                  # MUST now print 0.1.2
npx -y true-up@0.1.2 --version            # MUST print: true-up 0.1.2
npx -y true-up@0.1.2 capabilities | head  # valid JSON; npx will NOT pull tree-sitter (peer deps are optional)
```

Then, if you are also authorized to update GitHub, push the prepared commit and tag with the local
safe wrapper:

```sh
safe-push origin main
safe-push origin v0.1.2
```

## Rollback caveat

- `npm unpublish true-up@0.1.2` is allowed **only within 72h** of publishing; after that npm forbids it —
  ship a patch (`0.1.3`) instead.
- If the published tarball is wrong, prefer `npm deprecate true-up@0.1.2 "use 0.1.3"` + a fixed release
  over unpublish.

## What's already done (so you don't have to)

`private` removed · `files` allowlist (12-file tarball — no tests/CI/dev cruft) · tree-sitter
moved to **optional peer deps** so `npx true-up` stays lean (core is zero-dep; symbols users add
`web-tree-sitter@0.24.7 tree-sitter-wasms@0.1.13`) · `repository`/`homepage`/`bugs`/`keywords` set ·
`prepublishOnly` → `npm run ci` · `CHANGELOG.md` release notes · `v0.1.2` locally tagged · `npm run ci`
green. Registry latest was `0.1.1` at handoff time; re-confirm in preflight.
