# true-up workflows — the agentic layer

The true-up **CLI** is the deterministic core: it computes *what* changed and *what that makes stale*,
regenerates mechanical dependents, and gates (`--check`, `--policy`, `--externalities`, `--verify-scope`).
It never edits prose. These **workflows** are the thin agentic layer on top — they drive the CLI and let
an LLM make the one thing the CLI won't: the minimal advisory prose edit. There are two, for two
situations, and keeping them separate is the whole point.

| | [`maintenance`](./maintenance.workflow.js) (the default) | [`audit`](./audit.workflow.js) |
|---|---|---|
| When | every change — "I did some work, true it up" | deliberately — pre-release / periodic / post-refactor |
| Scope | **only the blast radius** of what changed | whole repo |
| Edits | regenerate mechanical + minimal advisory prose | **none — report-only** |
| Output | a GREEN, in-scope, idempotent working tree | a maintainer worklist + candidate edges |
| Decides | nothing the graph didn't already declare | nothing — it **proposes**, you ratify |

## The design rule: smallest correct change, deterministically bounded

> A clean repo is a no-op, and a second `run` is always a no-op. **Code golf is, by definition, a change a second run wouldn't ask for.**

Maintenance edits **only** files on the deterministic advisory worklist (the dependents of the facts that
actually moved). It deliberately leaves *undeclared* staleness alone — that's the audit's job. The
standing instruction is never "make all docs consistent/accurate" (that reliably induces scope creep);
it is "re-true exactly what the worklist names, minimally."

This is enforced two ways, belt-and-suspenders:
1. **Prompt discipline** (the worklist-subset rule in `maintenance.workflow.js`).
2. **A deterministic gate** — `true-up --verify-scope --since <ref>` fails if any changed file is not
   *explained* by the graph (the changed source, its regenerated/advisory dependents, or the cache),
   naming the offender. The workflow runs it in the Verify phase, so code-golf fails the run even if the
   prompt is ignored.

## Why two workflows, with evidence

We tested these as real workflows before shipping them (`see what works`). Two findings:

- **The deterministic worklist is the load-bearing anti-code-golf mechanism.** On a change with no
  tempting decoy, a *guarded* and an *unguarded* agent produced **byte-identical** diffs — both just
  followed the CLI's worklist. Running the CLI first is most of the protection.
- **The guard still earns its keep on tempting inputs.** With a decoy doc that *looked* stale (mentioned
  the changed term + its old value) but was **unanchored** (out of the blast radius), the unguarded
  "make all docs accurate" agent edited it **3/3** trials; the guarded worklist-subset agent edited it
  **0/3** — while both still reached GREEN and left the control untouched. The unguarded edits were
  *correct-but-out-of-bounds*: real staleness, fixed by a non-deterministic guess. That is exactly the
  failure mode (LLM deciding coverage) the whole system exists to prevent — so it belongs in the audit
  (which would *propose anchoring* the decoy), not in the maintenance hot path.

Net: **maintenance = deterministic worklist + bounded edits + GREEN/scope/idempotence gates, run often.
audit = whole-repo salience + lint coverage + drift, zero edits, proposes for human ratification, run
deliberately.** Never fold the audit's speculative missing-edge proposals into maintenance — that would
let a heuristic widen the blast radius and reintroduce code-golf.

## Invoking

Both read `args`:

```js
Workflow({ name: 'true-up-maintenance', args: { repo: '/abs/target', since: 'HEAD~1', bin: 'true-up' } })
Workflow({ name: 'true-up-audit',       args: { repo: '/abs/target', since: 'HEAD~5', bin: 'true-up' } })
```

- `args.repo` — target repo (default: the CWD repo via git toplevel).
- `args.since` — change range (default `HEAD~1`).
- `args.bin` — how to call the CLI (default `true-up`; not on PATH after a clone, so pass e.g.
  `node /abs/true-up/bin/true-up`).
