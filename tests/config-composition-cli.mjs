#!/usr/bin/env node
// Wave 2 TDD — prove that every config-consuming CLI surface uses the same composed config.
// This stays standalone so the engine integration can be developed against a focused red/green gate.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfigBundle, semanticProjection } from '../lib/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '../bin/true-up')
const scratchBase = process.env.TRUE_UP_CONFIG_CLI_TEST_SCRATCH
  || join(homedir(), 'scratch', 'true-up-config-composition', 'wave2-cli-tests')
mkdirSync(scratchBase, { recursive: true })
const runRoot = mkdtempSync(join(scratchBase, 'run-'))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const frozenFixtureDir = join(HERE, 'fixtures', 'pre-composition')
const frozenRuntimes = [
  {
    name: 'v0.1.4',
    revision: '4eb0e4ddf4eda309857a97a317424c2aea664250',
    fixture: 'v0.1.4.tar.gz.b64',
    archiveSha256: 'b32785fafd386b0642b998a3fc260ca4b232b6152fcc8e4bd099a5a91de05f60',
    files: {
      'bin/true-up': '6c17a172af3bde3085e36e4b7cc3fbad6cabedc7f94934c2e3826b7a162d7958',
      'lib/engine.mjs': 'f43eecd2f3677f6d70bf10a8c5451ddd2ebb9206e51328b0c25fbe77f3938b75',
      'lib/symbols.mjs': 'e7a0ab14351c1d512b9283a429131f436e95f34ad23f73d33695b76f57ec3f90',
      'package.json': '23fda882ffa058c328ce9b470d0d210c6a86e55e1a9f4e56c7c9691987400c43',
    },
  },
  {
    name: 'pre-composition-v0.2.1',
    revision: '7844b4f77f4cd74f7026edf8f7bf6811c6a11e65',
    fixture: 'pre-v0.2.1.tar.gz.b64',
    archiveSha256: 'd1f0f666f1c0934e1be849e0c5c24780c1035ea8d9004958d033989671882353',
    files: {
      'bin/true-up': '6c17a172af3bde3085e36e4b7cc3fbad6cabedc7f94934c2e3826b7a162d7958',
      'lib/engine.mjs': 'c39fae47e8a33c39cf6bebc4d8477034614a3e10a7d56a5625cc56371f92954e',
      'lib/symbols.mjs': 'e7a0ab14351c1d512b9283a429131f436e95f34ad23f73d33695b76f57ec3f90',
      'package.json': '3ab6afba7a336bdf917f173b6be2d5e813d8bbfc7d2504a8a6fc0644a91e9579',
    },
  },
]

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const put = (root, path, value) => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : `${JSON.stringify(value, null, 2)}\n`)
}
const git = (root, args, options = {}) => {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    ...options,
  })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed in ${root}: ${result.stderr}`)
  return result.stdout
}
const initRepo = (name) => {
  const root = join(runRoot, name)
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q'])
  git(root, ['config', 'user.name', 'true-up tests'])
  git(root, ['config', 'user.email', 'tests@true-up.invalid'])
  return root
}
const commitAll = (root, message = 'fixture') => {
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', message])
}
const runEntry = (entry, root, args, options = {}) => {
  const env = { ...process.env, ...options.env }
  if (options.unsetTrueUpRepo) delete env.TRUE_UP_REPO
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: options.cwd || root,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.notEqual(result.error?.code, 'ETIMEDOUT', `CLI timed out: ${args.join(' ')}`)
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}
const run = (root, args, options = {}) => runEntry(CLI, root, args, options)
const json = (result, label) => {
  let value
  try { value = JSON.parse(result.stdout) } catch (error) {
    assert.fail(`${label}: stdout was not one JSON object (${error.message})\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
  assert.equal(value._v, 1, `${label}: missing contract version`)
  assert.equal(typeof value.ok, 'boolean', `${label}: missing boolean ok`)
  return value
}
const expect = (result, status, label) => {
  assert.equal(result.status, status, `${label}: exit ${result.status}, expected ${status}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  return json(result, label)
}
const decodeFrozenRuntime = (candidate, fixturePath = join(frozenFixtureDir, candidate.fixture)) => {
  assert(existsSync(fixturePath), `${candidate.name}: frozen fixture is missing: ${fixturePath}`)
  const encoded = readFileSync(fixturePath, 'utf8').replace(/\s/g, '')
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, `${candidate.name}: frozen fixture is not canonical base64`)
  const archive = Buffer.from(encoded, 'base64')
  assert.equal(
    sha256(archive),
    candidate.archiveSha256,
    `${candidate.name}: frozen fixture archive SHA-256 mismatch`,
  )
  return archive
}
const verifyFrozenRuntime = (candidate, extracted) => {
  for (const [path, expected] of Object.entries(candidate.files)) {
    const target = join(extracted, path)
    assert(existsSync(target), `${candidate.name}: frozen runtime file is missing: ${path}`)
    assert.equal(
      sha256(readFileSync(target)),
      expected,
      `${candidate.name}: frozen runtime ${path} SHA-256 mismatch`,
    )
  }
}
const materializeFrozenRuntime = (
  candidate,
  extracted,
  fixturePath = join(frozenFixtureDir, candidate.fixture),
) => {
  mkdirSync(extracted, { recursive: true })
  const unpacked = spawnSync('tar', ['-xzf', '-', '-C', extracted], {
    input: decodeFrozenRuntime(candidate, fixturePath),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(unpacked.status, 0, `${candidate.name}: could not unpack frozen fixture: ${unpacked.stderr}`)
  verifyFrozenRuntime(candidate, extracted)
}
const deepSorted = (value) => {
  if (Array.isArray(value)) return value.map(deepSorted)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, deepSorted(value[key])]))
}
const snapshot = (root) => {
  const result = {}
  const walk = (relative = '') => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (!relative && entry.name === '.git') continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      const stat = lstatSync(join(root, path))
      if (entry.isDirectory()) {
        result[path] = { kind: 'directory', ino: stat.ino, mtimeMs: stat.mtimeMs }
        walk(path)
      } else {
        const bytes = readFileSync(join(root, path))
        result[path] = { kind: 'file', hash: sha256(bytes), bytes: bytes.length, ino: stat.ino, mtimeMs: stat.mtimeMs }
      }
    }
  }
  walk()
  return result
}

const declarations = {
  facts: { 'data.json': [['items', 'id']] },
  zones: [
    { path: 'docs/', visibility: 'public', audience: 'agents', intent: 'child-docs', rules: [] },
    { path: '', visibility: 'public', audience: 'world', intent: 'public-default', rules: [] },
  ],
  seed: [
    { from: 'docs/child.md', to: 'data.json#items.child', kind: 'derives-facts-from' },
  ],
  exports: [
    { id: 'child.fact', from: 'data.json#items.child', audience: 'public' },
  ],
}
const scalars = { out: '.true-up/depgraph.json', repoId: 'composition-cli-fixture' }
const flatConfig = { ...scalars, ...declarations }
const composedManifest = {
  compositionVersion: 1,
  include: ['config/child.json'],
  zones: null,
  ...scalars,
}

function makeRepo(name, mode) {
  const root = initRepo(name)
  put(root, 'data.json', { items: [{ id: 'child', value: 'v1' }] })
  put(root, 'docs/child.md', '# Child\n')
  put(root, 'nested/deeper/.keep', 'nested target-selection sentinel\n')
  if (mode === 'flat') put(root, '.true-up.json', flatConfig)
  else {
    put(root, '.true-up.json', composedManifest)
    put(root, 'config/child.json', declarations)
  }
  commitAll(root)
  return root
}

const edgeIsChildSentinel = (edge) => edge.from === 'file:docs/child.md'
  && edge.to === 'fact:data.json#items.child'
  && edge.kind === 'derives-facts-from'

function assertChildGraph(envelope, mode, label) {
  const graph = envelope.graph
  assert(graph?.nodes && Array.isArray(graph.edges), `${label}: graph payload missing`)
  const edge = graph.edges.find(edgeIsChildSentinel)
  assert(edge, `${label}: child-only edge missing`)
  assert(graph.nodes['fact:data.json#items.child'], `${label}: child-only fact missing`)
  assert(graph.nodes['file:docs/child.md'], `${label}: child-only dependent missing`)
  if (mode === 'composed') {
    assert.equal(edge.declaredIn?.source, 'config/child.json', `${label}: composed edge lacks repo-relative source provenance`)
    assert.equal(edge.declaredIn?.pointer, '/seed/0', `${label}: composed edge lacks JSON-pointer provenance`)
  } else {
    assert.equal(edge.declaredIn, undefined, `${label}: legacy edge gained composed provenance`)
  }
}

function graphProjection(envelope, mode) {
  const copy = structuredClone(envelope)
  delete copy.nodes
  delete copy.configSources
  delete copy.composition
  const graph = copy.graph
  delete graph.configSources
  delete graph.composition
  const rootNode = graph.nodes['file:.true-up.json']
  if (rootNode) delete rootNode.hash
  if (mode === 'composed') delete graph.nodes['file:config/child.json']
  for (const edge of graph.edges) delete edge.declaredIn
  return deepSorted(copy)
}

function commandProjection(command, envelope) {
  const copy = structuredClone(envelope)
  delete copy.configSources
  delete copy.composition
  if (command === 'status') {
    delete copy.workspace
    delete copy.nextCommands
    if (copy.graph) delete copy.graph.nodes
  }
  if (command === 'policy') delete copy.zoneCoverage
  return deepSorted(copy)
}

test('flat and composed configs have identical frozen semanticProjection bytes', () => {
  const flat = makeRepo('semantic-flat', 'flat')
  const composed = makeRepo('semantic-composed', 'composed')
  const flatProjection = semanticProjection(JSON.parse(readFileSync(join(flat, '.true-up.json'), 'utf8')))
  const expected = `${JSON.stringify(flatProjection)}\n`
  const bundle = loadConfigBundle({ repoRoot: composed })
  assert.equal(bundle.mode, 'composed')
  assert.deepEqual(bundle.normalizedConfigBytes, expected)
  assert.deepEqual(bundle.sources.map((source) => source.path), ['.true-up.json', 'config/child.json'])
})

test('build/graph/status/check/impact/policy/externalities/gate/export consume child-only declarations with flat parity', () => {
  const flat = makeRepo('matrix-flat', 'flat')
  const composed = makeRepo('matrix-composed', 'composed')

  const flatBuild = expect(run(flat, ['--repo', flat, 'build', '--json']), 0, 'flat build')
  const composedBuild = expect(run(composed, ['--repo', composed, 'build', '--json']), 0, 'composed build')
  for (const [label, value] of [['flat build', flatBuild], ['composed build', composedBuild]]) {
    assert.equal(value.edges, 1, `${label}: child edge not counted`)
    assert.equal(value.factNodes, 1, `${label}: child fact not counted`)
    assert.equal(value.tracking, true, `${label}: child edge did not activate tracking`)
  }
  for (const key of ['ok', '_v', 'wrote', 'edges', 'factNodes', 'declaredEdges', 'inert', 'tracking']) {
    assert.deepEqual(composedBuild[key], flatBuild[key], `build parity: ${key}`)
  }

  const flatGraph = expect(run(flat, ['--repo', flat, 'graph', '--json']), 0, 'flat graph')
  const composedGraph = expect(run(composed, ['--repo', composed, 'graph', '--json']), 0, 'composed graph')
  assertChildGraph(flatGraph, 'flat', 'flat graph')
  assertChildGraph(composedGraph, 'composed', 'composed graph')
  assert.deepEqual(graphProjection(composedGraph, 'composed'), graphProjection(flatGraph, 'flat'), 'graph semantic parity')

  const cleanCases = [
    ['status', ['status', '--json'], 0],
    ['check', ['--check', '--json'], 0],
    ['impact', ['--impact', 'data.json#items.child', '--json'], 0],
    ['policy', ['--policy', '--json'], 0],
    ['externalities', ['--externalities', '--json'], 0],
    ['verify-scope', ['--verify-scope', '--since', 'HEAD', '--json'], 0],
    ['gate', ['gate', '--json'], 0],
    ['export', ['export', '--audience', 'public', '--json'], 0],
  ]
  for (const [name, args, status] of cleanCases) {
    const left = expect(run(flat, ['--repo', flat, ...args]), status, `flat ${name}`)
    const right = expect(run(composed, ['--repo', composed, ...args]), status, `composed ${name}`)
    if (name === 'status') {
      assert.equal(right.graph.edges, 1, 'status bypassed child edge')
      assert.equal(right.graph.tracking, true, 'status reports child-only config as inert')
    }
    if (name === 'impact') {
      assert.equal(right.counts.advisory, 1, 'impact bypassed child edge')
      assert(right.advisory.some((hit) => hit.node === 'file:docs/child.md'), 'impact omitted child dependent')
    }
    if (name === 'policy') assert.equal(right.zoneCoverage['child-docs'], 1, 'policy bypassed child zone')
    if (name === 'verify-scope') assert.equal(right.vacuous, undefined, 'verify-scope bypassed child edge and passed vacuously')
    if (name === 'gate') assert.deepEqual(right.checks, { check: true, policy: true, externalities: true })
    if (name === 'export') assert(right.facts['child.fact'], 'export bypassed child allowlist')
    assert.deepEqual(commandProjection(name, right), commandProjection(name, left), `${name}: flat/composed JSON parity`)
  }
})

test('impact proof, status, verify-scope, and strict no-write run observe a changed child-only fact', () => {
  const flat = makeRepo('changed-flat', 'flat')
  const composed = makeRepo('changed-composed', 'composed')
  expect(run(flat, ['build', '--json']), 0, 'changed flat build')
  expect(run(composed, ['build', '--json']), 0, 'changed composed build')
  put(flat, 'data.json', { items: [{ id: 'child', value: 'v2' }] })
  put(composed, 'data.json', { items: [{ id: 'child', value: 'v2' }] })

  const cases = [
    ['impact-proof', ['--impact', '--since', 'HEAD', '--proof', '--no-write', '--json'], 0],
    ['status', ['status', '--since', 'HEAD', '--json'], 0],
    ['verify-scope', ['--verify-scope', '--since', 'HEAD', '--json'], 0],
    ['run-no-write-strict', ['run', '--since', 'HEAD', '--strict', '--no-write', '--json'], 0],
  ]
  for (const [name, args, status] of cases) {
    const left = expect(run(flat, args), status, `changed flat ${name}`)
    const right = expect(run(composed, args), status, `changed composed ${name}`)
    if (name === 'impact-proof') {
      assert.equal(right.counts.advisory, 1, 'proof bypassed child edge')
      assert.equal(right.proof.summary.dependents, 1, 'proof omitted child-only dependent')
    }
    if (name === 'status') assert.equal(right.impact.advisory.length, 1, 'status omitted changed child-only fact')
    if (name === 'verify-scope') assert.equal(right.violations.length, 0, 'child source edit was not explained')
    if (name === 'run-no-write-strict') {
      assert.equal(right.dryRun, true)
      assert.equal(right.advisory, 1, 'run bypassed child-only worklist')
      assert.deepEqual(right.advisoryWorklist.map((item) => item.doc), ['docs/child.md'])
    }
    assert.deepEqual(commandProjection(name === 'impact-proof' ? 'impact' : name, right), commandProjection(name === 'impact-proof' ? 'impact' : name, left), `${name}: changed flat/composed parity`)
  }
})

test('--repo, TRUE_UP_REPO, and nested cwd select the composed root before loading fragments', () => {
  const root = makeRepo('target-selection', 'composed')
  const cases = [
    ['--repo', ['--repo', root, 'graph', '--json'], { cwd: runRoot, unsetTrueUpRepo: true }],
    ['$TRUE_UP_REPO', ['graph', '--json'], { cwd: runRoot, env: { TRUE_UP_REPO: root } }],
    ['nested cwd', ['graph', '--json'], { cwd: join(root, 'nested/deeper'), unsetTrueUpRepo: true }],
  ]
  for (const [label, args, options] of cases) {
    const envelope = expect(run(root, args, options), 0, `target ${label}`)
    assertChildGraph(envelope, 'composed', `target ${label}`)
  }
})

test('large include sets use bounded batch VCS classification, never one subprocess per fragment', () => {
  const root = initRepo('bounded-vcs-classification')
  const include = []
  for (let index = 0; index < 200; index++) {
    const path = `config/f${String(index).padStart(3, '0')}.json`
    include.push(path)
    put(root, path, { _fragment: index })
  }
  put(root, '.true-up.json', { compositionVersion: 1, include, zones: null, out: '.true-up/depgraph.json' })
  put(root, 'README.md', '# bounded VCS fixture\n')
  commitAll(root)

  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  assert(realGit, 'could not resolve the real git executable')
  const wrapperDir = join(runRoot, 'git-wrapper')
  const log = join(runRoot, 'git-wrapper.log')
  put(wrapperDir, 'git', `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TRUE_UP_GIT_LOG"\nif [ "\${TRUE_UP_FAIL_IGNORE:-0}" = 1 ]; then\n  case " $* " in *" check-ignore "*) exit 42 ;; esac\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`)
  chmodSync(join(wrapperDir, 'git'), 0o755)
  put(runRoot, 'git-wrapper.log', '')

  expect(run(root, ['build', '--no-write', '--json'], {
    env: { PATH: `${wrapperDir}:${process.env.PATH}`, TRUE_UP_GIT_LOG: log },
  }), 0, 'bounded VCS build')
  const commands = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  const ignoreQueries = commands.filter((line) => line.includes('check-ignore'))
  const fragmentArgQueries = commands.filter((line) => /config\/f\d{3}\.json/.test(line))
  assert.equal(ignoreQueries.length, 1, `expected one batch check-ignore query, got ${ignoreQueries.length}`)
  assert.deepEqual(fragmentArgQueries, [], 'a fragment path reached a per-source Git subprocess')

  const failed = expect(run(root, ['build', '--no-write', '--json'], {
    env: { PATH: `${wrapperDir}:${process.env.PATH}`, TRUE_UP_GIT_LOG: log, TRUE_UP_FAIL_IGNORE: '1' },
  }), 2, 'batch VCS failure')
  assert.equal(failed.kind, 'vcs-read-failed', 'batch ignore failure lost the VCS fail-loud contract')
})

