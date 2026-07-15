# Frozen pre-composition runtimes

These test-only fixtures make the old-loader compatibility regression independent of the current
checkout's Git history. Each `.tar.gz.b64` file is a deterministic `gzip -n -9` archive containing
only `bin/true-up`, `lib/engine.mjs`, `lib/symbols.mjs`, and `package.json` from the named revision.
They are excluded from the published npm package by `package.json`'s allowlist.

The focused CLI suite pins the compressed archive hash and every extracted file hash before it runs
the old binary. It also proves that a missing fixture, changed archive, or changed engine fails loud.

| Fixture | Source revision | Compressed archive SHA-256 |
|---|---|---|
| `v0.1.4.tar.gz.b64` | `4eb0e4ddf4eda309857a97a317424c2aea664250` | `b32785fafd386b0642b998a3fc260ca4b232b6152fcc8e4bd099a5a91de05f60` |
| `pre-v0.2.1.tar.gz.b64` | `7844b4f77f4cd74f7026edf8f7bf6811c6a11e65` | `d1f0f666f1c0934e1be849e0c5c24780c1035ea8d9004958d033989671882353` |

Maintainer reproduction, from a checkout that contains the historical object:

```sh
git archive --format=tar <revision> -- \
  bin/true-up lib/engine.mjs lib/symbols.mjs package.json \
  | gzip -n -9 \
  | base64 -w 76 > tests/fixtures/pre-composition/<fixture>.tar.gz.b64
```

Do not refresh a fixture just to make a hash assertion green. A replacement must be reviewed as an
intentional compatibility-baseline change, with its source revision and all pinned hashes updated.
