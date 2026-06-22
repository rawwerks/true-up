# Publishing true-up to npm — handoff for a credentialed agent

**Status: the repo is publish-ready.** `true-up@0.1.0` (unscoped, **public**) is fully prepared,
validated by one local command, and tagged `v0.1.0`. The **only** thing you supply is npm credentials.
Do not edit source, metadata, or the version.

The trust anchor is the local CI — **`npm run ci`** ([`scripts/ci.sh`](scripts/ci.sh)) — which runs the
whole chain and exits nonzero on any failure: fixture suite + self-gate + contract `--check` + `npm pack`
+ clean-sandbox install of the tarball + lean check (tree-sitter NOT auto-pulled) + run-from-tarball
(build/`--check`/`gate`/`--no-write`/`capabilities`) + a negative gate check + tarball hygiene + version
coherence. It is **not** dependent on GitHub Actions (that workflow only mirrors this command).

## Preflight (all must hold — abort if any fails)

```sh
cd <true-up repo>
git fetch --tags origin && git checkout v0.1.0   # publish from the tagged, validated commit
git status --porcelain                            # MUST be empty (clean tree)
npm install                                        # install devDeps (tree-sitter) so `npm run ci` runs the
                                                   #   FULL Tier-2 suite. (npm run ci self-bootstraps this too,
                                                   #   but doing it here makes the preflight explicit.)
node -p "require('./package.json').private"        # MUST print: undefined  (the private gate is gone)
npm whoami                                         # MUST print your npm user (publish rights). Else: npm login
npm view true-up version                           # MUST be E404 or any version != 0.1.0. If it already
                                                   #   shows 0.1.0 → STOP, already published; do not republish.
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
npm view true-up version                  # MUST now print 0.1.0
npx -y true-up@0.1.0 --version            # MUST print: true-up 0.1.0
npx -y true-up@0.1.0 capabilities | head  # valid JSON; npx will NOT pull tree-sitter (peer deps are optional)
```

Then push the tag (the authorized public action for this task):

```sh
git push origin v0.1.0
```

## Rollback caveat

- `npm unpublish true-up@0.1.0` is allowed **only within 72h** of publishing; after that npm forbids it —
  ship a patch (`0.1.1`) instead.
- If the published tarball is wrong, prefer `npm deprecate true-up@0.1.0 "use 0.1.1"` + a fixed release
  over unpublish.

## What's already done (so you don't have to)

`private` removed · `files` allowlist (12-file, ~45 kB tarball — no tests/CI/dev cruft) · tree-sitter
moved to **optional peer deps** so `npx true-up` stays lean (core is zero-dep; symbols users add
`web-tree-sitter@0.24.7 tree-sitter-wasms@0.1.13`) · `repository`/`homepage`/`bugs`/`keywords` set ·
`prepublishOnly` → `npm run ci` · `CHANGELOG.md` + `README` npx snippet · `v0.1.0` tagged · `npm run ci`
green. Name `true-up` was unclaimed at prep time (re-confirm in preflight).