test('deterministic Telltail-shaped composition carries exactly 529 seeds and 43 zones', () => {
  const root = initRepo('telltail-shaped-scale')
  const fragmentCount = 8
  const seedCount = 529
  const zoneCount = 43
  const include = Array.from({ length: fragmentCount }, (_, index) => `config/domain-${String(index).padStart(2, '0')}.json`)
  const fragments = Array.from({ length: fragmentCount }, () => ({ zones: [], seed: [] }))
  fragments[0].facts = { 'data.json': [['items', 'id']] }

  for (let index = 0; index < zoneCount; index++) {
    const zone = String(index).padStart(2, '0')
    fragments[index % fragmentCount].zones.push({
      path: `docs/zone-${zone}/`,
      visibility: 'public',
      audience: 'agents',
      intent: `scale-zone-${zone}`,
      rules: [],
    })
  }
  const items = []
  for (let index = 0; index < seedCount; index++) {
    const id = `k${String(index).padStart(3, '0')}`
    const zone = String(index % zoneCount).padStart(2, '0')
    const doc = `docs/zone-${zone}/d${String(index).padStart(3, '0')}.md`
    items.push({ id, value: index })
    put(root, doc, `# ${id}\n`)
    fragments[index % fragmentCount].seed.push({
      from: doc,
      to: `data.json#items.${id}`,
      kind: 'derives-facts-from',
    })
  }
  put(root, '.true-up.json', {
    _comment: 'deterministic 529-edge/43-zone integration scale fixture',
    compositionVersion: 1,
    include,
    zones: null,
    out: '.true-up/depgraph.json',
  })
  include.forEach((path, index) => put(root, path, fragments[index]))
  put(root, 'data.json', { items })
  commitAll(root, 'Telltail-shaped scale fixture')

  const firstResult = run(root, ['build', '--no-write', '--json'])
  const first = expect(firstResult, 0, 'Telltail-shaped first build')
  const secondResult = run(root, ['build', '--no-write', '--json'])
  const second = expect(secondResult, 0, 'Telltail-shaped second build')
  assert.equal(firstResult.stdout, secondResult.stdout, 'scale fixture build is not byte-deterministic')
  assert.equal(first.edges, seedCount, 'scale fixture lost or invented declared edges')
  assert.equal(first.factNodes, seedCount, 'scale fixture lost or invented fact nodes')
  assert.equal(first.composition?.fragmentCount, fragmentCount)
  assert.equal(first.composition?.sourceCount, fragmentCount + 1)
  assert.equal(first.graph?.edges?.length, seedCount)
  assert.equal(
    new Set(first.graph.edges.map((edge) => edge.declaredIn?.source).filter(Boolean)).size,
    fragmentCount,
    'scale fixture provenance did not retain every domain owner',
  )
  assert.equal(
    new Set(Object.values(first.graph.nodes).map((node) => node.zone).filter((zone) => /^scale-zone-/.test(zone))).size,
    zoneCount,
    'scale fixture did not exercise all 43 composed zones',
  )
})

