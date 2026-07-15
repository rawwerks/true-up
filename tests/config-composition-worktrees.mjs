#!/usr/bin/env node
// Wave 2 T80 worktree/staging contract for native config composition.
//
// Usage:
//   node tests/config-composition-worktrees.mjs [true-up-entry] [report.json]
//
// Every repository/worktree fixture lives below the machine's persistent scratch directory and is removed before exit. The optional
// report is deliberately outside the fixture root so CI/auditors can persist the result. This suite
// tests the real CLI; it does not import the pure loader and therefore kills root-only engine wiring.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const entry = resolve(process.argv[2] || join(HERE, '..', 'bin', 'true-up'))
const reportArg = process.argv[3] ? resolve(process.argv[3]) : null
const scratchBase = resolve(process.env.TRUE_UP_CONFIG_WORKTREE_SCRATCH
  || join(homedir(), 'scratch', 'true-up-config-composition', 'worktree-tests'))
mkdirSync(scratchBase, { recursive: true })
const runRoot = mkdtempSync(join(scratchBase, 'run-'))
const maxBuffer = 32 * 1024 * 1024
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const graphHash = (value) => sha256(value).slice(0, 16)
const graphPath = (root) => join(root, '.true-up', 'depgraph.json')

if (!existsSync(entry)) throw new Error(`true-up entry does not exist: ${entry}`)
if (reportArg && reportArg.startsWith(`${runRoot}/`)) {
  throw new Error('report path must be outside the disposable fixture root')
}

const jjConfig = join(runRoot, 'jj-config.toml')
writeFileSync(jjConfig, '[user]\nname = "true-up composition tests"\nemail = "composition@true-up.invalid"\n')
const cleanEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  JJ_CONFIG: jjConfig,
}

function scrub(value) {
  return String(value ?? '').split(runRoot).join('<scratch>')
}

function command(tool, args, options = {}) {
  return spawnSync(tool, args, {
    encoding: 'utf8',
    maxBuffer,
    env: cleanEnv,
    ...options,
  })
}

function git(root, args, options = {}) {
  return command('git', ['-C', root, ...args], options)
}

function jj(root, args, options = {}) {
  return command('jj', ['-R', root, '--no-pager', ...args], { cwd: root, ...options })
}

function cli(root, args, options = {}) {
  return command(process.execPath, [entry, '--repo', root, ...args], {
    cwd: root,
    ...options,
  })
}

function assertRun(result, label, expectedExit = 0) {
  assert.equal(result.error, undefined, `${label}: spawn error: ${result.error}`)
  assert.equal(
    result.status,
    expectedExit,
    `${label}: exit=${result.status}, expected=${expectedExit}\nstdout=${scrub(result.stdout)}\nstderr=${scrub(result.stderr)}`,
  )
  return result
}

function envelope(result, label, expectedExit = 0) {
  assertRun(result, label, expectedExit)
  let parsed
  try { parsed = JSON.parse(result.stdout) }
  catch (error) { assert.fail(`${label}: invalid JSON envelope: ${error}\nstdout=${scrub(result.stdout)}`) }
  assert.equal(parsed?._v, 1, `${label}: missing _v:1`)
  assert.equal(typeof parsed?.ok, 'boolean', `${label}: missing boolean ok`)
  return parsed
}

