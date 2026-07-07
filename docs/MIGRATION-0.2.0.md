# Migrating to true-up 0.2.0

true-up 0.2.0 adds inter-repo import/export snapshots and tightens privacy policy enforcement. It is
mostly additive, but it is not a patch release: existing repos can see new `--policy` failures if their
zone visibility values or dependency edges were relying on the old, path-name-based behavior.

## What can break

1. **Custom `visibility` strings now fail config validation.**
   `visibility` must be one of `public`, `internal`, `private`, or `secret`. Keep team-specific labels
   in `audience` or `intent`.

   ```json
   // before
   { "path": "team/", "visibility": "team", "audience": "payments", "intent": "team-notes" }

   // after
   { "path": "team/", "visibility": "internal", "audience": "payments", "intent": "team-notes" }
   ```

2. **Local lower-to-higher dependency edges now fail `--policy`.**
   The old `no-public->private-deps` rule name is kept for compatibility, but the rule now enforces the
   full lattice: `public < internal < private < secret`. A public doc deriving from a secret source is
   blocked even when the source path is `secret/` rather than `private/`.

3. **Inter-repo dependencies must use snapshots, not live paths.**
   A consumer must track or stage a regular in-repo snapshot file, pin `repoId` and `audience`, and seed
   edges to `@alias:fact`. Symlinked snapshots, untracked snapshots, path escapes, and live `../repo`
   seed targets fail closed.

## Upgrade checklist

1. Upgrade in a branch and inspect the tool contract:

   ```sh
   true-up --version
   true-up capabilities | head
   ```

2. Normalize zone visibility values:

   ```sh
   true-up --policy --report
   ```

   If config validation fails on a visibility value, map it to one of:

   - `public` — safe for everyone who can read the repo/package.
   - `internal` — team/org material that should not feed public artifacts without review.
   - `private` — sensitive repo-local material.
   - `secret` — highest sensitivity; avoid deriving public/internal artifacts from it.

   Preserve richer labels in `audience` and `intent`.

3. Audit local dependency edges:

   ```sh
   true-up --policy --json --report
   ```

   For each `no-public->private-deps` violation:

   - Move the dependent artifact into a zone with at least the source visibility, if it is not meant to
     be public.
   - Lower the source zone only if the source is genuinely less sensitive.
   - Split the source: create a public/internal steward fact or generated summary that is safe to cite.
   - Remove or narrow an incorrect `seed` edge.

   Do not suppress these violations by renaming directories. The rule uses zone visibility, not path
   substrings.

4. Migrate cross-repo dependencies to snapshots:

   In the source repo:

   ```json
   {
     "repoId": "payments-service",
     "exports": [
       { "id": "api.timeout", "from": "config/api.json#items.timeout", "audience": "public" }
     ]
   }
   ```

   ```sh
   true-up export --audience public > imports/payments.public.true-up-import.json
   ```

   In the consumer repo:

   ```json
   {
     "imports": {
       "payments": {
         "path": "imports/payments.public.true-up-import.json",
         "repoId": "payments-service",
         "audience": "public"
       }
     },
     "seed": [
       { "from": "README.md", "to": "@payments:api.timeout" }
     ]
   }
   ```

   If the exported source is `internal`, `private`, or `secret` and the snapshot audience is lower,
   require explicit `"declassify": true` on that export entry.

5. Rebuild and gate:

   ```sh
   true-up build
   true-up gate
   true-up status --since HEAD --json
   ```

   In repos that commit `.true-up/depgraph.json`, also run:

   ```sh
   true-up --check --committed
   ```

## Rollback

If the new policy exposes too much migration work for a branch, pin the old package while you fix
configuration:

```sh
npx true-up@0.1.4 gate
```

Do not publish new inter-repo snapshots with 0.1.4; the import/export privacy model is a 0.2.0 feature.