function makeInvalidRepo() {
  const root = initRepo('invalid-fragment')
  put(root, 'data.json', { items: [{ id: 'child', value: 'v1' }] })
  put(root, 'generated.md', 'generated-before\n')
  put(root, 'tools/gen.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('generator-ran', 'BAD\\n')\n")
  put(root, '.true-up.json', {
    out: '.true-up/depgraph.json',
    facts: { 'data.json': [['items', 'id']] },
    zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] }],
    seed: [{ from: 'generated.md', to: 'data.json#items.child', kind: 'generated-from', via: 'tools/gen.mjs' }],
  })
  commitAll(root, 'legacy baseline')
  expect(run(root, ['build', '--json']), 0, 'invalid fixture baseline build')
  put(root, '.true-up/keep.tmp', 'TEMP-SENTINEL\n')
  put(root, '.true-up.json', {
    compositionVersion: 1,
    include: ['config/broken.json'],
    zones: null,
    out: '.true-up/depgraph.json',
    seed: [{ from: 'generated.md', to: 'data.json#items.child', kind: 'generated-from', via: 'tools/gen.mjs' }],
  })
  put(root, 'config/broken.json', '{"seed":[')
  commitAll(root, 'malformed composition')
  put(root, 'data.json', { items: [{ id: 'child', value: 'changed-after-invalid-config' }] })
  return root
}

