# Composed config example

This directory is a complete small repository layout for native config composition. The root manifest
keeps root-only settings; `config/true-up/core.json` owns source facts, while
`config/true-up/docs.json` owns audiences and documentation dependencies. Every path declared in a
fragment is relative to this directory, not to `config/true-up/`.

To try it without writing a graph, copy this directory to a new location, initialize Git, and track
the files:

```sh
git init
git add .
true-up build --no-write --json
true-up graph --json
true-up status --json
```

The output should report two fragments and three config sources. The two declared edges carry
`declaredIn.source: "config/true-up/docs.json"`.