function put(root, path, value) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  const bytes = Buffer.isBuffer(value) || typeof value === 'string'
    ? value
    : `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(target, bytes)
}

function rootManifest(include = ['config/core.json']) {
  return {
    _comment: 'worktree/staging composition fixture',
    compositionVersion: 1,
    include,
    zones: null,
    out: '.true-up/depgraph.json',
  }
}

function coreFragment(revision = 'baseline', intent = 'composition-worktree') {
  return {
    _revision: revision,
    facts: { 'data.json': [['items', 'id']] },
    zones: [{ path: '', visibility: 'public', audience: 'world', intent, rules: [] }],
    seed: [{ from: 'doc.md', to: 'data.json#items.a', kind: 'derives-facts-from' }],
  }
}

function initGit(root) {
  mkdirSync(root, { recursive: true })
  assertRun(git(root, ['init', '-q']), `${root}: git init`)
}

function commitAll(root, message) {
  assertRun(git(root, ['add', '-A']), `${message}: git add`)
  assertRun(git(root, [
    '-c', 'user.name=true-up composition tests',
    '-c', 'user.email=composition@true-up.invalid',
    'commit', '-qm', message,
  ]), `${message}: git commit`)
}

function writeBaseFiles(root, { revision = 'baseline', intent = 'composition-worktree' } = {}) {
  put(root, '.true-up.json', rootManifest())
  put(root, 'config/core.json', coreFragment(revision, intent))
  put(root, 'data.json', { items: [{ id: 'a', value: 1 }] })
  put(root, 'doc.md', '# dependent\n')
}

function assertComposedGraph(root, { intent = 'composition-worktree', source = 'config/core.json' } = {}) {
  const bytes = readFileSync(graphPath(root))
  const graph = JSON.parse(bytes)
  const fragment = graph.nodes?.[`file:${source}`]
  assert(fragment, `graph omitted explicit config source node file:${source}`)
  assert.equal(fragment.hash, graphHash(readFileSync(join(root, source))), 'fragment node hash is not its exact raw bytes')
  const edge = graph.edges?.find((candidate) => candidate.from === 'file:doc.md'
    && candidate.to === 'fact:data.json#items.a')
  assert(edge, 'graph omitted the child-only declared fact edge')
  assert.deepEqual(
    edge.declaredIn,
    { source, pointer: '/seed/0' },
    'fragment edge lost or changed repo-relative declaration provenance',
  )
  assert.equal(graph.nodes?.['file:data.json']?.zone, intent, 'selected worktree used another worktree\'s effective zones')
  return { graph, bytes, hash: sha256(bytes) }
}

function build(root, label) {
  const result = envelope(cli(root, ['build', '--json']), label)
  assert.equal(result.ok, true, `${label}: build envelope was not successful`)
  assertComposedGraph(root)
  return result
}

function makeCommittedRepo(name) {
  const root = join(runRoot, name)
  initGit(root)
  writeBaseFiles(root)
  build(root, `${name}: initial composed build`)
  commitAll(root, `${name}: baseline`)
  const checked = envelope(cli(root, ['--check', '--committed', '--json']), `${name}: baseline committed check`)
  assert.equal(checked.ok, true)
  assert.equal(checked.mode, 'committed')
  return root
}

function expectStaleCommitted(root, label) {
  const result = envelope(cli(root, ['--check', '--committed', '--json']), label, 1)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'stale-graph')
  assert.equal(result.mode, 'committed')
  return result
}

function detailCode(value) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.code === 'string') return value.code
  for (const key of ['detail', 'config', 'diagnostic']) {
    const found = detailCode(value[key])
    if (found) return found
  }
  return null
}

function expectInvalidConfig(root, args, label, code) {
  const result = envelope(cli(root, [...args, '--json']), label, 2)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'invalid-config')
  assert.equal(detailCode(result), code, `${label}: expected composition detail code ${code}`)
  assert(!JSON.stringify(result).includes(runRoot), `${label}: JSON diagnostic leaked absolute scratch path`)
  return result
}

function fileState(path) {
  const stat = lstatSync(path)
  const bytes = stat.isFile() ? readFileSync(path) : Buffer.alloc(0)
  return {
    bytes: bytes.length,
    hash: sha256(bytes),
    ino: stat.ino,
    mtimeNs: stat.mtimeNs?.toString() ?? String(Math.round(stat.mtimeMs * 1e6)),
  }
}

function selectedState(root) {
  return Object.fromEntries([
    '.true-up.json',
    'config/core.json',
    'data.json',
    'doc.md',
    '.true-up/depgraph.json',
  ].map((path) => [path, fileState(join(root, path))]))
}

function seedCache(root, marker, epochSeconds) {
  put(root, '.true-up/depgraph.json', `${marker}\n`)
  utimesSync(graphPath(root), epochSeconds, epochSeconds)
  return fileState(graphPath(root))
}

function assertInputStateEqual(before, after, label) {
  for (const path of ['.true-up.json', 'config/core.json', 'data.json', 'doc.md']) {
    assert.deepEqual(after[path], before[path], `${label}: mutated input ${path}`)
  }
}

function assertOwnCacheReplaced(before, after, label) {
  assert.notEqual(after.hash, before.hash, `${label}: sentinel graph bytes/hash survived build`)
  assert.notEqual(after.ino, before.ino, `${label}: graph was not replaced by atomic rename`)
  assert.notEqual(after.mtimeNs, before.mtimeNs, `${label}: sentinel graph mtime survived build`)
}

function asyncCli(root, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, '--repo', root, ...args], {
      cwd: root,
      env: { ...cleanEnv, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxBuffer) child.kill('SIGKILL')
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > maxBuffer) child.kill('SIGKILL')
      else stderr.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (status, signal) => resolvePromise({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      error: undefined,
    }))
  })
}

async function waitForFile(path, timeoutMs = 10_000) {
  const started = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for race signal: ${path}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}

const tests = []
const test = (name, matrix, fn) => tests.push({ name, matrix, fn })

test(
  'Git index: staged fragment plus matching staged graph passes',
  'git-staged-fragment-plus-graph',
  () => {
    const root = makeCommittedRepo('git-staged-fragment-plus-graph')
    const entryBefore = sha256(readFileSync(join(root, '.true-up.json')))
    put(root, 'config/core.json', coreFragment('staged-match'))
    build(root, 'staged fragment+graph: rebuild')
    assertRun(git(root, ['add', 'config/core.json', '.true-up/depgraph.json']), 'stage fragment and graph')
    const checked = envelope(cli(root, ['--check', '--committed', '--json']), 'staged fragment+graph committed check')
    assert.equal(checked.ok, true)
    assert.equal(sha256(readFileSync(join(root, '.true-up.json'))), entryBefore, 'root manifest changed during fragment-only edit')
  },
)

test(
  'Git index: staged fragment without graph fails even when entry is unchanged',
  'git-staged-fragment-without-graph',
  () => {
    const root = makeCommittedRepo('git-staged-fragment-without-graph')
    const entryBefore = fileState(join(root, '.true-up.json'))
    put(root, 'config/core.json', coreFragment('staged-without-graph'))
    assertRun(git(root, ['add', 'config/core.json']), 'stage fragment only')
    expectStaleCommitted(root, 'staged fragment without graph committed check')
    assert.deepEqual(fileState(join(root, '.true-up.json')), entryBefore, 'unchanged root entry was rewritten')
  },
)

test(
  'Git index: staged graph plus a later unstaged fragment edit fails',
  'git-staged-graph-then-unstaged-fragment',
  () => {
    const root = makeCommittedRepo('git-staged-graph-then-unstaged-fragment')
    put(root, 'config/core.json', coreFragment('staged-version'))
    build(root, 'staged graph then unstaged fragment: staged-version rebuild')
    assertRun(git(root, ['add', 'config/core.json', '.true-up/depgraph.json']), 'stage version and graph')
    put(root, 'config/core.json', coreFragment('unstaged-version'))
    expectStaleCommitted(root, 'staged graph plus unstaged fragment committed check')
  },
)

test(
  'Git index: a fragment mutation during either committed graph probe cannot pass false-clean',
  'git-committed-check-config-race',
  async () => {
    const root = makeCommittedRepo('git-committed-check-config-race')
    const realGit = command('sh', ['-c', 'command -v git']).stdout.trim()
    assert(realGit, 'could not resolve real git for race wrapper')
    for (const pauseOn of [1, 2]) {
      put(root, 'config/core.json', coreFragment(`race-old-${pauseOn}`))
      build(root, `race fixture rebuild ${pauseOn}`)
      assertRun(git(root, ['add', 'config/core.json', '.true-up/depgraph.json']), `stage race fixture ${pauseOn}`)

      const wrapperDir = join(runRoot, `race-git-wrapper-${pauseOn}`)
      const signal = join(runRoot, `race-blob-probe-${pauseOn}.signal`)
      const resume = join(runRoot, `race-blob-probe-${pauseOn}.continue`)
      const counter = join(runRoot, `race-blob-probe-${pauseOn}.count`)
      put(wrapperDir, 'git', `#!/bin/sh\ncase " $* " in\n  *" rev-parse "*" :.true-up/depgraph.json "*)\n    count=0\n    if [ -f "$AUDIT_COUNTER" ]; then IFS= read -r count < "$AUDIT_COUNTER"; fi\n    count=$((count + 1))\n    printf '%s\\n' "$count" > "$AUDIT_COUNTER"\n    if [ "$count" -eq "$AUDIT_PAUSE_ON" ]; then\n      : > "$AUDIT_SIGNAL"\n      while [ ! -e "$AUDIT_SIGNAL_CONTINUE" ]; do sleep 0.01; done\n    fi\n    ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`)
      chmodSync(join(wrapperDir, 'git'), 0o755)

      const pending = asyncCli(root, ['--check', '--committed', '--json'], {
        env: {
          PATH: `${wrapperDir}:${cleanEnv.PATH}`,
          AUDIT_SIGNAL: signal,
          AUDIT_SIGNAL_CONTINUE: resume,
          AUDIT_COUNTER: counter,
          AUDIT_PAUSE_ON: String(pauseOn),
        },
      })
      await waitForFile(signal)
      put(root, 'config/core.json', coreFragment(`race-new-${pauseOn}`))
      put(runRoot, `race-blob-probe-${pauseOn}.continue`, '')
      const raced = envelope(await pending, `raced committed check at graph probe ${pauseOn}`, 1)
      assert.equal(raced.ok, false)
      assert.equal(raced.kind, 'stale-graph')
      assert.match(raced.reason, /changed during|unstaged/i, 'raced check did not name repository movement')
      assert(raced.configSourceProblems?.some((problem) => problem.path === 'config/core.json'), 'raced check omitted changed fragment')
    }

    expectStaleCommitted(root, 'post-race committed check')
  },
)