const assertCompositionFailure = (result, expectedStatus, label) => {
  const envelope = expect(result, expectedStatus, label)
  if (expectedStatus === 1) {
    assert.equal(envelope.kind, 'gate-failed', `${label}: gate must retain aggregate exit-1 contract`)
    assert.equal(envelope.checks?.check, false, `${label}: invalid child did not fail gate child`)
    return
  }
  assert.equal(envelope.kind, 'invalid-config', `${label}: wrong top-level failure class`)
  assert.equal(envelope.detail?.code, 'fragment-invalid-json', `${label}: missing stable composition detail code`)
  assert.equal(envelope.detail?.source, 'config/broken.json', `${label}: source must be repo-relative`)
  assert.deepEqual(envelope.detail?.includeChain, ['.true-up.json', 'config/broken.json'])
  const publicText = `${result.stdout}\n${result.stderr}`
  assert(!publicText.includes(runRoot), `${label}: diagnostic leaked scratch root`)
}

test('every invalid-fragment negative fails closed before graph/temp/generator mutation', () => {
  const root = makeInvalidRepo()
  const before = snapshot(root)
  const cases = [
    ['build', ['build', '--json'], 2],
    ['graph', ['graph', '--json'], 2],
    ['status', ['status', '--json'], 2],
    ['check', ['--check', '--json'], 2],
    ['impact', ['--impact', 'data.json', '--no-write', '--json'], 2],
    ['policy', ['--policy', '--json'], 2],
    ['externalities', ['--externalities', '--json'], 2],
    ['verify-scope', ['--verify-scope', '--since', 'HEAD', '--json'], 2],
    ['run strict', ['run', '--since', 'HEAD', '--strict', '--json'], 2],
    ['gate', ['gate', '--json'], 1],
    ['export', ['export', '--audience', 'public', '--json'], 2],
  ]
  for (const [label, args, status] of cases) {
    assertCompositionFailure(run(root, args), status, `invalid ${label}`)
    assert.deepEqual(snapshot(root), before, `invalid ${label}: write-set changed`)
    assert.equal(readdirSync(join(root, '.true-up')).sort().join('\n'), 'depgraph.json\nkeep.tmp', `invalid ${label}: temp residue appeared`)
  }
})

