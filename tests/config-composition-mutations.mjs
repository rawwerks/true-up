#!/usr/bin/env node
// Wave 3C — targeted mutation analysis for the native config-composition boundary.
//
// This runner never edits the production checkout. Each mutant is applied to a disposable source
// copy, killed by a named production-facing oracle, and paired with the same oracle against an exact
// unmodified copy. Red/green logs and their hashes are persisted for independent audit.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SELF = fileURLToPath(import.meta.url)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`

const put = (root, path, value) => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : jsonText(value))
}

const git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result
}

const initRepo = (root) => {
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q'])
  git(root, ['config', 'user.name', 'true-up mutation tests'])
  git(root, ['config', 'user.email', 'mutations@true-up.invalid'])
}

const commitAll = (root, message) => {
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', message])
}

const runCli = (candidate, root, args) => spawnSync(
  process.execPath,
  [join(candidate, 'bin/true-up'), '--repo', root, ...args],
  {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      TRUE_UP_CONFIG_TEST_SCRATCH: undefined,
    },
  },
)

const parseEnvelope = (result, label) => {
  try { return JSON.parse(result.stdout) }
  catch (error) {
    assert.fail(`${label}: stdout was not one JSON object: ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
}

const loadModule = async (candidate) => import(pathToFileURL(join(candidate, 'lib/config.mjs')).href)
const composedRoot = (include, extra = {}) => ({ compositionVersion: 1, include, zones: null, ...extra })

const expectConfigCode = (fn, code, marker) => {
  let thrown
  try { fn() } catch (error) { thrown = error }
  assert(thrown, marker)
  assert.equal(thrown.code, code, `${marker}: expected ${code}, got ${thrown?.code}`)
  return thrown
}

const loader = async (candidate, root) => {
  const mod = await loadModule(candidate)
  return {
    mod,
    load: () => mod.loadConfigBundle({
      repoRoot: root,
      provider: mod.createNodeConfigProvider({ repoRoot: root, isIgnored: () => false }),
    }),
  }
}

const oracle = {
  async 'root-only-loading'(candidate, scratch) {
    const root = join(scratch, 'repo')
    mkdirSync(root, { recursive: true })
    put(root, '.true-up.json', composedRoot(['config/core.json']))
    put(root, 'config/core.json', { facts: { 'data.json': [['items', 'id']] } })
    const { load } = await loader(candidate, root)
    const bundle = load()
    assert.deepEqual(bundle.config.facts?.['data.json'], [['items', 'id']], 'MUTATION_ORACLE root-only loading omitted child declarations')
  },

  async 'first-last-writer-wins'(candidate, scratch) {
    const root = join(scratch, 'repo')
    mkdirSync(root, { recursive: true })
    put(root, '.true-up.json', composedRoot(['a.json', 'z.json']))
    put(root, 'a.json', { facts: { 'shared.json': [['items', 'id']] } })
    put(root, 'z.json', { facts: { 'shared.json': [['other', 'id']] } })
    const { load } = await loader(candidate, root)
    expectConfigCode(load, 'cross-source-conflict', 'MUTATION_ORACLE first/last-writer merge accepted competing owners')
  },

  async 'include-order-dependence'(candidate, scratch) {
    const make = async (name, include) => {
      const root = join(scratch, name)
      mkdirSync(root, { recursive: true })
      put(root, '.true-up.json', composedRoot(include))
      put(root, 'a.json', { facts: { 'a.json': [['items', 'id']] } })
      put(root, 'z.json', { seed: [{ from: 'README.md', to: 'a.json#items.a' }] })
      const { load } = await loader(candidate, root)
      return load()
    }
    const left = await make('left', ['z.json', 'a.json'])
    const right = await make('right', ['a.json', 'z.json'])
    assert.deepEqual(left.composition.fragments, right.composition.fragments, 'MUTATION_ORACLE manifest include order changed canonical fragment order')
    assert.equal(left.normalizedConfigBytes, right.normalizedConfigBytes, 'MUTATION_ORACLE manifest include order changed normalized meaning')
    assert.deepEqual(left.provenance, right.provenance, 'MUTATION_ORACLE manifest include order changed provenance')
  },

  async 'wrong-semantic-path-base'(candidate, scratch) {
    const root = join(scratch, 'repo')
    mkdirSync(root, { recursive: true })
    put(root, '.true-up.json', composedRoot(['config/docs.json']))
    put(root, 'config/docs.json', { seed: [{ from: 'README.md', to: 'data.json', via: 'tools/gen.mjs' }] })
    const { load } = await loader(candidate, root)
    const edge = load().config.seed[0]
    assert.equal(edge.from, 'README.md', 'MUTATION_ORACLE declaration path was rebased to fragment directory')
    assert.equal(edge.to, 'data.json', 'MUTATION_ORACLE source-of-truth path was rebased to fragment directory')
    assert.equal(edge.via, 'tools/gen.mjs', 'MUTATION_ORACLE generator path was rebased to fragment directory')
  },

  async 'duplicate-concatenation'(candidate, scratch) {
    const root = join(scratch, 'repo')
    mkdirSync(root, { recursive: true })
    put(root, '.true-up.json', composedRoot(['a.json', 'z.json']))
    const edge = { from: 'README.md', to: 'data.json', kind: 'derives-facts-from' }
    put(root, 'a.json', { seed: [edge] })
    put(root, 'z.json', { seed: [edge] })
    const { load } = await loader(candidate, root)
    expectConfigCode(load, 'cross-source-conflict', 'MUTATION_ORACLE duplicate declarations were concatenated across sources')
  },

  async 'duplicate-key-acceptance'(candidate, scratch) {
    const root = join(scratch, 'repo')
    mkdirSync(root, { recursive: true })
    put(root, '.true-up.json', composedRoot(['child.json']))
    put(root, 'child.json', '{"facts":{"a.json":[["items","id"]]},"facts":{"b.json":[["items","id"]]}}\n')
    const { load } = await loader(candidate, root)
    expectConfigCode(load, 'duplicate-json-key', 'MUTATION_ORACLE duplicate JSON key was accepted with last-wins parsing')
  },

  async 'absent-vs-false-collapse'(candidate, scratch) {
    const root = join(scratch, 'repo')
    mkdirSync(root, { recursive: true })
    put(root, '.true-up.json', composedRoot(['child.json'], {
      out: '', symbols: false, strictSpans: false, deadlineMs: 0, repoId: '',
    }))
    put(root, 'child.json', { facts: { 'data.json': [['items', 'id']] } })
    const { load } = await loader(candidate, root)
    const projection = JSON.parse(load().normalizedConfigBytes)
    assert.equal(projection.out, '', 'MUTATION_ORACLE explicit empty string collapsed into absence')
    assert.equal(projection.symbols, false, 'MUTATION_ORACLE explicit false collapsed into absence')
    assert.equal(projection.strictSpans, false, 'MUTATION_ORACLE second explicit false collapsed into absence')
    assert.equal(projection.deadlineMs, 0, 'MUTATION_ORACLE explicit zero collapsed into absence')
    assert.equal(projection.repoId, '', 'MUTATION_ORACLE explicit empty repoId collapsed into absence')
  },

  async 'collision-rescue-by-later-declaration'(candidate, scratch) {
    const root = join(scratch, 'repo')
    mkdirSync(root, { recursive: true })
    put(root, '.true-up.json', composedRoot(['a.json', 'm.json', 'z.json'], {
      facts: { 'shared.json': [['items', 'root']] },
    }))
    for (const source of ['a.json', 'm.json', 'z.json']) {
      put(root, source, { facts: { 'shared.json': [['items', source]] } })
    }
    const { load } = await loader(candidate, root)
    const error = expectConfigCode(load, 'cross-source-conflict', 'MUTATION_ORACLE later declaration rescued a prior ownership collision')
    assert.deepEqual(
      error.conflicts[0].origins.map((origin) => origin.source),
      ['.true-up.json', 'a.json', 'm.json', 'z.json'],
      'MUTATION_ORACLE conflict did not retain every owner origin',
    )
  },

  async 'import-export-alias-bypass'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/imports.json']))
    put(root, 'config/imports.json', {
      imports: { '../bad': { path: 'imports/snapshot.json', repoId: 'upstream', audience: 'public' } },
      zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] }],
    })
    put(root, 'imports/snapshot.json', {
      kind: 'true-up-import-snapshot', _v: 1, ok: true, repoId: 'upstream', audience: 'public', facts: {},
    })
    git(root, ['add', '-A'])
    const result = runCli(candidate, root, ['build', '--no-write', '--json'])
    assert.notEqual(result.status, 0, `MUTATION_ORACLE import/export alias bypass accepted traversal alias\n${result.stdout}\n${result.stderr}`)
    assert.match(`${result.stdout}\n${result.stderr}`, /bad import alias|IMPORT ERROR|graph-build-errors/, 'MUTATION_ORACLE bad alias failure lost its stable reason')
  },

  async 'lexical-only-path-containment'(candidate, scratch) {
    const root = join(scratch, 'repo')
    const outside = join(scratch, 'outside')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    put(root, '.true-up.json', composedRoot(['alias/child.json']))
    put(outside, 'child.json', { facts: { 'escaped.json': [['items', 'id']] } })
    symlinkSync(outside, join(root, 'alias'))
    const { load } = await loader(candidate, root)
    expectConfigCode(load, 'include-symlink', 'MUTATION_ORACLE lexical-only containment followed an ancestor symlink outside the repo')
  },

  async 'eager-config-independent-traversal'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/broken.json']))
    put(root, 'config/broken.json', '{"seed":[')
    const help = runCli(candidate, root, ['--help'])
    assert.equal(help.status, 0, `MUTATION_ORACLE eager fragment traversal stole help precedence\n${help.stdout}\n${help.stderr}`)
    assert.match(help.stdout, /^true-up —/, 'MUTATION_ORACLE help output disappeared behind config traversal')
    assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, /invalid true-up config/, 'MUTATION_ORACLE help traversed malformed child config')
  },

  async 'staged-root-only-freshness'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/core.json']))
    put(root, 'config/core.json', {
      zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'baseline', rules: [] }],
    })
    put(root, 'README.md', '# fixture\n')
    git(root, ['add', '-A'])
    let result = runCli(candidate, root, ['build', '--json'])
    assert.equal(result.status, 0, `staged freshness baseline build failed: ${result.stdout}\n${result.stderr}`)
    commitAll(root, 'baseline')
    put(root, 'config/core.json', {
      zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'unstaged-child', rules: [] }],
    })
    result = runCli(candidate, root, ['build', '--json'])
    assert.equal(result.status, 0, `staged freshness changed build failed: ${result.stdout}\n${result.stderr}`)
    git(root, ['add', '.true-up/depgraph.json'])
    const checked = runCli(candidate, root, ['--check', '--committed', '--json'])
    assert.equal(checked.status, 1, `MUTATION_ORACLE staged-root-only freshness falsely passed an unstaged child\n${checked.stdout}\n${checked.stderr}`)
    const envelope = parseEnvelope(checked, 'staged-root-only freshness')
    assert(envelope.configSourceProblems?.some((problem) => problem.path === 'config/core.json'), 'MUTATION_ORACLE stale child was omitted from committed-check diagnostics')
  },

  async 'equal-specificity-zone-last-wins'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/zones.json']))
    put(root, 'config/zones.json', {
      zones: [
        { path: 'docs/', visibility: 'public', audience: 'world', intent: 'first', rules: [] },
        { path: 'docs/', visibility: 'public', audience: 'world', intent: 'second', rules: [] },
        { path: '', visibility: 'public', audience: 'world', intent: 'default', rules: [] },
      ],
    })
    put(root, 'docs/a.md', '# A\n')
    git(root, ['add', '-A'])
    const result = runCli(candidate, root, ['build', '--no-write', '--json'])
    assert.equal(result.status, 0, `zone tie fixture failed: ${result.stdout}\n${result.stderr}`)
    const graph = parseEnvelope(result, 'zone tie fixture')
    assert.equal(graph.graph.nodes['file:docs/a.md'].zone, 'first', 'MUTATION_ORACLE equal-specificity last-wins changed frozen first-wins zone semantics')
  },

  async 'swallowed-invalid-child-provenance'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/broken.json']))
    put(root, 'config/broken.json', '{"seed":[')
    const result = runCli(candidate, root, ['build', '--json'])
    assert.equal(result.status, 2, `invalid child fixture exited ${result.status}: ${result.stdout}\n${result.stderr}`)
    const envelope = parseEnvelope(result, 'invalid child provenance')
    assert.equal(envelope.detail?.source, 'config/broken.json', 'MUTATION_ORACLE invalid child source provenance was swallowed')
    assert.deepEqual(envelope.detail?.includeChain, ['.true-up.json', 'config/broken.json'], 'MUTATION_ORACLE invalid child include chain was swallowed')
  },

  async 'duplicate-generator-execution'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/generation.json']))
    put(root, 'config/generation.json', {
      zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] }],
      seed: [
        { from: 'out-a.md', to: 'data.json', kind: 'generated-from', via: 'tools/gen.mjs' },
        { from: 'out-b.md', to: 'data.json', kind: 'generated-from', via: 'tools/gen.mjs' },
      ],
    })
    put(root, 'data.json', { value: 1 })
    put(root, 'out-a.md', 'old a\n')
    put(root, 'out-b.md', 'old b\n')
    put(root, 'tools/gen.mjs', "import { existsSync, readFileSync, writeFileSync } from 'node:fs'\nconst n = existsSync('generator-count') ? Number(readFileSync('generator-count', 'utf8')) : 0\nwriteFileSync('generator-count', String(n + 1))\nwriteFileSync('out-a.md', 'new a\\n')\nwriteFileSync('out-b.md', 'new b\\n')\n")
    git(root, ['add', '-A'])
    let result = runCli(candidate, root, ['build', '--json'])
    assert.equal(result.status, 0, `generator baseline build failed: ${result.stdout}\n${result.stderr}`)
    commitAll(root, 'baseline')
    put(root, 'data.json', { value: 2 })
    result = runCli(candidate, root, ['run', '--since', 'HEAD', '--json'])
    assert.equal(result.status, 0, `generator run failed: ${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(join(root, 'generator-count'), 'utf8'), '1', 'MUTATION_ORACLE shared generator executed more than once')
  },

  async 'provenance-leak-loss'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/edges.json']))
    put(root, 'config/edges.json', {
      zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] }],
      seed: [{ from: 'README.md', to: 'data.json', kind: 'derives-facts-from' }],
    })
    put(root, 'README.md', '# docs\n')
    put(root, 'data.json', { value: 1 })
    git(root, ['add', '-A'])
    const result = runCli(candidate, root, ['graph', '--json'])
    assert.equal(result.status, 0, `provenance graph failed: ${result.stdout}\n${result.stderr}`)
    const graph = parseEnvelope(result, 'provenance graph')
    const edge = graph.graph.edges.find((item) => item.from === 'file:README.md' && item.to === 'file:data.json')
    assert.deepEqual(edge?.declaredIn, { source: 'config/edges.json', pointer: '/seed/0' }, 'MUTATION_ORACLE composed edge provenance was lost or leaked')
    assert(!JSON.stringify(edge.declaredIn).includes(scratch), 'MUTATION_ORACLE composed edge provenance leaked an absolute path')
  },

  async 'partial-graph-write-before-validation'(candidate, scratch) {
    const root = join(scratch, 'repo')
    initRepo(root)
    put(root, '.true-up.json', composedRoot(['config/bad-seed.json']))
    put(root, 'config/bad-seed.json', {
      zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] }],
      seed: [{ from: 'README.md', to: 'missing.json', kind: 'derives-facts-from' }],
    })
    put(root, 'README.md', '# docs\n')
    put(root, '.true-up/depgraph.json', 'PRIOR-GRAPH-SENTINEL\n')
    git(root, ['add', '-A'])
    const before = readFileSync(join(root, '.true-up/depgraph.json'))
    const result = runCli(candidate, root, ['build', '--json'])
    assert.equal(result.status, 1, `bad seed build exited ${result.status}: ${result.stdout}\n${result.stderr}`)
    assert.deepEqual(readFileSync(join(root, '.true-up/depgraph.json')), before, 'MUTATION_ORACLE invalid graph replaced prior cache before validation')
    assert.deepEqual(readdirSync(join(root, '.true-up')).sort(), ['depgraph.json'], 'MUTATION_ORACLE invalid graph left temporary write residue')
  },
}