for (const [flag, matrix] of [
  ['--skip-worktree', 'git-skip-worktree-fragment'],
  ['--assume-unchanged', 'git-assume-unchanged-fragment'],
]) test(
  `Git index: ${flag} cannot hide working fragment bytes from committed freshness`,
  matrix,
  () => {
    const root = makeCommittedRepo(matrix)
    assertRun(git(root, ['update-index', flag, 'config/core.json']), `${matrix}: set index flag`)
    put(root, 'config/core.json', coreFragment(matrix))
    const hidden = assertRun(git(root, ['diff', '--name-only']), `${matrix}: prove ordinary diff is blind`).stdout.trim()
    assert.equal(hidden, '', `${matrix}: fixture did not hide the worktree edit from git diff`)
    build(root, `${matrix}: rebuild graph from hidden working bytes`)
    assertRun(git(root, ['add', '.true-up/depgraph.json']), `${matrix}: stage graph only`)
    const stale = expectStaleCommitted(root, `${matrix}: committed check`)
    const expectedState = flag.slice(2)
    assert(stale.configSourceProblems?.some((problem) => problem.path === 'config/core.json' && problem.state === expectedState), `${matrix}: hidden index flag was not reported as ${expectedState}`)
  },
)

test(
  'Git clean filters: CRLF working config equal to LF index remains fresh',
  'git-clean-filter-crlf-config',
  () => {
    const root = makeCommittedRepo('git-clean-filter-crlf-config')
    put(root, '.gitattributes', 'config/core.json text eol=crlf\n')
    commitAll(root, 'add config CRLF attribute')
    rmSync(join(root, 'config/core.json'))
    assertRun(git(root, ['checkout-index', '-f', '--', 'config/core.json']), 'materialize filtered CRLF config')
    assert(readFileSync(join(root, 'config/core.json')).includes(Buffer.from('\r\n')), 'fixture did not materialize CRLF working bytes')
    assert.equal(assertRun(git(root, ['diff', '--name-only']), 'prove filtered config is Git-clean').stdout.trim(), '', 'Git does not consider filtered config clean')
    build(root, 'filtered config rebuild')
    assertRun(git(root, ['add', '.true-up/depgraph.json']), 'stage graph built from filtered bytes')
    const checked = envelope(cli(root, ['--check', '--committed', '--json']), 'filtered config committed check')
    assert.equal(checked.ok, true, 'Git-clean filtered config was falsely reported stale')
  },
)

