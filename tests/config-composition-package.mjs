#!/usr/bin/env node
// Wave 4 package-boundary conformance for deterministic config composition.
//
// This harness deliberately imports no true-up source module by a checkout-relative path. The
// caller must supply the exact entry being audited; the harness resolves that entry (including an
// npm node_modules/.bin symlink), derives its package root, verifies the engine/config import chain,
// and drives only those supplied package files. CI invocation:
//
//   node tests/config-composition-package.mjs \
//     --entry "$SANDBOX/node_modules/.bin/true-up" \
//     --scratch "$WORK/config-composition-package" \
//     --report "$WORK/config-composition-package.json"

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HARNESS_CHECKOUT = realpathSync(resolve(HERE, '..'))
const EXPECTED_CASES = 8
const USAGE = `config-composition-package — installed true-up package-boundary conformance

Usage:
  node tests/config-composition-package.mjs \\
    --entry <installed-bin-or-bin/true-up> \\
    --scratch <dedicated-scratch-directory> \\
    --report <report.json> [--allow-source-entry]

Required:
  --entry PATH     Exact true-up entry to execute. No PATH or source-checkout fallback exists.
  --scratch DIR    Parent for disposable Git fixtures. Each run removes its owned fixture tree.
  --report FILE    Deterministic JSON conformance report written after fixture cleanup.

Options:
  --allow-source-entry  Development-only: permit the supplied entry to be this checkout's bin/true-up.
  --help, -h            Show this help and write nothing.
`

class UsageError extends Error {}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const options = { allowSourceEntry: false }
  const valued = new Set(['--entry', '--scratch', '--report'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--allow-source-entry') {
      options.allowSourceEntry = true
      continue
    }
    if (!valued.has(arg)) throw new UsageError(`unknown argument: ${arg}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new UsageError(`missing value for ${arg}`)
    const key = arg === '--entry' ? 'entry' : arg === '--scratch' ? 'scratch' : 'report'
    if (options[key]) throw new UsageError(`duplicate argument: ${arg}`)
    options[key] = value
  }
  for (const [key, flag] of [['entry', '--entry'], ['scratch', '--scratch'], ['report', '--report']]) {
    if (!options[key]) throw new UsageError(`missing required ${flag}`)
  }
  return options
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`
const inside = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function put(root, path, value) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : jsonText(value))
}

const isolatedEnv = () => {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
  }
  delete env.TRUE_UP_REPO
  return env
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: isolatedEnv(),
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  assert.notEqual(result.error?.code, 'ETIMEDOUT', `git timed out: ${args.join(' ')}`)
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function initRepo(runRoot, name) {
  const root = join(runRoot, name)
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q'])
  git(root, ['config', 'user.name', 'true-up package conformance'])
  git(root, ['config', 'user.email', 'package-conformance@true-up.invalid'])
  return root
}

function commitAll(root, message = 'fixture') {
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', message])
}

function snapshot(root) {
  const state = {}
  const walk = (base = '') => {
    for (const entry of readdirSync(join(root, base), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!base && entry.name === '.git') continue
      const path = base ? `${base}/${entry.name}` : entry.name
      const absolute = join(root, path)
      const stat = lstatSync(absolute)
      if (entry.isDirectory()) {
        state[path] = { kind: 'directory', ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs }
        walk(path)
      } else if (entry.isSymbolicLink()) {
        state[path] = { kind: 'symlink', ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs, size: stat.size }
      } else {
        const bytes = readFileSync(absolute)
        state[path] = {
          kind: 'file',
          ino: stat.ino,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          sha256: sha256(bytes),
        }
      }
    }
  }
  walk()
  return state
}

