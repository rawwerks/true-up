#!/usr/bin/env node
// Regression harness for complete JSON transport above the historically reported 65,536-byte edge.
// Runs against either the source entrypoint or an installed/packed entrypoint.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [entryArg, workArg, reportArg] = process.argv.slice(2)
if (!entryArg || !workArg || !reportArg) {
  throw new Error('usage: node tests/large-json-transport.mjs <true-up-entry> <new-work-dir> <report.json>')
}
const entry = resolve(entryArg)
const resolvedEntry = realpathSync(entry)
const work = resolve(workArg)
const reportPath = resolve(reportArg)
const repo = join(work, 'fixture')
const dependentCount = 4096
const boundary = 65_536
const maxBuffer = 8 * 1024 * 1024
const outputs = join(work, 'captured-output')

if (!existsSync(entry)) throw new Error(`entrypoint does not exist: ${entry}`)
if (existsSync(work)) throw new Error(`refusing to replace existing work directory: ${work}`)
mkdirSync(join(repo, 'docs'), { recursive: true })
mkdirSync(outputs, { recursive: true })

// Runtime backpressure makes the old async-writer symptom probabilistic (an unsafe build occasionally
// flushes in time). Pin the production boundary statically as well: a mutant that restores either
// structured process.stdout.write or unadapted console.log must fail on every run.
const engineSource = readFileSync(resolve(dirname(resolvedEntry), '../lib/engine.mjs'), 'utf8')
if (!/const writeStdout = \(text\) => writeFileSync\(1, text\)/.test(engineSource)) {
  throw new Error('entrypoint engine is missing the synchronous writeStdout(fd 1) boundary')
}
if (!/console\.log = \(\.\.\.values\) => writeStdout\(format\(\.\.\.values\) \+ '\\n'\)/.test(engineSource)) {
  throw new Error('entrypoint engine does not route human console.log output through writeStdout')
}
if (/process\.stdout\.write\(/.test(engineSource)) {
  throw new Error('entrypoint engine restored an asynchronous direct structured stdout writer')
}

const seed = []
writeFileSync(join(repo, 'source.md'), '# source\nversion one\n')
for (let i = 0; i < dependentCount; i++) {
  const from = `docs/dependent-${String(i).padStart(4, '0')}.md`
  writeFileSync(join(repo, from), `# dependent ${i}\nDerived from source.\n`)
  seed.push({ from, to: 'source.md', kind: 'derives-facts-from' })
}
writeFileSync(join(repo, '.true-up.json'), JSON.stringify({
  zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'large-stdout-transport-regression-λ', rules: [] }],
  seed,
}, null, 2) + '\n')
writeFileSync(join(repo, '.gitignore'), '.true-up/\n')