test('config-independent precedence surfaces do not traverse a malformed child or write', () => {
  const root = makeInvalidRepo()
  const before = snapshot(root)
  const cases = [
    ['help', ['--help'], 0, null, false],
    ['version', ['--version', '--json'], 0, null, true],
    ['capabilities', ['capabilities', '--json'], 0, null, true],
    ['robot-docs', ['robot-docs', '--json'], 0, null, true],
    ['hooks help', ['hooks', '--help', '--json'], 2, 'unknown-flag', true],
    ['unknown command', ['definitely-unknown', '--json'], 2, 'unknown-command', true],
    ['unknown flag', ['graph', '--definitely-unknown', '--json'], 2, 'unknown-flag', true],
  ]
  for (const [label, args, status, kind, structured] of cases) {
    const result = run(root, args)
    assert.equal(result.status, status, `precedence ${label}: exit ${result.status}, expected ${status}`)
    if (structured) {
      const envelope = json(result, `precedence ${label}`)
      if (kind) assert.equal(envelope.kind, kind, `precedence ${label}: malformed child stole precedence`)
      else assert.notEqual(envelope.kind, 'invalid-config', `precedence ${label}: traversed malformed child`)
    } else {
      assert.match(result.stdout, /^true-up —/, `precedence ${label}: help output missing`)
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /invalid true-up config/, `precedence ${label}: traversed malformed child`)
    }
    assert.deepEqual(snapshot(root), before, `precedence ${label}: write-set changed`)
  }
})