function parseJson(result, label) {
  let value
  try { value = JSON.parse(result.stdout) } catch (error) {
    assert.fail(`${label}: stdout was not one JSON object (${error.message})\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
  assert.equal(value._v, 1, `${label}: missing contract version`)
  assert.equal(typeof value.ok, 'boolean', `${label}: missing boolean ok`)
  return value
}

function packageBoundary(entryInput, allowSourceEntry) {
  const entryPath = resolve(entryInput)
  assert(existsSync(entryPath), `supplied entry does not exist: ${entryPath}`)
  const entryInputStat = lstatSync(entryPath)
  const entryReal = realpathSync(entryPath)
  const packageRoot = realpathSync(resolve(dirname(entryReal), '..'))
  const enginePath = realpathSync(join(packageRoot, 'lib/engine.mjs'))
  const configPath = realpathSync(join(packageRoot, 'lib/config.mjs'))
  const packagePath = realpathSync(join(packageRoot, 'package.json'))
  for (const [label, path] of [['entry', entryReal], ['engine', enginePath], ['config', configPath], ['package', packagePath]]) {
    assert(inside(packageRoot, path), `${label} resolved outside the supplied package root`)
  }

  let packageJson
  try { packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) }
  catch (error) { assert.fail(`supplied package.json is not valid JSON: ${error.message}`) }
  assert.equal(packageJson.name, 'true-up', 'supplied entry package is not true-up')
  assert.equal(packageJson.type, 'module', 'supplied true-up package lost ESM mode')
  assert.equal(packageJson.bin?.['true-up'], 'bin/true-up', 'package bin mapping drifted')
  assert.equal(relative(packageRoot, entryReal), 'bin/true-up', 'supplied entry does not resolve to package bin/true-up')

  const entryBytes = readFileSync(entryReal)
  const engineBytes = readFileSync(enginePath)
  const configBytes = readFileSync(configPath)
  assert.match(entryBytes.toString('utf8'), /new URL\(['"]\.\.\/lib\/engine\.mjs['"],\s*import\.meta\.url\)/, 'entry no longer imports its adjacent package engine')
  assert.match(engineBytes.toString('utf8'), /from ['"]\.\/config\.mjs['"]/, 'engine no longer imports its adjacent package config module')

  const packageRootIsHarnessCheckout = packageRoot === HARNESS_CHECKOUT
  if (packageRootIsHarnessCheckout && !allowSourceEntry) {
    assert.fail('supplied entry resolved to the harness source checkout; pass an installed entry or use --allow-source-entry only for development proof')
  }

  return {
    entryPath,
    entryReal,
    packageRoot,
    enginePath,
    configPath,
    packageJson,
    report: {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      inputWasSymlink: entryInputStat.isSymbolicLink(),
      packageRootIsHarnessCheckout,
      entryResolvedInsidePackage: true,
      configResolvedInsidePackage: true,
      hashes: {
        entry: sha256(entryBytes),
        engine: sha256(engineBytes),
        config: sha256(configBytes),
        package: sha256(readFileSync(packagePath)),
      },
    },
  }
}

const declarations = {
  core: {
    facts: { 'data.json': [['items', 'id']] },
    zones: [
      { path: 'docs/', visibility: 'public', audience: 'agents', intent: 'child-docs', rules: [] },
      { path: '', visibility: 'public', audience: 'world', intent: 'child-default', rules: [] },
    ],
  },
  edges: {
    seed: [{ from: 'docs/child.md', to: 'data.json#items.child', kind: 'derives-facts-from' }],
  },
}

function manifest(include) {
  return {
    compositionVersion: 1,
    include,
    zones: null,
    out: '.true-up/depgraph.json',
  }
}

function writeComposedFixture(root, include = ['config/z-edges.json', 'config/a-core.json']) {
  put(root, '.true-up.json', manifest(include))
  put(root, 'config/a-core.json', declarations.core)
  put(root, 'config/z-edges.json', declarations.edges)
  put(root, 'data.json', { items: [{ id: 'child', value: 'v1' }] })
  put(root, 'docs/child.md', '# Child\n')
}

function sourceExpectation(root) {
  const paths = ['.true-up.json', 'config/a-core.json', 'config/z-edges.json']
  return paths.map((path) => ({
    path,
    role: path === '.true-up.json' ? 'entry' : 'fragment',
    bytes: readFileSync(join(root, path)).length,
    hash: sha256(readFileSync(join(root, path))).slice(0, 16),
  }))
}

function assertConfigSources(actual, expected, label, tracking = false) {
  assert.equal(actual?.length, expected.length, `${label}: config source count drifted`)
  for (let index = 0; index < expected.length; index++) {
    const wanted = expected[index]
    const got = actual[index]
    assert.equal(got.path, wanted.path, `${label}: source path ${index}`)
    assert.equal(got.role, wanted.role, `${label}: source role ${wanted.path}`)
    assert.equal(got.bytes, wanted.bytes, `${label}: source byte count ${wanted.path}`)
    assert.equal(got.hash, wanted.hash, `${label}: source hash ${wanted.path}`)
    if (tracking) assert.equal(got.state, 'tracked', `${label}: source tracking state ${wanted.path}`)
    else assert.equal(got.state, undefined, `${label}: read-side graph metadata leaked tracking state`)
  }
}

function graphProjection(envelope) {
  const copy = structuredClone(envelope)
  const stripEntryHash = (sources) => {
    const entry = sources?.find((source) => source.path === '.true-up.json')
    if (entry) delete entry.hash
  }
  stripEntryHash(copy.configSources)
  stripEntryHash(copy.graph?.configSources)
  if (copy.graph?.nodes?.['file:.true-up.json']) delete copy.graph.nodes['file:.true-up.json'].hash
  return copy
}

async function main(options) {
  const scratchBase = resolve(options.scratch)
  const reportPath = resolve(options.report)
  mkdirSync(scratchBase, { recursive: true })
  const runRoot = mkdtempSync(join(scratchBase, 'package-composition-'))
  const cases = []
  let boundary = null
  let configModule = null

  const runCli = (root, args) => {
    assert(boundary, 'package boundary was not established')
    const result = spawnSync(process.execPath, [boundary.entryReal, '--repo', root, ...args], {
      cwd: root,
      env: isolatedEnv(),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    assert.notEqual(result.error?.code, 'ETIMEDOUT', `CLI timed out: ${args.join(' ')}`)
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', signal: result.signal }
  }

  const expectCli = (root, args, status, label) => {
    const result = runCli(root, args)
    assert.equal(result.signal, null, `${label}: terminated by signal ${result.signal}`)
    assert.equal(result.status, status, `${label}: exit ${result.status}, expected ${status}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
    return { result, envelope: parseJson(result, label) }
  }

  const runCase = async (id, requirement, fn) => {
    try {
      const detail = await fn()
      cases.push({ id, requirement, status: 'pass', ...(detail ? { detail } : {}) })
      process.stdout.write(`ok ${cases.length} - ${id}\n`)
      return true
    } catch (error) {
      cases.push({ id, requirement, status: 'fail', error: String(error?.message || error) })
      process.stderr.write(`not ok ${cases.length} - ${id}\n${error?.stack || error}\n`)
      return false
    }
  }

  const assertInvalidPreserved = (id, setup, expected) => {
    const root = initRepo(runRoot, id)
    put(root, 'data.json', { items: [{ id: 'child', value: 'v1' }] })
    put(root, 'docs/child.md', '# Child\n')
    put(root, '.true-up/depgraph.json', 'PRIOR-GRAPH-SENTINEL\n')
    put(root, '.true-up/keep.tmp', 'PREEXISTING-TEMP-SENTINEL\n')
    setup(root)
    commitAll(root, id)
    const before = snapshot(root)
    const { result, envelope } = expectCli(root, ['build', '--json'], 2, id)
    assert.equal(envelope.ok, false, `${id}: failure envelope claimed success`)
    assert.equal(envelope.kind, 'invalid-config', `${id}: failure kind drifted`)
    assert.equal(typeof envelope.error, 'string', `${id}: failure lacks actionable error text`)
    assert(envelope.error.includes(expected.code), `${id}: error text omitted stable config code`)
    assert.equal(envelope.detail?.code, expected.code, `${id}: config error code drifted`)
    assert.equal(envelope.detail?.source, expected.source, `${id}: error source drifted`)
    assert.equal(envelope.detail?.pointer, expected.pointer, `${id}: error pointer drifted`)
    assert.deepEqual(envelope.detail?.includeChain, expected.includeChain, `${id}: include chain drifted`)
    if (expected.verify) expected.verify(envelope)
    assert(!`${result.stdout}\n${result.stderr}`.includes(root), `${id}: diagnostic leaked fixture absolute path`)
    assert.deepEqual(snapshot(root), before, `${id}: invalid build mutated target bytes or metadata`)
    assert.deepEqual(readdirSync(join(root, '.true-up')).sort(), ['depgraph.json', 'keep.tmp'], `${id}: temp residue appeared`)
    return { code: envelope.detail.code, source: envelope.detail.source }
  }

  try {
    const boundaryPassed = await runCase('PKG-001-entry-module-boundary', 'MUST', async () => {
      boundary = packageBoundary(options.entry, options.allowSourceEntry)
      configModule = await import(`${pathToFileURL(boundary.configPath).href}?package-conformance=${boundary.report.hashes.config}`)
      assert.equal(typeof configModule.loadConfigBundle, 'function', 'supplied package config module lacks loadConfigBundle')
      assert.equal(typeof configModule.createNodeConfigProvider, 'function', 'supplied package config module lacks createNodeConfigProvider')
      const capabilities = spawnSync(process.execPath, [boundary.entryReal, 'capabilities'], {
        encoding: 'utf8', env: isolatedEnv(), timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      })
      assert.equal(capabilities.status, 0, `supplied entry capabilities failed: ${capabilities.stderr}`)
      const payload = parseJson({ stdout: capabilities.stdout, stderr: capabilities.stderr }, 'package capabilities')
      assert.equal(payload.tool, 'true-up')
      assert.equal(payload.version, boundary.packageJson.version, 'entry/package version mismatch')
      return {
        inputWasSymlink: boundary.report.inputWasSymlink,
        sourceEntryAllowed: boundary.report.packageRootIsHarnessCheckout,
      }
    })

    if (boundaryPassed) {
      await runCase('PKG-002-child-only-lifecycle', 'MUST', () => {
        const root = initRepo(runRoot, 'positive-child-only')
        writeComposedFixture(root)
        commitAll(root, 'child-only composition')
        const expectedSources = sourceExpectation(root)

        const build = expectCli(root, ['build', '--json'], 0, 'child-only build').envelope
        assert.equal(build.ok, true)
        assert.equal(build.wrote, true)
        assert.equal(build.edges, 1)
        assert.equal(build.factNodes, 1)
        assert.equal(build.declaredEdges, 1)
        assert.equal(build.tracking, true)
        assert.equal(build.composition?.fragmentCount, 2)
        assert.equal(build.composition?.sourceCount, 3)
        assert.equal(build.composition?.entry, '.true-up.json')
        assertConfigSources(build.configSources, expectedSources, 'build configSources')
        const afterBuild = snapshot(root)

        const graph = expectCli(root, ['graph', '--json'], 0, 'child-only graph').envelope
        assert.equal(graph.wrote, false)
        assertConfigSources(graph.configSources, expectedSources, 'graph configSources')
        assertConfigSources(graph.graph?.configSources, expectedSources, 'embedded graph configSources')
        const edge = graph.graph?.edges?.find((item) => item.from === 'file:docs/child.md' && item.to === 'fact:data.json#items.child')
        assert(edge, 'child-only fragment edge missing')
        assert.equal(edge.kind, 'derives-facts-from')
        assert.deepEqual(edge.declaredIn, { source: 'config/z-edges.json', pointer: '/seed/0' })
        assert(graph.graph.nodes['fact:data.json#items.child'], 'child-only fact missing')
        assert.equal(graph.graph.nodes['file:docs/child.md']?.zone, 'child-docs', 'child-only zone missing')

        const status = expectCli(root, ['status', '--json'], 0, 'child-only status').envelope
        assert.equal(status.graph?.edges, 1)
        assert.equal(status.graph?.tracking, true)
        assert.equal(status.composition?.fragmentCount, 2)
        assertConfigSources(status.configSources, expectedSources, 'status configSources', true)
        assert.equal(status.configSourceWarnings, undefined, 'tracked package fixture emitted config source warnings')

        const check = expectCli(root, ['--check', '--json'], 0, 'child-only check').envelope
        assert.equal(check.upToDate, true)
        assert.equal(check.mode, 'worktree')
        const gate = expectCli(root, ['gate', '--json'], 0, 'child-only gate').envelope
        assert.deepEqual(gate.checks, { check: true, policy: true, externalities: true })
        assert.deepEqual(snapshot(root), afterBuild, 'graph/status/check/gate mutated state after build')
        assert.deepEqual(readdirSync(join(root, '.true-up')).sort(), ['depgraph.json'], 'positive lifecycle left temp residue')

        const persisted = JSON.parse(readFileSync(join(root, '.true-up/depgraph.json'), 'utf8'))
        assert.equal(persisted.composition?.fragmentCount, 2)
        assertConfigSources(persisted.configSources, expectedSources, 'persisted graph configSources')
        return { edges: build.edges, factNodes: build.factNodes, configSources: build.configSources.length }
      })

      await runCase('PKG-003-manual-include-order-equivalence', 'MUST', () => {
        const left = initRepo(runRoot, 'order-left')
        const right = initRepo(runRoot, 'order-right')
        writeComposedFixture(left, ['config/z-edges.json', 'config/a-core.json'])
        writeComposedFixture(right, ['config/a-core.json', 'config/z-edges.json'])
        commitAll(left, 'reverse manifest order')
        commitAll(right, 'canonical manifest order')

        const load = (root) => configModule.loadConfigBundle({
          repoRoot: root,
          provider: configModule.createNodeConfigProvider({ repoRoot: root, isIgnored: () => false }),
        })
        const leftBundle = load(left)
        const rightBundle = load(right)
        assert.deepEqual(leftBundle.composition.fragments, ['config/a-core.json', 'config/z-edges.json'])
        assert.deepEqual(leftBundle.composition.fragments, rightBundle.composition.fragments)
        assert.equal(leftBundle.normalizedConfigBytes, rightBundle.normalizedConfigBytes, 'include order changed normalized config meaning')
        assert.deepEqual(leftBundle.provenance, rightBundle.provenance, 'include order changed package-loader provenance')

        const leftGraph = expectCli(left, ['graph', '--json'], 0, 'reverse-order graph').envelope
        const rightGraph = expectCli(right, ['graph', '--json'], 0, 'canonical-order graph').envelope
        assert.deepEqual(graphProjection(leftGraph), graphProjection(rightGraph), 'include order changed CLI graph semantics')
        return { canonicalFragments: leftBundle.composition.fragments }
      })

      await runCase('PKG-004-cross-source-conflict-preserves-state', 'MUST', () => assertInvalidPreserved(
        'cross-source-conflict',
        (root) => {
          put(root, '.true-up.json', manifest(['config/z.json', 'config/a.json']))
          put(root, 'config/a.json', { facts: { 'data.json': [['items', 'id']] } })
          put(root, 'config/z.json', { facts: { 'data.json': [['other', 'id']] } })
        },
        {
          code: 'cross-source-conflict', source: '.true-up.json', pointer: undefined, includeChain: ['.true-up.json'],
          verify(envelope) {
            assert.deepEqual(envelope.detail.conflicts, [{
              identity: 'facts:data.json',
              origins: [
                { source: 'config/a.json', pointer: '/facts/data.json' },
                { source: 'config/z.json', pointer: '/facts/data.json' },
              ],
            }])
          },
        },
      ))

      await runCase('PKG-005-include-escape-preserves-state', 'MUST', () => assertInvalidPreserved(
        'include-escape',
        (root) => {
          put(join(root, '..'), 'outside.json', { seed: [{ from: 'docs/child.md', to: 'data.json' }] })
          put(root, '.true-up.json', manifest(['../outside.json']))
        },
        { code: 'include-path-escape', source: '.true-up.json', pointer: '/include/0', includeChain: ['.true-up.json'] },
      ))

      await runCase('PKG-006-nested-include-preserves-state', 'MUST', () => assertInvalidPreserved(
        'nested-include',
        (root) => {
          put(root, '.true-up.json', manifest(['config/a.json', 'config/z.json']))
          put(root, 'config/a.json', { include: ['config/z.json'] })
          put(root, 'config/z.json', declarations.edges)
        },
        { code: 'nested-include', source: 'config/a.json', pointer: '/include', includeChain: ['.true-up.json', 'config/a.json'] },
      ))

      await runCase('PKG-007-include-cycle-attempt-preserves-state', 'MUST', () => assertInvalidPreserved(
        'include-cycle-attempt',
        (root) => {
          put(root, '.true-up.json', manifest(['config/z.json', 'config/a.json']))
          put(root, 'config/a.json', { include: ['config/z.json'] })
          put(root, 'config/z.json', { include: ['config/a.json'] })
        },
        { code: 'nested-include', source: 'config/a.json', pointer: '/include', includeChain: ['.true-up.json', 'config/a.json'] },
      ))
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }

  const cleaned = !existsSync(runRoot)
  if (cleaned) {
    cases.push({ id: 'PKG-008-owned-fixture-cleanup', requirement: 'MUST', status: 'pass' })
    process.stdout.write(`ok ${cases.length} - PKG-008-owned-fixture-cleanup\n`)
  } else {
    cases.push({ id: 'PKG-008-owned-fixture-cleanup', requirement: 'MUST', status: 'fail', error: 'owned fixture tree survived cleanup' })
    process.stderr.write(`not ok ${cases.length} - PKG-008-owned-fixture-cleanup\n`)
  }

  const passed = cases.filter((item) => item.status === 'pass').length
  const report = {
    _v: 1,
    ok: cases.length === EXPECTED_CASES && passed === EXPECTED_CASES && cleaned,
    harness: 'true-up-config-composition-package',
    schemaVersion: 1,
    entry: boundary?.report || null,
    coverage: {
      must: { total: EXPECTED_CASES, executed: cases.length, passed },
      score: passed / EXPECTED_CASES,
    },
    fixturesCleaned: cleaned,
    cases,
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, jsonText(report))
  process.stdout.write(`config composition package: ${passed}/${EXPECTED_CASES} passed; report=${reportPath}; sha256=${sha256(readFileSync(reportPath))}\n`)
  return report.ok ? 0 : 1
}

let options
try { options = parseArgs(process.argv.slice(2)) } catch (error) {
  if (!(error instanceof UsageError)) throw error
  process.stderr.write(`${error.message}\n\n${USAGE}`)
  process.exit(2)
}
if (options.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}
try { process.exitCode = await main(options) }
catch (error) {
  process.stderr.write(`${error?.stack || error}\n`)
  process.exitCode = 1
}