const run = (args, options = {}) => spawnSync(process.execPath, [entry, ...args], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer,
  env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  },
  ...options,
})
const git = (...args) => spawnSync('git', ['-C', repo, ...args], {
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  },
})
const assertRun = (result, label, expectedExit = 0) => {
  if (result.error || result.status !== expectedExit) {
    throw new Error(`${label}: exit=${result.status} error=${result.error || ''}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const parseOneCompleteObject = (stdout, label, requireLarge = false) => {
  const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
  const bytes = raw.length
  if (requireLarge && bytes <= boundary) throw new Error(`${label}: expected >${boundary} bytes, got ${bytes}`)
  if (raw.at(-1) !== 0x0a) throw new Error(`${label}: stdout is missing its terminal newline`)
  let value
  try { value = JSON.parse(raw.toString('utf8')) } catch (error) { throw new Error(`${label}: incomplete/invalid JSON: ${error}`) }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label}: stdout is not one JSON object`)
  if (value.ok !== true || value._v !== 1) throw new Error(`${label}: bad JSON contract envelope`)
  return { value, bytes, sha256: sha256(stdout), endsWithNewline: true }
}
const checkCompleteHuman = (stdout, label, expectedPatterns) => {
  const bytes = Buffer.byteLength(stdout)
  if (bytes <= boundary) throw new Error(`${label}: expected >${boundary} bytes, got ${bytes}`)
  if (!stdout.endsWith('\n')) throw new Error(`${label}: stdout is missing its terminal newline`)
  for (const { pattern, count } of expectedPatterns) {
    const actual = [...stdout.matchAll(pattern)].length
    if (actual !== count) throw new Error(`${label}: expected ${count} matches for ${pattern}, got ${actual}`)
  }
  return { bytes, sha256: sha256(stdout), endsWithNewline: true }
}

assertRun(git('init', '-q'), 'git init')
assertRun(git('add', '-A'), 'git add')
assertRun(git('-c', 'user.name=true-up transport test', '-c', 'user.email=transport@true-up.invalid', 'commit', '-qm', 'fixture'), 'git commit')
writeFileSync(join(repo, 'source.md'), '# source\nversion two\n')

const build = run(['--repo', repo])
writeFileSync(join(outputs, 'build.stdout'), build.stdout || '')
writeFileSync(join(outputs, 'build.stderr'), build.stderr || '')
assertRun(build, 'build')

const graphRun = run(['--repo', repo, 'graph', '--json'])
writeFileSync(join(outputs, 'graph.stdout.json'), graphRun.stdout || '')
writeFileSync(join(outputs, 'graph.stderr'), graphRun.stderr || '')
assertRun(graphRun, 'graph --json')
const graph = parseOneCompleteObject(graphRun.stdout, 'graph --json', true)
if (Object.keys(graph.value.graph?.nodes || {}).length < dependentCount) throw new Error('graph --json: missing fixture nodes')
if ((graph.value.graph?.edges || []).length !== dependentCount) throw new Error('graph --json: missing fixture edges')

const humanGraphRun = run(['--repo', repo, 'graph'])
writeFileSync(join(outputs, 'graph-human.stdout'), humanGraphRun.stdout || '')
writeFileSync(join(outputs, 'graph-human.stderr'), humanGraphRun.stderr || '')
assertRun(humanGraphRun, 'graph (human)')
const humanGraph = checkCompleteHuman(humanGraphRun.stdout, 'graph (human)', [
  { pattern: /^    docs\/dependent-\d{4}\.md  \[/gm, count: dependentCount },
  { pattern: /^    file:docs\/dependent-\d{4}\.md -> file:source\.md  \[/gm, count: dependentCount },
])

const proofRun = run(['--repo', repo, '--impact', '--since', 'HEAD', '--proof', '--json'])
writeFileSync(join(outputs, 'impact-proof.stdout.json'), proofRun.stdout || '')
writeFileSync(join(outputs, 'impact-proof.stderr'), proofRun.stderr || '')
assertRun(proofRun, 'impact --proof --json')
const proof = parseOneCompleteObject(proofRun.stdout, 'impact --proof --json', true)
if ((proof.value.counts?.advisory || 0) !== dependentCount) throw new Error('impact --proof --json: incomplete advisory worklist')

const humanProofRun = run(['--repo', repo, '--impact', '--since', 'HEAD', '--proof'])
writeFileSync(join(outputs, 'impact-proof-human.stdout'), humanProofRun.stdout || '')
writeFileSync(join(outputs, 'impact-proof-human.stderr'), humanProofRun.stderr || '')
assertRun(humanProofRun, 'impact --proof (human)')
const humanProof = checkCompleteHuman(humanProofRun.stdout, 'impact --proof (human)', [
  { pattern: /^    file:docs\/dependent-\d{4}\.md   \[derives-facts-from <- file:source\.md\]$/gm, count: dependentCount },
  { pattern: /^      file:docs\/dependent-\d{4}\.md   \[not-changed-in-range\]$/gm, count: dependentCount },
])

const statusRun = run(['--repo', repo, 'status', '--since', 'HEAD', '--json'])
writeFileSync(join(outputs, 'status.stdout.json'), statusRun.stdout || '')
writeFileSync(join(outputs, 'status.stderr'), statusRun.stderr || '')
assertRun(statusRun, 'status --json')
const status = parseOneCompleteObject(statusRun.stdout, 'status --json')
if ((status.value.impact?.advisory || []).length !== dependentCount) throw new Error('status --json: incomplete internal worklist')

const humanStatusRun = run(['--repo', repo, 'status', '--since', 'HEAD'])
writeFileSync(join(outputs, 'status-human.stdout'), humanStatusRun.stdout || '')
writeFileSync(join(outputs, 'status-human.stderr'), humanStatusRun.stderr || '')
assertRun(humanStatusRun, 'status (human)')
const humanStatus = checkCompleteHuman(humanStatusRun.stdout, 'status (human)', [
  { pattern: /^              advisory: docs\/dependent-\d{4}\.md  ←  file:source\.md$/gm, count: dependentCount },
])

const humanRun = run(['--repo', repo, 'run', '--since', 'HEAD', '--no-write'])
writeFileSync(join(outputs, 'run-no-write-human.stdout'), humanRun.stdout || '')
writeFileSync(join(outputs, 'run-no-write-human.stderr'), humanRun.stderr || '')
assertRun(humanRun, 'run --no-write (human)', 0)
const humanDryRun = checkCompleteHuman(humanRun.stdout, 'run --no-write (human)', [
  { pattern: /^    docs\/dependent-\d{4}\.md  ←  file:source\.md$/gm, count: dependentCount },
])

const gateRun = run(['--repo', repo, 'gate', '--json'])
writeFileSync(join(outputs, 'gate.stdout.json'), gateRun.stdout || '')
writeFileSync(join(outputs, 'gate.stderr'), gateRun.stderr || '')
assertRun(gateRun, 'gate --json')
const gate = parseOneCompleteObject(gateRun.stdout, 'gate --json')
if (!Object.values(gate.value.checks || {}).every(Boolean)) throw new Error('gate --json: an internal child gate failed')

// A consumer such as `head` is allowed to close a pipe before true-up finishes writing. The CLI must
// fail nonzero with EPIPE; reporting exit 0 after a partial payload would recreate the exact false-
// success class this harness exists to prevent.
const epipeRun = spawnSync('bash', [
  '-o', 'pipefail', '-c', '"$@" | head -c 1 >/dev/null', 'true-up-epipe',
  process.execPath, entry, '--repo', repo, 'graph',
], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer,
  env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  },
})
if (epipeRun.error || epipeRun.status === 0 || !/EPIPE/.test(epipeRun.stderr || '')) {
  throw new Error(`early pipe close did not fail loud with EPIPE: exit=${epipeRun.status} error=${epipeRun.error || ''} stderr=${epipeRun.stderr || ''}`)
}

let truncationRejected = false
const exactBoundaryPrefix = Buffer.from(graphRun.stdout).subarray(0, boundary)
if (exactBoundaryPrefix.length !== boundary) throw new Error(`could not construct exact ${boundary}-byte truncation mutant`)
try {
  parseOneCompleteObject(exactBoundaryPrefix, 'injected 65,536-byte truncation')
} catch {
  truncationRejected = true
}
if (!truncationRejected) throw new Error('transport oracle accepted an exact 65,536-byte truncation mutant')

const report = {
  ok: true,
  entry,
  resolvedEntry,
  dependentCount,
  boundary,
  maxBuffer,
  graph: { bytes: graph.bytes, sha256: graph.sha256, nodes: Object.keys(graph.value.graph.nodes).length, edges: graph.value.graph.edges.length },
  humanGraph,
  impactProof: { bytes: proof.bytes, sha256: proof.sha256, advisory: proof.value.counts.advisory },
  humanImpactProof: humanProof,
  status: { bytes: status.bytes, sha256: status.sha256, advisory: status.value.impact.advisory.length },
  humanStatus,
  humanDryRun,
  gate: { bytes: gate.bytes, sha256: gate.sha256, checks: gate.value.checks },
  earlyPipeClose: { exit: epipeRun.status, stderrSha256: sha256(epipeRun.stderr || ''), epipe: true },
  injectedTruncation: { bytes: boundary, rejected: truncationRejected },
}
mkdirSync(resolve(reportPath, '..'), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report) + '\n')