test('frozen pre-composition binaries reject the zones:null sentinel; immutable fixtures fail loud', () => {
  const root = makeRepo('version-skew-compatibility', 'composed')
  const before = snapshot(root)

  const guardCandidate = frozenRuntimes[0]
  assert.throws(
    () => decodeFrozenRuntime(guardCandidate, join(runRoot, 'missing-frozen-runtime.b64')),
    /frozen fixture is missing/,
    'missing frozen fixture did not fail loud',
  )
  const corruptedFixture = join(runRoot, 'corrupted-frozen-runtime.b64')
  const guardFixture = join(frozenFixtureDir, guardCandidate.fixture)
  decodeFrozenRuntime(guardCandidate, guardFixture)
  const encoded = readFileSync(guardFixture, 'utf8')
  writeFileSync(corruptedFixture, encoded.replace(/[A-Za-z0-9]/, (char) => char === 'A' ? 'B' : 'A'))
  assert.throws(
    () => decodeFrozenRuntime(guardCandidate, corruptedFixture),
    /archive SHA-256 mismatch/,
    'corrupted frozen archive did not fail its pinned hash',
  )
  const mutatedRuntime = join(runRoot, 'mutated-frozen-runtime')
  materializeFrozenRuntime(guardCandidate, mutatedRuntime)
  const mutatedEngine = join(mutatedRuntime, 'lib/engine.mjs')
  writeFileSync(mutatedEngine, Buffer.concat([readFileSync(mutatedEngine), Buffer.from('\n')]))
  assert.throws(
    () => verifyFrozenRuntime(guardCandidate, mutatedRuntime),
    /lib\/engine\.mjs SHA-256 mismatch/,
    'mutated frozen engine did not fail its pinned hash',
  )

  for (const candidate of frozenRuntimes) {
    const extracted = join(runRoot, `frozen-${candidate.name}`)
    materializeFrozenRuntime(candidate, extracted)

    const result = runEntry(join(extracted, 'bin/true-up'), root, ['--repo', root, 'build', '--json'])
    assert.equal(result.status, 2, `${candidate.name}: compatibility sentinel did not fail closed\nstdout=${result.stdout}\nstderr=${result.stderr}`)
    const envelope = JSON.parse(result.stdout)
    assert.equal(envelope.ok, false, `${candidate.name}: failure envelope claimed success`)
    assert.equal(envelope.error, 'invalid-config', `${candidate.name}: wrong failure class`)
    assert.equal(envelope.detail, 'zones', `${candidate.name}: zones:null was not the rejection sentinel`)
    assert.deepEqual(snapshot(root), before, `${candidate.name}: old binary wrote or mutated the target before rejecting composition`)
  }

  const current = expect(run(root, ['build', '--no-write', '--json']), 0, 'current composition compatibility fixture')
  assertChildGraph(current, 'composed', 'current composition compatibility fixture')
  assert.deepEqual(snapshot(root), before, 'current no-write compatibility proof mutated the target')
})

let passed = 0
for (const { name, fn } of tests) {
  try {
    fn()
    passed++
    process.stdout.write(`ok ${passed} - ${name}\n`)
  } catch (error) {
    process.stderr.write(`not ok ${passed + 1} - ${name}\n${error.stack || error}\n`)
    process.exitCode = 1
    break
  }
}
rmSync(runRoot, { recursive: true, force: true })
const cleaned = !existsSync(runRoot)
process.stdout.write(`config composition CLI: ${passed}/${tests.length} passed; fixtures cleaned=${cleaned}\n`)