test(
  'ordinary composed build/graph/policy never execute repository clean filters',
  'git-clean-filter-not-executed-by-ordinary-commands',
  () => {
    const root = makeCommittedRepo('git-clean-filter-not-executed-by-ordinary-commands')
    const marker = join(root, 'config-filter-ran')
    put(root, '.gitattributes', 'config/core.json filter=config-audit\n')
    put(root, 'tools/config-audit-filter.sh', '#!/bin/sh\n: > config-filter-ran\ncat\n')
    chmodSync(join(root, 'tools/config-audit-filter.sh'), 0o755)
    commitAll(root, 'add dormant clean-filter fixture')
    assertRun(git(root, ['config', 'filter.config-audit.clean', './tools/config-audit-filter.sh']), 'configure valid-source filter sentinel')

    for (const [label, args] of [
      ['build', ['build', '--no-write', '--json']],
      ['graph', ['graph', '--json']],
      ['policy', ['--policy', '--json']],
    ]) {
      envelope(cli(root, args), `clean-filter ordinary ${label}`)
      assert(!existsSync(marker), `${label} executed a repository-defined clean filter while loading valid composed config`)
    }
  },
)

test(
  'Git index: staged deletion of an included fragment fails closed',
  'git-included-fragment-deleted',
  () => {
    const root = makeCommittedRepo('git-included-fragment-deleted')
    assertRun(git(root, ['rm', '-q', 'config/core.json']), 'stage included fragment deletion')
    expectInvalidConfig(root, ['--check', '--committed'], 'deleted include committed check', 'include-missing')
  },
)

test(
  'Git index: staged rename of an included fragment fails closed',
  'git-included-fragment-renamed',
  () => {
    const root = makeCommittedRepo('git-included-fragment-renamed')
    assertRun(git(root, ['mv', 'config/core.json', 'config/renamed.json']), 'stage included fragment rename')
    expectInvalidConfig(root, ['--check', '--committed'], 'renamed include committed check', 'include-missing')
  },
)