if (process.argv[2] === '--oracle') {
  const [, , , name, candidate, scratch] = process.argv
  assert(oracle[name], `unknown mutation oracle: ${name}`)
  mkdirSync(scratch, { recursive: true })
  try {
    await oracle[name](resolve(candidate), resolve(scratch))
    process.stdout.write(`oracle-pass ${name}\n`)
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exitCode = 1
  }
} else {
  const scratchBase = resolve(process.env.TRUE_UP_CONFIG_MUTATION_SCRATCH
    || join(homedir(), 'scratch', 'true-up-config-composition', 'wave3', 'mutations'))
  mkdirSync(scratchBase, { recursive: true })
  const runRoot = mkdtempSync(join(scratchBase, 'run-'))
  const evidenceDir = resolve(process.argv[2] || runRoot)
  mkdirSync(evidenceDir, { recursive: true })

  const sourceFiles = ['bin/true-up', 'lib/config.mjs', 'lib/engine.mjs', 'lib/symbols.mjs', 'package.json']
  const productionBefore = Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(join(REPO, path)))]))

  const copyCandidate = (target) => {
    for (const path of sourceFiles) {
      const destination = join(target, path)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(REPO, path), destination)
    }
    chmodSync(join(target, 'bin/true-up'), 0o755)
  }

  const exact = (files, path, before, after) => {
    const count = files[path].split(before).length - 1
    assert.equal(count, 1, `mutation site drift for ${path}: expected one exact occurrence, found ${count}\n${before}`)
    files[path] = files[path].replace(before, after)
  }

  const mutations = [
    {
      id: 'root-only-loading', site: 'lib/config.mjs: canonical fragment list', expect: 'MUTATION_ORACLE root-only loading omitted child declarations',
      mutate(files) { exact(files, 'lib/config.mjs', 'const fragments = utf8SortStrings(normalized.map((item) => item.path))', 'const fragments = []') },
    },
    {
      id: 'first-last-writer-wins', site: 'lib/config.mjs: ownership conflict gate', expect: 'MUTATION_ORACLE first/last-writer merge accepted competing owners',
      mutate(files) { exact(files, 'lib/config.mjs', 'if (conflicts.length) {', 'if (false && conflicts.length) {') },
    },
    {
      id: 'include-order-dependence', site: 'lib/config.mjs: UTF-8 fragment sort', expect: 'MUTATION_ORACLE manifest include order changed canonical fragment order',
      mutate(files) { exact(files, 'lib/config.mjs', 'const fragments = utf8SortStrings(normalized.map((item) => item.path))', 'const fragments = normalized.map((item) => item.path)') },
    },
    {
      id: 'wrong-semantic-path-base', site: 'lib/config.mjs: seed declaration normalization', expect: 'MUTATION_ORACLE declaration path was rebased to fragment directory',
      mutate(files) {
        exact(files, 'lib/config.mjs',
          'const from = normalizeDeclarationPath(edge.from, source, `${base}/from`, { includeChain })',
          'const from = normalizeDeclarationPath(posix.join(posix.dirname(source), edge.from), source, `${base}/from`, { includeChain })')
      },
    },
    {
      id: 'duplicate-concatenation', site: 'lib/config.mjs: cross-source seed owner identity', expect: 'MUTATION_ORACLE duplicate declarations were concatenated across sources',
      mutate(files) {
        exact(files, 'lib/config.mjs',
          'noteOwner(`seed:${JSON.stringify([edge.from, edge.to])}`, origin, { identity: `seed:${edge.from}\\0${edge.to}` })',
          'noteOwner(`seed:${source}:${JSON.stringify([edge.from, edge.to])}`, origin, { identity: `seed:${edge.from}\\0${edge.to}` })')
      },
    },
    {
      id: 'duplicate-key-acceptance', site: 'lib/config.mjs: strict JSON duplicate scanner', expect: 'MUTATION_ORACLE duplicate JSON key was accepted with last-wins parsing',
      mutate(files) { exact(files, 'lib/config.mjs', '  assertNoDuplicateKeys(text, source, includeChain, tick)\n', '') },
    },
    {
      id: 'absent-vs-false-collapse', site: 'lib/config.mjs: semantic projection scalar presence', expect: 'MUTATION_ORACLE explicit empty string collapsed into absence',
      mutate(files) {
        exact(files, 'lib/config.mjs',
          '  for (const scalar of ROOT_SCALARS) if (own(config, scalar)) projection[scalar] = config[scalar]',
          '  for (const scalar of ROOT_SCALARS) if (config[scalar]) projection[scalar] = config[scalar]')
      },
    },
    {
      id: 'collision-rescue-by-later-declaration', site: 'lib/config.mjs: complete owner-origin accumulation', expect: 'MUTATION_ORACLE later declaration rescued a prior ownership collision',
      mutate(files) { exact(files, 'lib/config.mjs', '    state.origins.push(origin)', '    state.origins = [origin]') },
    },
    {
      id: 'import-export-alias-bypass', site: 'lib/engine.mjs: import namespace alias validation', expect: 'MUTATION_ORACLE import/export alias bypass accepted traversal alias',
      mutate(files) {
        exact(files, 'lib/engine.mjs',
          "  return IMPORT_ALIAS_RE.test(alias) && !alias.includes('..') && !RESERVED_IMPORT_ALIASES.has(alias)",
          '  return true')
      },
    },
    {
      id: 'lexical-only-path-containment', site: 'lib/config.mjs: descriptor-backed canonical containment', expect: 'MUTATION_ORACLE lexical-only containment followed an ancestor symlink outside the repo',
      mutate(files) {
        const path = 'lib/config.mjs'
        const start = files[path].indexOf('  const inspectInclude = (repoPath, maxBytes) => {')
        const end = files[path].indexOf('\n\n  const inspectAndRead = ', start)
        assert(start >= 0 && end > start, 'lexical containment mutation site drift')
        const replacement = `  const inspectInclude = (repoPath, maxBytes) => {\n    if (ignored(repoPath)) return includeResult(repoPath, { kind: 'regular', ignored: true })\n    const candidate = resolve(rootAbs, repoPath)\n    if (!inside(rootAbs, candidate)) return includeResult(repoPath, { kind: 'outside' })\n    let fd = null\n    try {\n      const stat = lstatSync(candidate)\n      if (!stat.isFile()) return includeResult(repoPath, { kind: 'not-regular' })\n      fd = openSync(candidate, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0))\n      const bytes = readAtMost(fd, maxBytes)\n      return includeResult(repoPath, { kind: 'regular', bytes, size: bytes.length, realInside: true })\n    } catch {\n      return includeResult(repoPath, { kind: 'missing' })\n    } finally {\n      if (fd !== null) try { closeSync(fd) } catch {}\n    }\n  }`
        files[path] = files[path].slice(0, start) + replacement + files[path].slice(end)
      },
    },
    {
      id: 'eager-config-independent-traversal', site: 'lib/engine.mjs: config-independent early-exit boundary', expect: 'MUTATION_ORACLE eager fragment traversal stole help precedence',
      mutate(files) {
        exact(files, 'lib/engine.mjs',
          "if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { writeStdout(HELP); process.exit(0) }",
          "ensureConfigLoaded()\nif (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { writeStdout(HELP); process.exit(0) }")
      },
    },
    {
      id: 'staged-root-only-freshness', site: 'lib/engine.mjs: committed source revalidation', expect: 'MUTATION_ORACLE staged-root-only freshness falsely passed an unstaged child',
      mutate(files) {
        exact(files, 'lib/engine.mjs',
          '  return configSources({ tracking: true })\n    .filter((source) => source.state !== \'tracked\' && source.state !== \'staged\')',
          '  return configSources({ tracking: true })\n    .filter((source) => source.role === \'entry\')\n    .filter((source) => source.state !== \'tracked\' && source.state !== \'staged\')')
        exact(files, 'lib/engine.mjs',
          '  const before = new Map(CONFIG_BUNDLE.sources.map((source) => [source.path, source.hash]))',
          "  const before = new Map(CONFIG_BUNDLE.sources.filter((source) => source.role === 'entry').map((source) => [source.path, source.hash]))")
        exact(files, 'lib/engine.mjs', '  for (const source of after.sources) {', "  for (const source of after.sources.filter((source) => source.role === 'entry')) {")
      },
    },
    {
      id: 'equal-specificity-zone-last-wins', site: 'lib/engine.mjs: zone score tie-break', expect: 'MUTATION_ORACLE equal-specificity last-wins changed frozen first-wins zone semantics',
      mutate(files) { exact(files, 'lib/engine.mjs', 'if (s > bestS) { bestS = s; best = z }', 'if (s >= bestS) { bestS = s; best = z }') },
    },
    {
      id: 'swallowed-invalid-child-provenance', site: 'lib/engine.mjs: ConfigLoadError translation', expect: 'MUTATION_ORACLE invalid child source provenance was swallowed',
      mutate(files) {
        exact(files, 'lib/engine.mjs',
          '    const failure = error instanceof ConfigLoadError\n      ? error\n      : new ConfigLoadError(\'config-load-failed\', { source: \'.true-up.json\', includeChain: [\'.true-up.json\'] })',
          "    const failure = new ConfigLoadError('config-load-failed', { source: '.true-up.json', includeChain: ['.true-up.json'] })")
      },
    },
    {
      id: 'duplicate-generator-execution', site: 'lib/engine.mjs: run generator-via deduplication', expect: 'MUTATION_ORACLE shared generator executed more than once',
      mutate(files) { exact(files, 'lib/engine.mjs', 'const gens = [...new Set(mech.map((h) => h.via).filter(Boolean))]', 'const gens = mech.map((h) => h.via).filter(Boolean)') },
    },
    {
      id: 'provenance-leak-loss', site: 'lib/engine.mjs: composed seed declaredIn edge field', expect: 'MUTATION_ORACLE composed edge provenance was lost or leaked',
      mutate(files) {
        exact(files, 'lib/engine.mjs',
          "const declaredIn = CONFIG_BUNDLE?.mode === 'composed' ? CONFIG_BUNDLE.provenance.seed[seedIndex] : null",
          'const declaredIn = null')
      },
    },
    {
      id: 'partial-graph-write-before-validation', site: 'lib/engine.mjs: build validation/write ordering', expect: 'MUTATION_ORACLE invalid graph replaced prior cache before validation',
      mutate(files) {
        exact(files, 'lib/engine.mjs',
          'const graph = build()\nfailGraphBuildIfNeeded(graph)\n\nif (argv[0] === \'--check\')',
          'const graph = build()\nif (!NOWRITE) writeFileAtomic(OUT, serialize(graph))\nfailGraphBuildIfNeeded(graph)\n\nif (argv[0] === \'--check\')')
      },
    },
  ]

  const rows = []
  for (const mutation of mutations) {
    const base = join(runRoot, mutation.id)
    const greenCandidate = join(base, 'green-candidate')
    const redCandidate = join(base, 'red-candidate')
    copyCandidate(greenCandidate)
    copyCandidate(redCandidate)

    const files = Object.fromEntries(sourceFiles.map((path) => [path, readFileSync(join(redCandidate, path), 'utf8')]))
    mutation.mutate(files)
    for (const path of sourceFiles) writeFileSync(join(redCandidate, path), files[path])
    chmodSync(join(redCandidate, 'bin/true-up'), 0o755)

    const runOne = (color, candidate) => {
      const fixture = join(evidenceDir, 'fixtures', mutation.id, color)
      rmSync(fixture, { recursive: true, force: true })
      mkdirSync(fixture, { recursive: true })
      const result = spawnSync(process.execPath, [SELF, '--oracle', mutation.id, candidate, fixture], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      })
      const log = `exit=${result.status}\nsignal=${result.signal || ''}\n--- stdout ---\n${result.stdout || ''}\n--- stderr ---\n${result.stderr || ''}`
      const logPath = join(evidenceDir, `${mutation.id}.${color}.log`)
      writeFileSync(logPath, log)
      return { result, log, logPath, sha256: sha256(log) }
    }

    const red = runOne('red', redCandidate)
    const green = runOne('green', greenCandidate)
    assert.notEqual(red.result.status, 0, `${mutation.id}: mutant survived\n${red.log}`)
    assert.match(red.log, new RegExp(mutation.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${mutation.id}: mutant died outside its named oracle\n${red.log}`)
    assert.equal(green.result.status, 0, `${mutation.id}: unmodified checkout failed oracle\n${green.log}`)
    assert.match(green.log, new RegExp(`oracle-pass ${mutation.id}`), `${mutation.id}: green oracle did not report completion`)

    rows.push({
      id: mutation.id,
      site: mutation.site,
      oracle: mutation.id,
      status: 'killed',
      red: { exit: red.result.status, log: relative(evidenceDir, red.logPath), sha256: red.sha256 },
      revertedGreen: { exit: green.result.status, log: relative(evidenceDir, green.logPath), sha256: green.sha256 },
    })
    rmSync(base, { recursive: true, force: true })
    process.stdout.write(`ok ${rows.length} - ${mutation.id}\n`)
  }

  const productionAfter = Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(join(REPO, path)))]))
  assert.deepEqual(productionAfter, productionBefore, 'production checkout changed during disposable mutation analysis')
  const report = {
    ok: true,
    schemaVersion: 1,
    mutants: rows.length,
    killed: rows.filter((row) => row.status === 'killed').length,
    killRate: rows.filter((row) => row.status === 'killed').length / rows.length,
    productionBefore,
    productionAfter,
    rows,
  }
  const reportPath = join(evidenceDir, 'mutation-report.json')
  writeFileSync(reportPath, jsonText(report))
  const reportSha256 = sha256(readFileSync(reportPath))
  writeFileSync(join(evidenceDir, 'SHA256SUMS'), `${reportSha256}  mutation-report.json\n`)
  process.stdout.write(`config composition mutations: ${report.killed}/${report.mutants} killed; report=${reportPath}; sha256=${reportSha256}\n`)
}
