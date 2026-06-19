export const meta = {
  name: 'true-up-audit',
  description: 'Exhaustive, REPORT-ONLY true-up audit: full lint + coverage gaps, unresolved anchors, latent drift, and git-co-change candidate MISSING edges. Proposes, never decides — edits nothing. Run deliberately (pre-release / periodically), NOT on every change.',
  phases: [
    { title: 'Scan' },
    { title: 'Report' },
  ],
}

// The audit is the counterpart to maintenance: maintenance stays inside the deterministic blast
// radius (and leaves undeclared staleness alone); the audit is where undeclared staleness, lint
// coverage gaps, and MISSING edges surface — as PROPOSALS a maintainer ratifies, never auto-applied.
// This mirrors the load-bearing invariant: change-impact is deterministic; correlation (co-change)
// may PROPOSE a candidate edge but never assigns the arrow. (see workflows/README.md)
//
// Invoke: Workflow({ name: 'true-up-audit', args: { repo: '/abs/target', since: 'HEAD~5', bin: 'true-up' } })
const repoArg = (args && args.repo) ? ` --repo ${args.repo}` : ''
const gitC = (args && args.repo) ? ` -C ${args.repo}` : ''
const TU = (args && args.bin) || 'true-up'
const sinceN = (args && args.since) || 'HEAD~1'
const repoLabel = (args && args.repo) ? args.repo : 'the current repo'

const FINDINGS = { type: 'object', additionalProperties: false, required: ['kind', 'summary', 'items'], properties: {
  kind: { type: 'string' }, summary: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } }

phase('Scan')
const [lint, drift, salience] = await parallel([
  () => agent(
    `REPORT-ONLY lint of ${repoLabel}. Edit NOTHING. Run \`${TU}${repoArg} --policy --report\`, \`${TU}${repoArg} --externalities --report\`, and \`${TU}${repoArg}\` (note unresolved-anchor errors / empty-graph NOTICE). Report: policy violation count, externalities (high) count, unresolved anchors, AND — critically — the advisory rules that are DECLARED but not auto-enforced (so coverage gaps are explicit, never implying the lint is complete). kind="lint".`,
    { label: 'audit:lint', phase: 'Scan', schema: FINDINGS }),
  () => agent(
    `REPORT-ONLY latent-drift scan of ${repoLabel}. Edit NOTHING. Run \`${TU}${repoArg} --impact --since ${sinceN}\` and report dependents made stale by recent commits that may not have been trued up. Include the subtle case where a changed fact's key is NOT a node in the active graph — report that as a graph COVERAGE gap, not a clean bill. kind="drift".`,
    { label: 'audit:drift', phase: 'Scan', schema: FINDINGS }),
  () => agent(
    `REPORT-ONLY salience / MISSING-edge discovery for ${repoLabel}. Edit NOTHING and add NO edges. From \`git${gitC} log --name-only -100\`, find file PAIRS that frequently co-change but have NO declared edge in the current graph (read ${args && args.repo ? args.repo + '/' : ''}.true-up/depgraph.json) → candidate MISSING edges a maintainer could ratify into .true-up.json seed. Rank by co-change count; separately FLAG likely co-edit-sweep noise (bulk commits) so a human is not misled. PROPOSE only. kind="missing-edges".`,
    { label: 'audit:salience', phase: 'Scan', schema: FINDINGS }),
])

phase('Report')
const report = await agent(
  `Synthesize a true-up AUDIT report for ${repoLabel}. REPORT-ONLY — nothing was or will be edited; this hands a maintainer a worklist, it does not act.
LINT: ${JSON.stringify(lint)}
DRIFT: ${JSON.stringify(drift)}
MISSING-EDGES: ${JSON.stringify(salience)}
Produce a prioritized maintainer worklist: (1) lint findings + the explicit coverage gaps (unenforced advisory rules); (2) latent drift incl. coverage gaps; (3) the top candidate seed edges to RATIFY — making clear ratification is a separate, explicit human action (the audit proposes, the maintainer decides; correlation never assigns the arrow). State provenance: graph node/edge counts and the commit window analyzed.`,
  { phase: 'Report' })

return { lint, drift, salience, report }