test(
  'Git index: an untracked include builds locally but committed check fails until tracked',
  'git-untracked-include',
  () => {
    const root = makeCommittedRepo('git-untracked-include')
    put(root, 'extra-source.md', '# extra source\n')
    put(root, 'extra-doc.md', '# extra dependent\n')
    assertRun(git(root, ['add', 'extra-source.md', 'extra-doc.md']), 'stage extra content')
    assertRun(git(root, [
      '-c', 'user.name=true-up composition tests',
      '-c', 'user.email=composition@true-up.invalid',
      'commit', '-qm', 'tracked extra content',
    ]), 'commit extra content')
    put(root, '.true-up.json', rootManifest(['config/core.json', 'config/untracked.json']))
    put(root, 'config/untracked.json', {
      _revision: 'untracked',
      seed: [{ from: 'extra-doc.md', to: 'extra-source.md', kind: 'derives-facts-from' }],
    })
    envelope(cli(root, ['build', '--json']), 'untracked include local build')
    const graph = JSON.parse(readFileSync(graphPath(root)))
    assert(graph.nodes?.['file:config/untracked.json'], 'local build omitted untracked explicit config source')
    assert(graph.edges?.some((edge) => edge.from === 'file:extra-doc.md' && edge.to === 'file:extra-source.md'), 'local build ignored untracked fragment declaration')
    assertRun(git(root, ['add', '.true-up.json', '.true-up/depgraph.json']), 'stage entry and graph but not fragment')
    const stale = expectStaleCommitted(root, 'untracked include committed check')
    assert.match(JSON.stringify(stale), /config\/untracked\.json/, 'committed diagnostic omitted the untracked source path')
    assert.match(JSON.stringify(stale), /untracked|not[^\"]*(tracked|staged)/i, 'committed diagnostic omitted the untracked state')
    const status = envelope(cli(root, ['status', '--json']), 'untracked include status')
    assert.match(JSON.stringify(status), /config\/untracked\.json/, 'status omitted the untracked config source')
    assert.match(JSON.stringify(status), /untracked/i, 'status omitted the source tracking warning')
    for (const source of status.configSources || []) {
      assert.deepEqual(
        Object.keys(source).sort(),
        ['bytes', 'hash', 'path', 'role', 'state'],
        'status leaked provider-specific tracking internals outside the stable config-source allowlist',
      )
    }
    assertRun(git(root, ['add', 'config/untracked.json']), 'stage formerly untracked fragment')
    const checked = envelope(cli(root, ['--check', '--committed', '--json']), 'tracked include committed check')
    assert.equal(checked.ok, true)
  },
)

test(
  'Git ignore: ignored includes are invalid and preserve prior graph bytes and metadata',
  'git-ignored-include',
  () => {
    const root = makeCommittedRepo('git-ignored-include')
    put(root, '.gitignore', 'generated/\n')
    put(root, '.gitattributes', 'generated/ignored.json filter=config-audit\n')
    put(root, 'tools/config-audit-filter.sh', '#!/bin/sh\n: > ignored-config-filter-ran\ncat\n')
    chmodSync(join(root, 'tools/config-audit-filter.sh'), 0o755)
    assertRun(git(root, ['config', 'filter.config-audit.clean', './tools/config-audit-filter.sh']), 'configure ignored-source filter sentinel')
    put(root, '.true-up.json', rootManifest(['config/core.json', 'generated/ignored.json']))
    put(root, 'generated/ignored.json', { seed: [{ from: 'ignored.md', to: 'data.json' }] })
    const before = seedCache(root, 'IGNORED-INCLUDE-SENTINEL', 978307200)
    expectInvalidConfig(root, ['build'], 'ignored include build', 'include-ignored')
    assert(!existsSync(join(root, 'ignored-config-filter-ran')), 'ignored include executed its Git clean filter before rejection')
    assert.deepEqual(fileState(graphPath(root)), before, 'invalid ignored include mutated the prior graph')
  },
)

test(
  'linked worktrees: isolated sentinel caches and concurrent builds never cross roots',
  'git-linked-worktree-isolation-and-concurrency',
  async () => {
    const base = join(runRoot, 'linked-base')
    initGit(base)
    writeBaseFiles(base)
    put(base, '.gitignore', '.true-up/\n')
    commitAll(base, 'linked worktree base')
    const worktreeA = join(runRoot, 'linked-a')
    const worktreeB = join(runRoot, 'linked-b')
    assertRun(git(base, ['worktree', 'add', '-q', '-b', 'composition-linked-a', worktreeA, 'HEAD']), 'add linked worktree A')
    assertRun(git(base, ['worktree', 'add', '-q', '-b', 'composition-linked-b', worktreeB, 'HEAD']), 'add linked worktree B')
    put(worktreeA, 'config/core.json', coreFragment('linked-a', 'linked-worktree-a'))
    put(worktreeA, 'data.json', { items: [{ id: 'a', value: 'A' }] })
    put(worktreeB, 'config/core.json', coreFragment('linked-b', 'linked-worktree-b'))
    put(worktreeB, 'data.json', { items: [{ id: 'a', value: 'B' }] })

    seedCache(worktreeA, 'WORKTREE-A-SENTINEL-ONE', 946684800)
    seedCache(worktreeB, 'WORKTREE-B-SENTINEL-ONE', 978307200)
    const beforeA1 = selectedState(worktreeA)
    const beforeB1 = selectedState(worktreeB)
    envelope(cli(worktreeA, ['build', '--json']), 'isolated build A')
    const afterA1 = selectedState(worktreeA)
    const afterB1 = selectedState(worktreeB)
    assertInputStateEqual(beforeA1, afterA1, 'isolated build A')
    assertOwnCacheReplaced(beforeA1['.true-up/depgraph.json'], afterA1['.true-up/depgraph.json'], 'isolated build A')
    assert.deepEqual(afterB1, beforeB1, 'build A changed worktree B bytes/inode/mtime/hash')
    assertComposedGraph(worktreeA, { intent: 'linked-worktree-a' })

    seedCache(worktreeA, 'WORKTREE-A-SENTINEL-TWO', 1009843200)
    seedCache(worktreeB, 'WORKTREE-B-SENTINEL-TWO', 1041379200)
    const beforeA2 = selectedState(worktreeA)
    const beforeB2 = selectedState(worktreeB)
    envelope(cli(worktreeB, ['build', '--json']), 'isolated build B')
    const afterA2 = selectedState(worktreeA)
    const afterB2 = selectedState(worktreeB)
    assert.deepEqual(afterA2, beforeA2, 'build B changed worktree A bytes/inode/mtime/hash')
    assertInputStateEqual(beforeB2, afterB2, 'isolated build B')
    assertOwnCacheReplaced(beforeB2['.true-up/depgraph.json'], afterB2['.true-up/depgraph.json'], 'isolated build B')
    assertComposedGraph(worktreeB, { intent: 'linked-worktree-b' })

    seedCache(worktreeA, 'WORKTREE-A-CONCURRENT-SENTINEL', 1072915200)
    seedCache(worktreeB, 'WORKTREE-B-CONCURRENT-SENTINEL', 1104537600)
    const concurrentBeforeA = selectedState(worktreeA)
    const concurrentBeforeB = selectedState(worktreeB)
    const [buildA, buildB] = await Promise.all([
      asyncCli(worktreeA, ['build', '--json']),
      asyncCli(worktreeB, ['build', '--json']),
    ])
    envelope(buildA, 'concurrent build A')
    envelope(buildB, 'concurrent build B')
    const concurrentAfterA = selectedState(worktreeA)
    const concurrentAfterB = selectedState(worktreeB)
    assertInputStateEqual(concurrentBeforeA, concurrentAfterA, 'concurrent build A')
    assertInputStateEqual(concurrentBeforeB, concurrentAfterB, 'concurrent build B')
    assertOwnCacheReplaced(concurrentBeforeA['.true-up/depgraph.json'], concurrentAfterA['.true-up/depgraph.json'], 'concurrent build A')
    assertOwnCacheReplaced(concurrentBeforeB['.true-up/depgraph.json'], concurrentAfterB['.true-up/depgraph.json'], 'concurrent build B')
    const graphA = assertComposedGraph(worktreeA, { intent: 'linked-worktree-a' })
    const graphB = assertComposedGraph(worktreeB, { intent: 'linked-worktree-b' })
    assert.notEqual(graphA.hash, graphB.hash, 'distinct worktrees produced one shared/cross-contaminated graph')
    assert.equal(graphA.graph.nodes['file:data.json'].hash, graphHash(readFileSync(join(worktreeA, 'data.json'))))
    assert.equal(graphB.graph.nodes['file:data.json'].hash, graphHash(readFileSync(join(worktreeB, 'data.json'))))
    for (const root of [worktreeA, worktreeB]) {
      const residue = readdirSync(join(root, '.true-up')).filter((name) => name.endsWith('.tmp'))
      assert.deepEqual(residue, [], `${root}: concurrent build left atomic-write residue`)
    }
    const commonDirResult = assertRun(git(worktreeA, ['rev-parse', '--git-common-dir']), 'resolve shared Git common dir')
    const rawCommon = commonDirResult.stdout.trim()
    const commonDir = isAbsolute(rawCommon) ? rawCommon : resolve(worktreeA, rawCommon)
    assert(!existsSync(join(commonDir, '.true-up', 'depgraph.json')), 'graph cache leaked into the shared Git common directory')
  },
)

const jjVersionResult = command('jj', ['--version'])
const jjAvailable = !jjVersionResult.error && jjVersionResult.status === 0
const jjSkip = jjAvailable ? null : scrub(jjVersionResult.error?.message || `jj --version exit ${jjVersionResult.status}`)

test(
  'jj-only: composed source and graph freshness are tracked in @',
  'jj-only-composed-freshness',
  () => {
    if (!jjAvailable) return { skip: jjSkip }
    const root = join(runRoot, 'jj-only-composed')
    mkdirSync(root, { recursive: true })
    assertRun(command('jj', ['git', 'init', '--no-colocate', root]), 'jj-only init')
    assert(existsSync(join(root, '.jj')) && !existsSync(join(root, '.git')), 'fixture is not jj-only')
    writeBaseFiles(root, { intent: 'jj-only-composed' })
    envelope(cli(root, ['build', '--json']), 'jj-only initial composed build')
    assertComposedGraph(root, { intent: 'jj-only-composed' })
    assertRun(jj(root, ['commit', '-m', 'jj-only composition baseline']), 'jj-only baseline commit')
    const status = envelope(cli(root, ['status', '--json']), 'jj-only composed status')
    assert.equal(status.workspace?.vcs, 'jj')
    assert.equal(status.workspace?.jj?.colocated, false)
    let checked = envelope(cli(root, ['--check', '--committed', '--json']), 'jj-only fresh committed check')
    assert.equal(checked.ok, true)
    put(root, 'config/core.json', coreFragment('jj-only-stale', 'jj-only-composed'))
    checked = expectStaleCommitted(root, 'jj-only fragment-only committed check')
    assert.equal(checked.vcs, 'jj')
    envelope(cli(root, ['build', '--json']), 'jj-only fragment rebuild')
    checked = envelope(cli(root, ['--check', '--committed', '--json']), 'jj-only rebuilt committed check')
    assert.equal(checked.ok, true)
  },
)

test(
  'jj-only: a fragment mutation during either committed graph probe cannot pass false-clean',
  'jj-only-committed-check-config-race',
  async () => {
    if (!jjAvailable) return { skip: jjSkip }
    const root = join(runRoot, 'jj-only-committed-check-config-race')
    mkdirSync(root, { recursive: true })
    assertRun(command('jj', ['git', 'init', '--no-colocate', root]), 'jj race init')
    writeBaseFiles(root, { intent: 'jj-race' })
    envelope(cli(root, ['build', '--json']), 'jj race initial build')
    assertRun(jj(root, ['commit', '-m', 'jj race baseline']), 'jj race baseline commit')
    envelope(cli(root, ['--check', '--committed', '--json']), 'jj race baseline check')

    const realJj = command('sh', ['-c', 'command -v jj']).stdout.trim()
    assert(realJj, 'could not resolve real jj for race wrapper')
    for (const pauseOn of [1, 2]) {
      put(root, 'config/core.json', coreFragment(`jj-race-old-${pauseOn}`, 'jj-race'))
      envelope(cli(root, ['build', '--json']), `jj race rebuild ${pauseOn}`)

      const wrapperDir = join(runRoot, `race-jj-wrapper-${pauseOn}`)
      const signal = join(runRoot, `jj-race-blob-probe-${pauseOn}.signal`)
      const resume = join(runRoot, `jj-race-blob-probe-${pauseOn}.continue`)
      const counter = join(runRoot, `jj-race-blob-probe-${pauseOn}.count`)
      put(wrapperDir, 'jj', `#!/bin/sh\ncase " $* " in\n  *" file list "*".true-up/depgraph.json"*)\n    count=0\n    if [ -f "$AUDIT_COUNTER" ]; then IFS= read -r count < "$AUDIT_COUNTER"; fi\n    count=$((count + 1))\n    printf '%s\\n' "$count" > "$AUDIT_COUNTER"\n    if [ "$count" -eq "$AUDIT_PAUSE_ON" ]; then\n      : > "$AUDIT_SIGNAL"\n      while [ ! -e "$AUDIT_SIGNAL_CONTINUE" ]; do sleep 0.01; done\n    fi\n    ;;\nesac\nexec ${JSON.stringify(realJj)} "$@"\n`)
      chmodSync(join(wrapperDir, 'jj'), 0o755)

      const pending = asyncCli(root, ['--check', '--committed', '--json'], {
        env: {
          PATH: `${wrapperDir}:${cleanEnv.PATH}`,
          AUDIT_SIGNAL: signal,
          AUDIT_SIGNAL_CONTINUE: resume,
          AUDIT_COUNTER: counter,
          AUDIT_PAUSE_ON: String(pauseOn),
        },
      })
      await waitForFile(signal)
      put(root, 'config/core.json', coreFragment(`jj-race-new-${pauseOn}`, 'jj-race'))
      put(runRoot, `jj-race-blob-probe-${pauseOn}.continue`, '')
      const raced = envelope(await pending, `jj raced committed check at graph probe ${pauseOn}`, 1)
      assert.equal(raced.kind, 'stale-graph')
      assert.match(raced.reason, /changed during|unstaged/i)
      assert(raced.configSourceProblems?.some((problem) => problem.path === 'config/core.json'), 'jj raced check omitted changed fragment')
    }
    expectStaleCommitted(root, 'jj post-race committed check')
  },
)

test(
  'colocated jj: composed config retains Git index semantics',
  'colocated-jj-composed-freshness',
  () => {
    if (!jjAvailable) return { skip: jjSkip }
    const root = join(runRoot, 'colocated-jj-composed')
    mkdirSync(root, { recursive: true })
    assertRun(command('jj', ['git', 'init', '--colocate', root]), 'colocated jj init')
    assert(existsSync(join(root, '.jj')) && existsSync(join(root, '.git')), 'fixture is not colocated jj')
    writeBaseFiles(root, { intent: 'colocated-jj-composed' })
    envelope(cli(root, ['build', '--json']), 'colocated initial composed build')
    assertComposedGraph(root, { intent: 'colocated-jj-composed' })
    commitAll(root, 'colocated composition baseline')
    const status = envelope(cli(root, ['status', '--json']), 'colocated composed status')
    assert.equal(status.workspace?.vcs, 'git')
    assert.equal(status.workspace?.jj?.colocated, true)
    put(root, 'config/core.json', coreFragment('colocated-staged', 'colocated-jj-composed'))
    assertRun(git(root, ['add', 'config/core.json']), 'colocated stage fragment only')
    expectStaleCommitted(root, 'colocated staged fragment without graph')
    envelope(cli(root, ['build', '--json']), 'colocated fragment rebuild')
    assertRun(git(root, ['add', '.true-up/depgraph.json']), 'colocated stage graph')
    const checked = envelope(cli(root, ['--check', '--committed', '--json']), 'colocated staged fragment+graph')
    assert.equal(checked.ok, true)
    assert.equal(checked.vcs, 'git')
  },
)

const results = []
let fixtureCleaned = false
try {
  for (const current of tests) {
    try {
      const outcome = await current.fn()
      if (outcome?.skip) {
        results.push({ name: current.name, matrix: current.matrix, status: 'skip', reason: outcome.skip })
        process.stdout.write(`SKIP ${current.matrix}: ${outcome.skip}\n`)
      } else {
        results.push({ name: current.name, matrix: current.matrix, status: 'pass' })
        process.stdout.write(`PASS ${current.matrix}\n`)
      }
    } catch (error) {
      const message = scrub(error?.stack || error)
      results.push({ name: current.name, matrix: current.matrix, status: 'fail', message })
      process.stdout.write(`FAIL ${current.matrix}: ${message.split('\n')[0]}\n`)
    }
  }
} finally {
  rmSync(runRoot, { recursive: true, force: true })
  fixtureCleaned = !existsSync(runRoot)
}

const counts = {
  pass: results.filter((result) => result.status === 'pass').length,
  fail: results.filter((result) => result.status === 'fail').length,
  skip: results.filter((result) => result.status === 'skip').length,
}
const report = {
  _v: 1,
  suite: 'config-composition-worktrees',
  entry: { path: entry, sha256: sha256(readFileSync(entry)) },
  environment: {
    node: process.version,
    git: scrub(command('git', ['--version']).stdout.trim()),
    jj: jjAvailable ? scrub(jjVersionResult.stdout.trim()) : null,
  },
  fixturePolicy: { base: scratchBase, cleaned: fixtureCleaned },
  counts,
  results,
}
if (reportArg) {
  mkdirSync(dirname(reportArg), { recursive: true })
  writeFileSync(reportArg, `${JSON.stringify(report, null, 2)}\n`)
}
process.stdout.write(`config composition worktree tests: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped; fixtures cleaned=${fixtureCleaned}\n`)
if (counts.fail) process.exit(1)
