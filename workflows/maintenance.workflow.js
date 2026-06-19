export const meta = {
  name: 'true-up-maintenance',
  description: 'DEFAULT true-up: light maintenance after a change. Regenerate mechanical dependents, minimally re-true advisory prose, and gate on GREEN + --verify-scope + idempotence. Anti-code-golf by construction — stays strictly inside the deterministic blast radius.',
  phases: [
    { title: 'Detect + regenerate' },
    { title: 'Advisory (minimal edits)' },
    { title: 'Verify' },
  ],
}

// EMPIRICAL BASIS (see workflows/README.md): on a lexically-tempting decoy, an UNGUARDED
// "make all docs consistent/accurate" agent expanded scope past the blast radius to edit an
// unanchored stale doc 3/3 trials. This worklist-subset design did so 0/3, while still reaching
// GREEN — and `true-up --verify-scope` deterministically catches any over-reach that slips through.
// The standing rule: undeclared staleness is the AUDIT's job, never maintenance's.
//
// Invoke: Workflow({ name: 'true-up-maintenance', args: { repo: '/abs/target', since: 'HEAD~1', bin: 'true-up' } })
//   args.repo  target repo (default: the CWD repo, via git toplevel)
//   args.since change range  (default: HEAD~1)
//   args.bin   how to call true-up (default: 'true-up'; e.g. 'node /path/to/true-up/bin/true-up')
const repoArg = (args && args.repo) ? ` --repo ${args.repo}` : ''
const since = (args && args.since) || 'HEAD~1'
const TU = (args && args.bin) || 'true-up'
const repoLabel = (args && args.repo) ? args.repo : 'the current repo'

const WORKLIST = { type: 'object', additionalProperties: false, required: ['advisoryDocs', 'mechanicalRegenerated', 'green', 'notes'], properties: {
  advisoryDocs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'fact'], properties: { file: { type: 'string' }, fact: { type: 'string' } } } },
  mechanicalRegenerated: { type: 'array', items: { type: 'string' } }, green: { type: 'boolean' }, notes: { type: 'string' } } }
const VERIFY = { type: 'object', additionalProperties: false, required: ['green', 'scopeOk', 'idempotent', 'outOfScope', 'notes'], properties: {
  green: { type: 'boolean' }, scopeOk: { type: 'boolean' }, idempotent: { type: 'boolean' },
  outOfScope: { type: 'array', items: { type: 'string' }, description: 'files --verify-scope flagged as code-golf' }, notes: { type: 'string' } } }

phase('Detect + regenerate')
const work = await agent(
  `Run the deterministic true-up detect + regenerate step on ${repoLabel}, then report the advisory worklist. Do NOT edit any prose yourself in this step.
1. Run: \`${TU}${repoArg} run --since ${since}\`. It regenerates mechanical dependents (generated blocks) automatically and prints the ADVISORY worklist (prose needing a human/LLM edit, with which fact moved).
2. Return advisoryDocs (each file + the fact that moved), mechanicalRegenerated (artifacts it rewrote), and whether it is already GREEN (if 0 advisory, you're done).`,
  { phase: 'Detect + regenerate', schema: WORKLIST })

phase('Advisory (minimal edits)')
await parallel((work && work.advisoryDocs || []).map((d) => () => agent(
  `Re-true ONE doc after a fact moved. Target repo: ${repoLabel}. File: ${d.file}. Fact that moved: ${d.fact}.
RULES (anti-code-golf, non-negotiable):
- Edit ONLY ${d.file}. Touch no other file.
- Read the current source-of-truth for ${d.fact}, then make the MINIMAL, value-only correction at the cited location so the prose matches the new value.
- Do NOT reword, reflow, reformat, or "improve" surrounding prose. No "while I'm here" edits.
Report the one-line change you made.`,
  { label: `advisory:${d.file}`, phase: 'Advisory (minimal edits)' })))

phase('Verify')
const verify = await agent(
  `Verify the maintenance pass on ${repoLabel} is complete, in-scope, and idempotent. Run in order:
1. \`${TU}${repoArg} run --since ${since}\` — must report GREEN (0 advisory remaining, policy clean, depgraph in-sync).
2. \`${TU}${repoArg} --verify-scope --since ${since}\` — the anti-code-golf gate; must print "scope OK". If it names out-of-scope files, those are code-golf: report them in outOfScope and set scopeOk=false (do NOT edit further to "fix" them — that compounds the problem; the fix is to anchor them or revert the stray edit).
3. Run step 1 once more; confirm a no-op (no new worklist, no further file changes) — idempotence.
Report green / scopeOk / idempotent / outOfScope.`,
  { phase: 'Verify', schema: VERIFY })

return { worklist: work, verify }
