#!/usr/bin/env node
// T80 — direct production-loader contract for native deterministic config composition.
// This is deliberately separate from the CLI harness: Wave 1 proves the loader and its safety
// boundary before Wave 2 exposes composed config to CONFIG/OUT/FACTS/SYMBOLS or any command.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIG_COMPOSITION_ERROR_CODES,
  COMPOSITION_LIMITS,
  ConfigLoadError,
  createNodeConfigProvider,
  loadConfigBundle,
  semanticProjection,
} from '../lib/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const scratchBase = process.env.TRUE_UP_CONFIG_TEST_SCRATCH || join(homedir(), 'scratch', 'true-up-config-loader-tests')
mkdirSync(scratchBase, { recursive: true })
const runRoot = mkdtempSync(join(scratchBase, 'run-'))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const stableErrorCodes = [
  'composition-root-not-regular',
  'composition-root-realpath-escape',
  'composition-root-symlink',
  'composition-sentinel-invalid',
  'cross-source-conflict',
  'duplicate-json-key',
  'fragment-invalid-json',
  'fragment-invalid-utf8',
  'include-bytes-limit',
  'include-count-limit',
  'include-forbidden-location',
  'include-ignored',
  'include-missing',
  'include-not-regular',
  'include-path-absolute',
  'include-path-backslash',
  'include-path-duplicate',
  'include-path-empty',
  'include-path-escape',
  'include-path-invalid-unicode',
  'include-path-nul',
  'include-realpath-escape',
  'include-root',
  'include-symlink',
  'invalid-source-shape',
  'nested-include',
  'root-invalid-json',
  'root-invalid-utf8',
  'root-only-key',
  'unknown-key',
]
const observedErrorCodes = new Set()

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const repo = (name) => {
  const path = join(runRoot, name)
  mkdirSync(path, { recursive: true })
  return path
}
const put = (root, path, value) => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n')
}
const providerFor = (root, options = {}) => {
  const { isIgnored, ...rest } = options
  return createNodeConfigProvider({ repoRoot: root, isIgnored: isIgnored ?? (() => false), ...rest })
}
const load = (root, options = {}) => loadConfigBundle({
  repoRoot: root,
  provider: options.provider || providerFor(root, options.providerOptions),
  limits: options.limits,
  tick: options.tick,
})
const composedRoot = (include, extra = {}) => ({ compositionVersion: 1, include, zones: null, ...extra })
const jsonBytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
const virtualProvider = ({
  entryPath = '.true-up.json',
  entry = { kind: 'regular', bytes: jsonBytes(composedRoot(['child.json'])), realInside: true },
  fragments = {},
  events = [],
} = {}) => {
  const calls = new Map()
  const materialize = (path, record) => {
    const value = typeof record === 'function' ? record(path) : record
    if (!value) return { path, kind: 'missing' }
    const bytes = value.bytes === undefined && value.value !== undefined ? jsonBytes(value.value) : value.bytes
    return { path, tracking: 'tracked', realInside: true, ...value, ...(bytes === undefined ? {} : { bytes }) }
  }
  return {
    events,
    selectEntry(names) {
      events.push({ op: 'selectEntry', names: [...names] })
      return entry === null ? null : materialize(entryPath, entry)
    },
    inspectAndRead(path, options) {
      const count = (calls.get(path) || 0) + 1
      calls.set(path, count)
      events.push({ op: 'inspectAndRead', path, options: { ...options }, count })
      assert.equal(count, 1, `${path} was inspected more than once`)
      return materialize(path, fragments[path])
    },
  }
}
const expectCode = (code, fn, check) => {
  let thrown = null
  try { fn() } catch (error) { thrown = error }
  assert(thrown, `expected ${code} to throw`)
  assert(thrown instanceof ConfigLoadError, `expected ConfigLoadError, got ${thrown?.constructor?.name}`)
  assert.equal(thrown.code, code)
  assert.equal(thrown.name, 'ConfigLoadError')
  observedErrorCodes.add(code)
  assert.equal(thrown.trueUpKind, 'invalid-config')
  const publicForms = [String(thrown), thrown.message, thrown.stack, JSON.stringify(thrown)]
  for (const form of publicForms) assert(!String(form).includes(runRoot), 'composition error leaked an absolute scratch path')
  assert.deepEqual(
    Object.keys(thrown).sort(),
    Object.keys(thrown).filter((key) => ['code', 'conflicts', 'includeChain', 'location', 'name', 'origins', 'pointer', 'source', 'trueUpKind'].includes(key)).sort(),
    'ConfigLoadError exposed an unapproved public detail field',
  )
  if (check) check(thrown)
  return thrown
}
const snapshot = (root) => {
  const paths = []
  const walk = (relative = '') => {
    const dir = join(root, relative)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      paths.push(path)
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path)
    }
  }
  walk()
  return Object.fromEntries(paths.sort().map((path) => {
    const abs = join(root, path)
    const stat = lstatSync(abs)
    if (!stat.isFile()) return [path, { kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other', ino: stat.ino, mtimeMs: stat.mtimeMs }]
    const bytes = readFileSync(abs)
    return [path, { kind: 'file', bytes: bytes.length, hash: sha256(bytes), ino: stat.ino, mtimeMs: stat.mtimeMs }]
  }))
}

if (process.argv[2] === '--loader-child') {
  const root = process.argv[3]
  const expected = process.argv[4]
  try { load(root); process.stdout.write('unexpected-success\n'); process.exit(1) }
  catch (error) {
    if (error instanceof ConfigLoadError && error.code === expected) { process.stdout.write(`${error.code}\n`); process.exit(0) }
    throw error
  }
}

test('legacy: absent config returns empty legacy config', () => {
  const root = repo('legacy-absent')
  const bundle = load(root)
  assert.equal(bundle.mode, 'legacy')
  assert.equal(bundle.entry, null)
  assert.deepEqual(bundle.config, {})
})

test('contract: production composition limits are literal safety constants', () => {
  assert.deepEqual(COMPOSITION_LIMITS, { maxIncludes: 256, maxIncludedBytes: 32 * 1024 * 1024 })
  assert.equal(COMPOSITION_LIMITS.maxIncludes, 256)
  assert.equal(COMPOSITION_LIMITS.maxIncludedBytes, 33_554_432)
})

test('legacy: entry precedence and JSON.parse last-wins duplicates remain unchanged', () => {
  const root = repo('legacy-precedence')
  put(root, 'true-up.config.json', { out: 'fallback.json' })
  put(root, '.true-up.json', '{"unknown":1,"unknown":2,"symbols":false}\n')
  const bundle = load(root)
  assert.equal(bundle.mode, 'legacy')
  assert.equal(bundle.entry.path, '.true-up.json')
  assert.deepEqual(bundle.config, { unknown: 2, symbols: false })
})

test('legacy: last-wins mode probe does not activate on an overwritten zones null', () => {
  const root = repo('legacy-zones-last-wins')
  put(root, '.true-up.json', '{"zones":null,"zones":[],"unknown":1}\n')
  const bundle = load(root)
  assert.equal(bundle.mode, 'legacy')
  assert.deepEqual(bundle.config, { zones: [], unknown: 1 })
})

test('provider boundary: root resource and realpath failures are stable and entry-only', () => {
  const cases = [
    [
      'composition-root-not-regular',
      { kind: 'not-regular', realInside: true },
    ],
    [
      'composition-root-realpath-escape',
      { kind: 'regular', bytes: jsonBytes(composedRoot(['child.json'])), realInside: false },
    ],
    [
      'composition-root-symlink',
      { kind: 'symlink', bytes: jsonBytes(composedRoot(['child.json'])), realInside: true },
    ],
  ]
  cases.forEach(([code, entry], index) => {
    const events = []
    const provider = virtualProvider({ entry, events })
    expectCode(code, () => load(repo(`virtual-root-${index}`), { provider }), (error) => {
      assert.equal(error.source, '.true-up.json')
      assert.deepEqual(error.includeChain, ['.true-up.json'])
    })
    assert.deepEqual(events, [{ op: 'selectEntry', names: ['.true-up.json', 'true-up.config.json'] }])
  })
})

test('JSON: malformed root and fragment JSON have distinct detail codes and public locations', () => {
  const root = repo('malformed-root-json')
  put(root, '.true-up.json', '{"compositionVersion":1,')
  expectCode('root-invalid-json', () => load(root), (error) => {
    assert.equal(error.source, '.true-up.json')
    assert.deepEqual(error.includeChain, ['.true-up.json'])
    assert(error.location && Object.keys(error.location).length > 0)
  })

  const fragment = repo('malformed-fragment-json')
  put(fragment, '.true-up.json', composedRoot(['child.json']))
  put(fragment, 'child.json', '{"facts":!}')
  expectCode('fragment-invalid-json', () => load(fragment), (error) => {
    assert.equal(error.source, 'child.json')
    assert.deepEqual(error.includeChain, ['.true-up.json', 'child.json'])
    assert.equal(error.pointer, undefined)
  })
})

test('activation: any partial or malformed composition sentinel fails before child reads', () => {
  const cases = [
    [{ compositionVersion: 1 }, '/include'],
    [{ include: ['child.json'] }, '/compositionVersion'],
    [{ zones: null }, '/compositionVersion'],
    [{ compositionVersion: 1, include: ['child.json'], zones: [] }, '/zones'],
    [{ compositionVersion: 2, include: ['child.json'], zones: null }, '/compositionVersion'],
    [{ compositionVersion: 1, include: [], zones: null }, '/include'],
    [{ compositionVersion: 1, include: [1], zones: null }, '/include/0'],
  ]
  cases.forEach(([config, expectedPointer], index) => {
    const root = repo(`activation-${index}`)
    put(root, '.true-up.json', config)
    const reads = []
    expectCode('composition-sentinel-invalid', () => load(root, { providerOptions: { onRead: (path) => reads.push(path) } }), (error) => {
      assert.equal(error.pointer, expectedPointer)
    })
    assert.deepEqual(reads, ['.true-up.json'])
  })
})

test('composition: deterministic merge, root declarations, provenance, and source-local duplicates', () => {
  const root = repo('basic-merge')
  put(root, '.true-up.json', composedRoot(['z.json', './a/../a.json'], {
    _comment: 'inert root metadata',
    out: '.true-up/custom.json',
    symbols: false,
    facts: { 'root.json': [['items', 'id']] },
    seed: [{ from: 'root.md', to: 'root.json' }],
  }))
  put(root, 'a.json', {
    _owner: 'a',
    zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'default', rules: [] }],
    seed: [
      { from: 'a.md', to: 'a.json', kind: 'depends-on' },
      { from: 'a.md', to: 'a.json', kind: 'depends-on' },
    ],
  })
  put(root, 'z.json', {
    facts: { 'z.json': [['items', 'id'], ['items', 'id']] },
    imports: { dep: { path: 'imports/dep.json', repoId: 'dep', audience: 'public' } },
    exports: [{ id: 'z.fact', from: 'z.json#items.z', audience: 'public' }],
  })
  const reads = []
  const ticks = []
  const bundle = load(root, { providerOptions: { onRead: (path) => reads.push(path), trackingState: () => 'tracked' }, tick: (where) => ticks.push(where) })
  assert.equal(bundle.mode, 'composed')
  assert.deepEqual(bundle.config.include, ['a.json', 'z.json'])
  assert.equal(bundle.config.compositionVersion, 1)
  assert(!('_comment' in bundle.config))
  assert.deepEqual(Object.keys(bundle.config.facts), ['root.json', 'z.json'])
  assert.equal(bundle.config.seed.length, 3)
  assert.deepEqual(bundle.config.seed, [
    { from: 'root.md', to: 'root.json' },
    { from: 'a.md', to: 'a.json', kind: 'depends-on' },
    { from: 'a.md', to: 'a.json', kind: 'depends-on' },
  ])
  assert.deepEqual(bundle.composition.fragments, ['a.json', 'z.json'])
  assert.deepEqual(bundle.sources.map((source) => source.path), ['.true-up.json', 'a.json', 'z.json'])
  assert.deepEqual(reads, ['.true-up.json', 'a.json', 'z.json'])
  assert.deepEqual(ticks, [
    'composition root parsed',
    'composition fragment a.json',
    'composition fragment z.json',
    'composition merge',
  ])
  assert.deepEqual(bundle.provenance.facts['root.json'], { source: '.true-up.json', pointer: '/facts/root.json' })
  assert.deepEqual(bundle.provenance.seed[0], { source: '.true-up.json', pointer: '/seed/0' })
  assert.deepEqual(bundle.provenance.seed[1], { source: 'a.json', pointer: '/seed/0' })
  assert.deepEqual(bundle.provenance.imports.dep, { source: 'z.json', pointer: '/imports/dep' })
  assert.deepEqual(bundle.provenance.exports[0], { source: 'z.json', pointer: '/exports/0' })
})

test('composition: exact normalized semantic bytes are a hard-coded full-schema golden', () => {
  const root = repo('semantic-golden')
  put(root, '.true-up.json', composedRoot(['z.json', 'a.json'], {
    $schema: 'schema://one',
    deadlineMs: 0,
    facts: { 'z.json': [['rows', 'key'], ['rows', 'key']] },
    imports: { rootDep: { path: 'imports/root.json', repoId: 'root', audience: 'internal' } },
    out: '',
    repoId: '',
    seed: [{ from: 'root', to: 'target' }],
    strictSpans: false,
    symbols: false,
    exports: [{ id: 'root.export', from: 'z.json#rows.one', audience: 'public' }],
  }))
  put(root, 'a.json', {
    facts: { 'a.json': [['items', 'id']] },
    zones: [
      { path: 'docs/', intent: 'first' },
      { path: 'docs/', intent: 'second' },
    ],
    seed: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'b', kind: 'derives-facts-from', via: 'generate.mjs' },
    ],
    imports: { dep: { path: 'imports/dep.json', repoId: 'dep', audience: 'public' } },
    exports: [
      { id: 'a.export', from: 'a.json#items.a', audience: 'public', declassify: false },
      { id: 'a.export', from: 'a.json#items.a', audience: 'public', declassify: false },
    ],
  })
  put(root, 'z.json', {
    zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'default', rules: ['one', 'two'] }],
    seed: [{ from: 'c', to: 'd', kind: 'tests' }],
  })

  const expectedBytes = '{"$schema":"schema://one","deadlineMs":0,"exports":[{"audience":"public","declassify":false,"from":"a.json#items.a","id":"a.export"},{"audience":"public","declassify":false,"from":"a.json#items.a","id":"a.export"},{"audience":"public","from":"z.json#rows.one","id":"root.export"}],"facts":{"a.json":[["items","id"]],"z.json":[["rows","key"],["rows","key"]]},"imports":{"dep":{"audience":"public","path":"imports/dep.json","repoId":"dep"},"rootDep":{"audience":"internal","path":"imports/root.json","repoId":"root"}},"out":"","repoId":"","seed":[{"from":"a","kind":"derives-facts-from","to":"b"},{"from":"a","kind":"derives-facts-from","to":"b","via":"generate.mjs"},{"from":"c","kind":"tests","to":"d"},{"from":"root","kind":"derives-facts-from","to":"target"}],"strictSpans":false,"symbols":false,"zones":[{"audience":"world","intent":"default","path":"","rules":["one","two"],"visibility":"public"},{"intent":"first","path":"docs/"},{"intent":"second","path":"docs/"}]}\n'
  const bundle = load(root)
  assert.deepEqual(bundle.effective, { out: '', symbols: false, strictSpans: false, deadlineMs: 0 })
  assert.equal(bundle.normalizedConfigBytes, expectedBytes)
  assert.deepEqual(semanticProjection(bundle.config), JSON.parse(expectedBytes))
  assert(!bundle.normalizedConfigBytes.includes('compositionVersion'))
  assert(!bundle.normalizedConfigBytes.includes('include'))

  const changed = JSON.parse(JSON.stringify(bundle.config))
  changed.seed[1].via = 'different-generator.mjs'
  assert.notEqual(JSON.stringify(semanticProjection(changed)) + '\n', expectedBytes, 'declaration mutation did not change semantic bytes')
})

test('composition: normalized bytes exactly emulate JSON.stringify of the deep-sorted projection for integer-like keys', () => {
  const root = repo('numeric-projection-keys')
  put(root, '.true-up.json', composedRoot(['child.json']))
  put(root, 'child.json', {
    facts: { 10: [['rows', 'id']], 2: [['items', 'id']] },
    imports: { 10: { path: 'imports/ten.json' }, 2: { path: 'imports/two.json' } },
  })
  const bundle = load(root)
  const expected = '{"facts":{"2":[["items","id"]],"10":[["rows","id"]]},"imports":{"2":{"path":"imports/two.json"},"10":{"path":"imports/ten.json"}}}\n'
  assert.equal(JSON.stringify(semanticProjection(bundle.config)) + '\n', expected)
  assert.equal(bundle.normalizedConfigBytes, expected)
})

test('composition: include manifest order does not affect config, provenance, or normalized bytes', () => {
  const make = (name, include) => {
    const root = repo(name)
    put(root, '.true-up.json', composedRoot(include))
    put(root, 'a.json', { seed: [{ from: 'a.md', to: 'a.json' }] })
    put(root, 'z.json', { seed: [{ from: 'z.md', to: 'z.json' }] })
    return load(root)
  }
  const a = make('order-a', ['z.json', 'a.json'])
  const b = make('order-b', ['a.json', 'z.json'])
  assert.deepEqual(a.config, b.config)
  assert.deepEqual(a.provenance, b.provenance)
  assert.equal(a.normalizedConfigBytes, b.normalizedConfigBytes)
})

test('composition: each declaration path class uses its frozen normalization mode', () => {
  const root = repo('declaration-path-normalization')
  put(root, '.true-up.json', composedRoot(['child.json']))
  put(root, 'child.json', {
    facts: { 'data#x/../y.json': [['items', 'id']] },
    zones: [{ path: 'docs/#x/../**' }],
    seed: [{ from: 'src/a#x/../from.md', to: 'out/a/../b.json#fact/x/../z', kind: '' , via: 'gen/a#x/../tool.mjs' }],
    imports: { dep: { path: 'imports/a#x/../snap.json' } },
    exports: [{ id: 'x', from: 'out/a/../b.json#fact/x/../z' }],
  })
  const bundle = load(root)
  assert.deepEqual(bundle.config.facts, { 'y.json': [['items', 'id']] })
  assert.equal(bundle.config.zones[0].path, 'docs/**')
  assert.deepEqual(bundle.config.seed[0], {
    from: 'src/from.md',
    to: 'out/b.json#fact/x/../z',
    kind: '',
    via: 'gen/tool.mjs',
  })
  assert.equal(bundle.config.imports.dep.path, 'imports/snap.json')
  assert.equal(bundle.config.exports[0].from, 'out/b.json#fact/x/../z')
  assert.equal(semanticProjection(bundle.config).seed[0].kind, '', 'an explicit empty kind is not an absent kind')
})

test('JSON: composed root and fragment reject decoded duplicate keys with every location', () => {
  const root = repo('duplicate-root')
  put(root, 'child.json', {})
  put(root, '.true-up.json', '{"compositionVersion":1,"include":["child.json"],"zones":null,"facts":{},"f\\u0061cts":{},"facts":{}}')
  expectCode('duplicate-json-key', () => load(root), (error) => {
    assert.equal(error.source, '.true-up.json')
    assert.equal(error.pointer, '/facts')
    assert.equal(error.origins.length, 3)
    assert(error.origins.every((origin) => origin.line === 1 && origin.column > 0))
    assert.deepEqual(error.origins.map((origin) => origin.column), [...error.origins.map((origin) => origin.column)].sort((a, b) => a - b))
  })

  const childRoot = repo('duplicate-child')
  put(childRoot, '.true-up.json', composedRoot(['child.json']))
  put(childRoot, 'child.json', '{"imports":{"a/~b":{"path":"one"},"a\\u002f~b":{"path":"two"}}}')
  expectCode('duplicate-json-key', () => load(childRoot), (error) => {
    assert.equal(error.source, 'child.json')
    assert.equal(error.pointer, '/imports/a~1~0b')
    assert.deepEqual(error.includeChain, ['.true-up.json', 'child.json'])
  })

  const multilineRoot = repo('duplicate-multiline-locations')
  put(multilineRoot, 'child.json', {})
  put(multilineRoot, '.true-up.json', [
    '{',
    '  "compositionVersion": 1,',
    '  "include": ["child.json"],',
    '  "zones": null,',
    '  "_nested": {',
    '    "du\\u0070": "a long escaped \\u0061 value that must not be decoded by the key scanner",',
    '    "dup": "second"',
    '  }',
    '}',
  ].join('\n'))
  expectCode('duplicate-json-key', () => load(multilineRoot), (error) => {
    assert.equal(error.pointer, '/_nested/dup')
    assert.deepEqual(error.origins, [
      { source: '.true-up.json', pointer: '/_nested/dup', line: 6, column: 5 },
      { source: '.true-up.json', pointer: '/_nested/dup', line: 7, column: 5 },
    ])
  })

  const siblingRoot = repo('duplicate-sibling-scope')
  put(siblingRoot, 'child.json', {})
  put(siblingRoot, '.true-up.json', composedRoot(['child.json'], {
    _siblings: { left: { same: 'one' }, right: { same: 'two' } },
  }))
  assert.equal(load(siblingRoot).mode, 'composed', 'equal keys in different object scopes are not duplicates')
})

test('JSON: wide duplicate scan cooperatively ticks instead of becoming an uninterruptible diagnostic pass', () => {
  const root = repo('duplicate-wide-tick')
  const fields = Array.from({ length: 5000 }, (_, index) => `"k${index}":${index}`).join(',')
  put(root, '.true-up.json', `{"compositionVersion":1,"include":["child.json"],"zones":null,"_wide":{${fields}}}`)
  put(root, 'child.json', {})
  const sentinel = new Error('scanner-tick-observed')
  assert.throws(
    () => load(root, { tick: (where) => { if (where.includes('duplicate-key scan')) throw sentinel } }),
    (error) => error === sentinel,
    'wide duplicate-key scan never reached the cooperative tick callback',
  )
})

test('JSON: duplicate scanning decodes escaped keys without reparsing already-valid string values', () => {
  const root = repo('duplicate-scan-parse-budget')
  put(root, '.true-up.json', '{"compositionVersion":1,"include":["child.json"],"zones":null,"_escaped":{"k\\u0065y":"v\\u0061lue"}}')
  put(root, 'child.json', { seed: [{ from: 'docs/a.md', to: 'src/a.mjs' }] })

  const originalParse = JSON.parse
  let parseCalls = 0
  JSON.parse = (...args) => {
    parseCalls++
    return originalParse(...args)
  }
  try {
    assert.equal(load(root).mode, 'composed')
  } finally {
    JSON.parse = originalParse
  }

  // Root mode probe + strict root parse + strict fragment parse + one escaped object-key decode.
  assert.equal(parseCalls, 4, 'duplicate scanner reparsed string values or ordinary object keys')
})

test('provenance: RFC 6901 pointers escape slash and tilde without raw values or absolute paths', () => {
  const root = repo('escaped-provenance')
  put(root, '.true-up.json', composedRoot(['child.json']))
  put(root, 'child.json', {
    facts: { 'a/~b.json': [['items', 'id']] },
    imports: { 'dep/~one': { path: 'private-value-must-not-enter-provenance.json' } },
  })
  const bundle = load(root)
  assert.deepEqual(bundle.provenance.facts['a/~b.json'], { source: 'child.json', pointer: '/facts/a~1~0b.json' })
  assert.deepEqual(bundle.provenance.imports['dep/~one'], { source: 'child.json', pointer: '/imports/dep~1~0one' })
  const publicProvenance = JSON.stringify(bundle.provenance)
  assert(!publicProvenance.includes(runRoot))
  assert(!publicProvenance.includes('private-value-must-not-enter-provenance'))
})

test('JSON: strict UTF-8 applies only to composed mode', () => {
  const legacy = repo('legacy-invalid-utf8')
  put(legacy, '.true-up.json', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
  assert.equal(load(legacy).config.x, '\ufffd')

  const root = repo('composed-invalid-utf8-root')
  put(root, 'child.json', {})
  put(root, '.true-up.json', Buffer.concat([
    Buffer.from('{"compositionVersion":1,"include":["child.json"],"zones":null,"_x":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]))
  expectCode('root-invalid-utf8', () => load(root))

  const fragment = repo('composed-invalid-utf8-fragment')
  put(fragment, '.true-up.json', composedRoot(['child.json']))
  put(fragment, 'child.json', Buffer.from([0x7b, 0x22, 0x5f, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
  expectCode('fragment-invalid-utf8', () => load(fragment))
})

test('schema: every root-only key and fragment declaration shape fails with an exact pointer', () => {
  const rootOnly = [
    ['out', 'x'],
    ['symbols', false],
    ['strictSpans', false],
    ['deadlineMs', 0],
    ['repoId', 'repo'],
    ['$schema', 'schema'],
  ].map(([key, value]) => ['root-only-key', { [key]: value }, `/${key}`])
  const cases = [
    ...rootOnly,
    ['unknown-key', { mystery: true }, '/mystery'],
    ['invalid-source-shape', { facts: [] }, '/facts'],
    ['invalid-source-shape', { facts: { 'x.json': false } }, '/facts/x.json'],
    ['invalid-source-shape', { facts: { 'x.json': [['items']] } }, '/facts/x.json/0'],
    ['invalid-source-shape', { facts: { 'x.json': [['items', 1]] } }, '/facts/x.json/0'],
    ['invalid-source-shape', { zones: {} }, '/zones'],
    ['invalid-source-shape', { zones: [false] }, '/zones/0'],
    ['invalid-source-shape', { zones: [{}] }, '/zones/0/path'],
    ['invalid-source-shape', { zones: [{ path: '', visibility: 'planet' }] }, '/zones/0/visibility'],
    ['invalid-source-shape', { zones: [{ path: '', audience: false }] }, '/zones/0/audience'],
    ['invalid-source-shape', { zones: [{ path: '', intent: false }] }, '/zones/0/intent'],
    ['invalid-source-shape', { zones: [{ path: '', rules: false }] }, '/zones/0/rules'],
    ['invalid-source-shape', { zones: [{ path: '', rules: ['ok', false] }] }, '/zones/0/rules'],
    ['invalid-source-shape', { seed: {} }, '/seed'],
    ['invalid-source-shape', { seed: [false] }, '/seed/0'],
    ['invalid-source-shape', { seed: [{ to: 'b' }] }, '/seed/0/from'],
    ['invalid-source-shape', { seed: [{ from: 'a' }] }, '/seed/0/to'],
    ['invalid-source-shape', { seed: [{ from: 'a', to: 'b', kind: false }] }, '/seed/0/kind'],
    ['invalid-source-shape', { seed: [{ from: 'a', to: 'b', via: false }] }, '/seed/0/via'],
    ['invalid-source-shape', { imports: [] }, '/imports'],
    ['invalid-source-shape', { imports: { a: null } }, '/imports/a'],
    ['invalid-source-shape', { imports: { a: {} } }, '/imports/a/path'],
    ['invalid-source-shape', { imports: { a: { path: 'x', repoId: false } } }, '/imports/a/repoId'],
    ['invalid-source-shape', { imports: { a: { path: 'x', audience: false } } }, '/imports/a/audience'],
    ['invalid-source-shape', { exports: {} }, '/exports'],
    ['invalid-source-shape', { exports: [false] }, '/exports/0'],
    ['invalid-source-shape', { exports: [{ from: 'a' }] }, '/exports/0/id'],
    ['invalid-source-shape', { exports: [{ id: 'x' }] }, '/exports/0/from'],
    ['invalid-source-shape', { exports: [{ id: 'x', from: 'a', audience: false }] }, '/exports/0/audience'],
    ['invalid-source-shape', { exports: [{ id: 'x', from: 'a', declassify: 'yes' }] }, '/exports/0/declassify'],
  ]
  cases.forEach(([code, child, pointer], index) => {
    const root = repo(`schema-${index}`)
    put(root, '.true-up.json', composedRoot(['child.json']))
    put(root, 'child.json', child)
    expectCode(code, () => load(root), (error) => assert.equal(error.pointer, pointer))
  })
})

test('schema: root scalar types and root incremental declarations are validated', () => {
  const invalid = [
    [{ out: false }, '/out'],
    [{ symbols: 'false' }, '/symbols'],
    [{ strictSpans: 1 }, '/strictSpans'],
    [{ deadlineMs: -1 }, '/deadlineMs'],
    [{ deadlineMs: null }, '/deadlineMs'],
    [{ repoId: 1 }, '/repoId'],
    [{ $schema: 1 }, '/$schema'],
    [{ facts: [] }, '/facts'],
    [{ seed: {} }, '/seed'],
    [{ imports: [] }, '/imports'],
    [{ exports: {} }, '/exports'],
    [{ mystery: true }, '/mystery', 'unknown-key'],
  ]
  invalid.forEach(([extra, pointer, code = 'invalid-source-shape'], index) => {
    const root = repo(`root-schema-${index}`)
    put(root, '.true-up.json', composedRoot(['child.json'], extra))
    put(root, 'child.json', {})
    expectCode(code, () => load(root), (error) => assert.equal(error.pointer, pointer))
  })
})

test('schema: compound invalid objects select their canonical member first', () => {
  const cases = [
    [{ zones: [{ path: 1, visibility: 1, audience: 1 }] }, '/zones/0/audience'],
    [{ seed: [{ from: 'a', to: 1, kind: 1 }] }, '/seed/0/kind'],
    [{ imports: { dep: { path: 1, repoId: 1, audience: 1 } } }, '/imports/dep/audience'],
    [{ exports: [{ id: 1, from: 1, audience: 1 }] }, '/exports/0/audience'],
    [{ zones: [{ path: '../escape', visibility: 'planet' }] }, '/zones/0/path'],
    [{ seed: [{ from: '../escape', to: 'b', kind: 1 }] }, '/seed/0/from'],
    [{ imports: { dep: { path: '../escape', repoId: 1 } } }, '/imports/dep/path'],
    [{ exports: [{ from: '../escape', id: 1 }] }, '/exports/0/from'],
  ]
  cases.forEach(([fragment, expected], index) => {
    const root = repo(`canonical-member-${index}`)
    put(root, '.true-up.json', composedRoot(['child.json']))
    put(root, 'child.json', fragment)
    expectCode('invalid-source-shape', () => load(root), (error) => assert.equal(error.pointer, expected))
  })
})

test('schema: literal owner identities reject non-round-trippable Unicode', () => {
  const cases = [
    [{ imports: { ['\ud800']: { path: 'snapshot.json' } } }, '/imports/\ud800'],
    [{ exports: [{ id: '\ud801', from: 'data.json' }] }, '/exports/0/id'],
  ]
  cases.forEach(([fragment, expected], index) => {
    const root = repo(`owner-unicode-${index}`)
    put(root, '.true-up.json', composedRoot(['child.json']))
    put(root, 'child.json', fragment)
    expectCode('invalid-source-shape', () => load(root), (error) => assert.equal(error.pointer, expected))
  })
})

test('schema: underscore metadata and an empty zones fragment are inert', () => {
  const root = repo('schema-inert-metadata')
  put(root, '.true-up.json', composedRoot(['child.json'], { _rootComment: { arbitrary: true } }))
  put(root, 'child.json', { _owner: 'docs', zones: [] })
  const bundle = load(root)
  assert(!Object.hasOwn(bundle.config, '_rootComment'))
  assert(!Object.hasOwn(bundle.config, '_owner'))
  assert(!Object.hasOwn(bundle.config, 'zones'), 'zero real zones must retain the existing public-default absence')
})

test('merge: every cross-source logical owner conflict names all canonically sorted origins', () => {
  const cases = [
    [{ facts: { 'same.json': [['items', 'id']] } }, { facts: { 'same.json': [['items', 'id']] } }, 'facts:same.json'],
    [{ facts: { 'x.json': [['items', 'id']] } }, { facts: { 'x.json': [['other', 'id']] } }, 'facts:x.json'],
    [{ zones: [{ path: 'same/', intent: 'same' }] }, { zones: [{ path: 'same/', intent: 'same' }] }, 'zones:same/'],
    [{ zones: [{ path: 'docs/', intent: 'a' }] }, { zones: [{ path: 'docs/', intent: 'b' }] }, 'zones:docs/'],
    [{ seed: [{ from: 'a', to: 'b' }] }, { seed: [{ from: 'a', to: 'b', kind: 'derives-facts-from' }] }, 'seed:a\u0000b'],
    [{ seed: [{ from: 'via', to: 'target', kind: 'generated-from', via: 'secret-one.mjs' }] }, { seed: [{ from: 'via', to: 'target', kind: 'generated-from', via: 'secret-two.mjs' }] }, 'seed:via\u0000target'],
    [{ seed: [{ from: 'a', to: 'b' }] }, { seed: [{ from: 'a', to: 'b', kind: 'tests' }] }, 'seed:a\u0000b'],
    [{ imports: { same: { path: 'a' } } }, { imports: { same: { path: 'a' } } }, 'imports:same'],
    [{ imports: { dep: { path: 'a' } } }, { imports: { dep: { path: 'b' } } }, 'imports:dep'],
    [{ exports: [{ id: 'same', from: 'a' }] }, { exports: [{ id: 'same', from: 'a' }] }, 'exports:same'],
    [{ exports: [{ id: 'x', from: 'a' }] }, { exports: [{ id: 'x', from: 'b' }] }, 'exports:x'],
  ]
  cases.forEach(([a, z, identity], index) => {
    const root = repo(`conflict-${index}`)
    put(root, '.true-up.json', composedRoot(['z.json', 'a.json']))
    put(root, 'a.json', a)
    put(root, 'z.json', z)
    expectCode('cross-source-conflict', () => load(root), (error) => {
      const conflict = error.conflicts.find((item) => item.identity === identity)
      assert(conflict, `missing conflict ${identity}`)
      assert.deepEqual(conflict.origins.map((origin) => origin.source), ['a.json', 'z.json'])
      assert.deepEqual(error.includeChain, ['.true-up.json'])
      assert(!JSON.stringify(error).includes('secret-one.mjs'))
      assert(!JSON.stringify(error).includes('secret-two.mjs'))
    })
  })
})

test('merge: root plus three fragment conflicts and multiple identities have canonical complete detail', () => {
  const make = (name, include) => {
    const root = repo(name)
    put(root, '.true-up.json', composedRoot(include, {
      facts: { 'shared.json': [['items', 'id']] },
      imports: { shared: { path: 'root-private-value.json' } },
    }))
    for (const path of ['a.json', 'm.json', 'z.json']) {
      put(root, path, {
        facts: { 'shared.json': [['items', path]] },
        imports: { shared: { path: `${path}-private-value.json` } },
      })
    }
    return expectCode('cross-source-conflict', () => load(root))
  }
  const first = make('multi-conflict-a', ['z.json', 'a.json', 'm.json'])
  const second = make('multi-conflict-b', ['m.json', 'z.json', 'a.json'])
  assert.deepEqual(first.conflicts, second.conflicts)
  assert.deepEqual(first.origins, second.origins)
  assert.deepEqual(first.conflicts.map((item) => item.identity), ['facts:shared.json', 'imports:shared'])
  assert.deepEqual(first.conflicts[0].origins.map((origin) => origin.source), ['.true-up.json', 'a.json', 'm.json', 'z.json'])
  assert.deepEqual(first.conflicts[1].origins.map((origin) => origin.source), ['.true-up.json', 'a.json', 'm.json', 'z.json'])
  const publicDetail = [String(first), first.message, first.stack, JSON.stringify(first)].join('\n')
  assert(!publicDetail.includes('private-value'))
  assert(!publicDetail.includes(runRoot))
})

test('projection: seed endpoint tuples cannot collide through delimiter bytes', () => {
  const projection = semanticProjection({ seed: [
    { from: 'a', to: 'b\u0000c' },
    { from: 'a\u0000b', to: 'c' },
  ] })
  assert.equal(projection.seed.length, 2)
  assert.deepEqual(projection.seed.map((edge) => [edge.from, edge.to]), [['a', 'b\u0000c'], ['a\u0000b', 'c']])
})

test('paths: invalid lexical forms fail before fragment reads', () => {
  const cases = [
    ['', 'include-path-empty'],
    ['bad\\path.json', 'include-path-backslash'],
    ['/absolute.json', 'include-path-absolute'],
    ['C:/absolute.json', 'include-path-absolute'],
    ['bad\u0000path.json', 'include-path-nul'],
    ['\ud800.json', 'include-path-invalid-unicode'],
    ['../escape.json', 'include-path-escape'],
    ['a/../../escape.json', 'include-path-escape'],
    ['.git/config.json', 'include-forbidden-location'],
    ['.true-up/config.json', 'include-forbidden-location'],
  ]
  cases.forEach(([path, code], index) => {
    const root = repo(`path-${index}`)
    put(root, '.true-up.json', composedRoot([path]))
    const reads = []
    expectCode(code, () => load(root, { providerOptions: { onRead: (p) => reads.push(p) } }))
    assert.deepEqual(reads, ['.true-up.json'])
  })
})

test('paths: normalized duplicates identify both manifest indices without reads', () => {
  const root = repo('path-duplicates')
  put(root, '.true-up.json', composedRoot(['x.json', 'a/../x.json']))
  const reads = []
  expectCode('include-path-duplicate', () => load(root, { providerOptions: { onRead: (p) => reads.push(p) } }), (error) => {
    assert.deepEqual(error.origins.map((origin) => origin.pointer), ['/include/0', '/include/1'])
  })
  assert.deepEqual(reads, ['.true-up.json'])
})

test('paths: root, missing, ignored, generated-cache, and literal glob cases fail distinctly', () => {
  const cases = [
    ['.true-up.json', 'include-root', {}],
    ['missing.json', 'include-missing', {}],
    ['ignored/child.json', 'include-ignored', { ignored: (path) => path === 'ignored/child.json', create: true }],
    ['cache/child.json', 'include-ignored', { ignored: (path) => path === 'cache/child.json', create: true }],
    ['*.json', 'include-missing', {}],
  ]
  cases.forEach(([path, code, options], index) => {
    const root = repo(`path-state-${index}`)
    put(root, '.true-up.json', composedRoot([path]))
    if (options.create) put(root, path, {})
    expectCode(code, () => load(root, { providerOptions: { isIgnored: options.ignored } }))
  })
  const allowedPrefix = repo('path-dot-true-upx')
  put(allowedPrefix, '.true-up.json', composedRoot(['.true-upx/child.json']))
  put(allowedPrefix, '.true-upx/child.json', {})
  assert.equal(load(allowedPrefix).mode, 'composed')

  const dotDotSafe = repo('path-dot-dot-safe')
  put(dotDotSafe, '.true-up.json', composedRoot(['..safe.json']))
  put(dotDotSafe, '..safe.json', {})
  assert.equal(load(dotDotSafe).mode, 'composed')
})

test('paths: the default provider rejects Git-ignored fragments without an injected callback', () => {
  const root = repo('default-git-ignore')
  assert.equal(spawnSync('git', ['-C', root, 'init', '-q']).status, 0)
  put(root, '.gitignore', 'build/\n')
  put(root, '.true-up.json', composedRoot(['build/child.json']))
  put(root, 'build/child.json', {})
  expectCode('include-ignored', () => loadConfigBundle({ repoRoot: root }))

  const nonGit = repo('default-ignore-unavailable')
  put(nonGit, '.true-up.json', composedRoot(['child.json']))
  put(nonGit, 'child.json', {})
  expectCode('include-not-regular', () => loadConfigBundle({ repoRoot: nonGit }))

  const priorPath = process.env.PATH
  try {
    process.env.PATH = '/nonexistent'
    expectCode('include-not-regular', () => loadConfigBundle({ repoRoot: root }))
  } finally {
    process.env.PATH = priorPath
  }
})

test('paths: a symlink used only to locate the repository does not become an include component', () => {
  const root = repo('repository-locator-real')
  put(root, '.true-up.json', composedRoot(['child.json']))
  put(root, 'child.json', {})
  const locator = join(runRoot, 'repository-locator-link')
  symlinkSync(root, locator, 'dir')
  const bundle = loadConfigBundle({ repoRoot: locator, provider: createNodeConfigProvider({ repoRoot: locator, isIgnored: () => false }) })
  assert.equal(bundle.mode, 'composed')
  assert.deepEqual(bundle.composition.fragments, ['child.json'])
})

test('paths: missing, ignored, and realpath-escape states make one exact provider call', () => {
  const cases = [
    ['include-missing', { kind: 'missing' }],
    ['include-ignored', { kind: 'regular', ignored: true }],
    ['include-realpath-escape', { kind: 'outside' }],
    ['include-not-regular', { kind: 'not-regular' }],
  ]
  cases.forEach(([code, child], index) => {
    const events = []
    const provider = virtualProvider({ fragments: { 'child.json': child }, events })
    expectCode(code, () => load(repo(`virtual-include-${index}`), { provider }), (error) => {
      assert.equal(error.source, 'child.json')
      assert.equal(error.pointer, '/include/0')
      assert.deepEqual(error.includeChain, ['.true-up.json', 'child.json'])
    })
    assert.deepEqual(events, [
      { op: 'selectEntry', names: ['.true-up.json', 'true-up.config.json'] },
      { op: 'inspectAndRead', path: 'child.json', options: { role: 'include', maxBytes: 33_554_432 }, count: 1 },
    ])
  })
})

test('provider: thrown entry/include failures are sanitized to stable composition errors', () => {
  const poison = `${runRoot}/provider-secret`
  const entryProvider = { selectEntry() { throw new Error(poison) }, inspectAndRead() { assert.fail('unreachable') } }
  expectCode('composition-root-not-regular', () => load(repo('throwing-entry'), { provider: entryProvider }), (error) => {
    assert(![String(error), error.message, error.stack, JSON.stringify(error)].join('\n').includes(poison))
  })

  const includeProvider = virtualProvider({ fragments: { 'child.json': () => { throw new Error(poison) } } })
  expectCode('include-not-regular', () => load(repo('throwing-include'), { provider: includeProvider }), (error) => {
    assert(![String(error), error.message, error.stack, JSON.stringify(error)].join('\n').includes(poison))
  })

  const badNameProvider = virtualProvider({ entryPath: poison })
  expectCode('composition-root-not-regular', () => load(repo('absolute-provider-entry'), { provider: badNameProvider }), (error) => {
    assert.equal(error.source, '.true-up.json')
    assert(![String(error), error.message, error.stack, JSON.stringify(error)].join('\n').includes(poison))
  })
})

test('ordering: canonical source/read/tick order compares raw UTF-8 bytes without NFC folding', () => {
  const root = repo('raw-utf8-order')
  const nfd = 'e\u0301.json'
  const nfc = '\u00e9.json'
  put(root, 'true-up.config.json', composedRoot([nfc, 'z.json', nfd]))
  put(root, nfd, { facts: { 'nfd.json': [['items', 'id']] } })
  put(root, nfc, { facts: { 'nfc.json': [['items', 'id']] } })
  put(root, 'z.json', { facts: { 'z.json': [['items', 'id']] } })
  const reads = []
  const ticks = []
  const bundle = load(root, { providerOptions: { onRead: (path) => reads.push(path) }, tick: (event) => ticks.push(event) })
  assert.notEqual(nfd, nfc)
  assert.deepEqual(bundle.composition.fragments, [nfd, 'z.json', nfc])
  assert.deepEqual(reads, ['true-up.config.json', nfd, 'z.json', nfc])
  assert.deepEqual(bundle.sources.map((source) => source.path), [nfd, 'true-up.config.json', 'z.json', nfc])
  assert.deepEqual(ticks, [
    'composition root parsed',
    `composition fragment ${nfd}`,
    'composition fragment z.json',
    `composition fragment ${nfc}`,
    'composition merge',
  ])
})

test('paths: final and ancestor symlinks are rejected without reading targets', () => {
  const finalRoot = repo('symlink-final')
  put(finalRoot, '.true-up.json', composedRoot(['child.json']))
  put(finalRoot, 'real.json', {})
  symlinkSync('real.json', join(finalRoot, 'child.json'))
  const reads = []
  expectCode('include-symlink', () => load(finalRoot, { providerOptions: { onRead: (path) => reads.push(path) } }))
  assert.deepEqual(reads, ['.true-up.json'])

  const ancestorRoot = repo('symlink-ancestor')
  put(ancestorRoot, '.true-up.json', composedRoot(['alias/child.json']))
  put(ancestorRoot, 'real/child.json', {})
  symlinkSync('real', join(ancestorRoot, 'alias'))
  expectCode('include-symlink', () => load(ancestorRoot))

  const outsideRoot = repo('symlink-outside-regular')
  put(outsideRoot, '.true-up.json', composedRoot(['child.json']))
  put(runRoot, 'outside-regular-target.json', {})
  symlinkSync('../outside-regular-target.json', join(outsideRoot, 'child.json'))
  expectCode('include-symlink', () => load(outsideRoot))
})

test('paths: symlink-to-FIFO targets are rejected without blocking on final or ancestor components', () => {
  const finalRoot = repo('symlink-fifo-final')
  put(finalRoot, '.true-up.json', composedRoot(['child.json']))
  assert.equal(spawnSync('mkfifo', [join(finalRoot, 'target.fifo')]).status, 0)
  symlinkSync('target.fifo', join(finalRoot, 'child.json'))

  const ancestorRoot = repo('symlink-fifo-ancestor')
  put(ancestorRoot, '.true-up.json', composedRoot(['alias/child.json']))
  mkdirSync(join(ancestorRoot, 'real'))
  assert.equal(spawnSync('mkfifo', [join(ancestorRoot, 'real/child.json')]).status, 0)
  symlinkSync('real', join(ancestorRoot, 'alias'))

  for (const root of [finalRoot, ancestorRoot]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--loader-child', root, 'include-symlink'], { encoding: 'utf8', timeout: 3000 })
    assert.equal(child.status, 0, `symlink-to-FIFO loader hung or failed: ${child.error || child.stderr}`)
    assert.equal(child.stdout.trim(), 'include-symlink')
  }
})

test('paths: composed root symlink is rejected while legacy root symlink remains compatible', () => {
  const composed = repo('root-symlink-composed')
  put(composed, 'manifest.json', composedRoot(['child.json']))
  put(composed, 'child.json', {})
  symlinkSync('manifest.json', join(composed, '.true-up.json'))
  expectCode('composition-root-symlink', () => load(composed))

  const legacy = repo('root-symlink-legacy')
  put(legacy, 'manifest.json', { symbols: false })
  symlinkSync('manifest.json', join(legacy, '.true-up.json'))
  assert.deepEqual(load(legacy).config, { symbols: false })
})

test('paths: directories and FIFOs fail as non-regular without hanging', () => {
  const directory = repo('nonregular-directory')
  put(directory, '.true-up.json', composedRoot(['child.json']))
  mkdirSync(join(directory, 'child.json'))
  expectCode('include-not-regular', () => load(directory))

  const fifo = repo('nonregular-fifo')
  put(fifo, '.true-up.json', composedRoot(['child.json']))
  const made = spawnSync('mkfifo', [join(fifo, 'child.json')], { encoding: 'utf8' })
  assert.equal(made.status, 0, `mkfifo failed: ${made.stderr}`)
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--loader-child', fifo, 'include-not-regular'], { encoding: 'utf8', timeout: 3000 })
  assert.equal(child.status, 0, `FIFO loader hung or failed: ${child.error || child.stderr}`)
  assert.equal(child.stdout.trim(), 'include-not-regular')
})

test('paths: a directory or FIFO selected as the root is rejected without hanging', () => {
  const directory = repo('root-nonregular-directory')
  mkdirSync(join(directory, '.true-up.json'))
  expectCode('composition-root-not-regular', () => load(directory))

  const fifo = repo('root-nonregular-fifo')
  assert.equal(spawnSync('mkfifo', [join(fifo, '.true-up.json')]).status, 0)
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--loader-child', fifo, 'composition-root-not-regular'], { encoding: 'utf8', timeout: 3000 })
  assert.equal(child.status, 0, `root FIFO loader hung or failed: ${child.error || child.stderr}`)
  assert.equal(child.stdout.trim(), 'composition-root-not-regular')
})

test('nested include: self/root/sibling/diamond attempts fail before any grandchild read', () => {
  const cases = [
    { 'a.json': { include: ['a.json'] } },
    { 'a.json': { include: ['.true-up.json'] } },
    { 'a.json': { include: ['b.json'] }, 'b.json': {} },
    { 'a.json': { include: ['c.json'] }, 'b.json': { include: ['c.json'] }, 'c.json': {} },
    { 'a.json': { compositionVersion: 1 } },
  ]
  cases.forEach((fragments, index) => {
    const root = repo(`nested-${index}`)
    const direct = Object.keys(fragments).filter((path) => path === 'a.json' || (index === 3 && path === 'b.json'))
    put(root, '.true-up.json', composedRoot(direct))
    for (const [path, value] of Object.entries(fragments)) put(root, path, value)
    const reads = []
    const ticks = []
    expectCode('nested-include', () => load(root, { providerOptions: { onRead: (path) => reads.push(path) }, tick: (event) => ticks.push(event) }), (error) => {
      assert.equal(error.source, 'a.json')
      assert.equal(error.pointer, index === 4 ? '/compositionVersion' : '/include')
      assert.deepEqual(error.includeChain, ['.true-up.json', 'a.json'])
    })
    assert.deepEqual(reads, ['.true-up.json', 'a.json'])
    assert.deepEqual(ticks, ['composition root parsed', 'composition fragment a.json'])
  })

  const reordered = repo('nested-diamond-reordered')
  put(reordered, '.true-up.json', composedRoot(['b.json', 'a.json']))
  put(reordered, 'a.json', { include: ['c.json'] })
  put(reordered, 'b.json', { include: ['c.json'] })
  put(reordered, 'c.json', {})
  const reads = []
  expectCode('nested-include', () => load(reordered, { providerOptions: { onRead: (path) => reads.push(path) } }), (error) => assert.equal(error.source, 'a.json'))
  assert.deepEqual(reads, ['.true-up.json', 'a.json'])
})

test('bounds: count and duplicates fail before reads; byte limit is exact and root bytes are excluded', () => {
  const count = repo('count-limit')
  const includes = Array.from({ length: 257 }, (_, i) => `f${i}.json`)
  put(count, '.true-up.json', composedRoot(includes))
  const countReads = []
  expectCode('include-count-limit', () => load(count, { providerOptions: { onRead: (path) => countReads.push(path) } }))
  assert.deepEqual(countReads, ['.true-up.json'])

  const bytes = repo('bytes-limit')
  put(bytes, '.true-up.json', composedRoot(['child.json'], { _padding: 'root bytes are excluded' }))
  put(bytes, 'child.json', '{} ')
  assert.equal(load(bytes, { limits: { ...COMPOSITION_LIMITS, maxIncludedBytes: 3 } }).mode, 'composed')
  put(bytes, 'child.json', '{}  ')
  expectCode('include-bytes-limit', () => load(bytes, { limits: { ...COMPOSITION_LIMITS, maxIncludedBytes: 3 } }))

  const aggregate = repo('bytes-limit-aggregate')
  put(aggregate, '.true-up.json', composedRoot(['b.json', 'a.json']))
  put(aggregate, 'a.json', '{}')
  put(aggregate, 'b.json', '{}')
  const aggregateReads = []
  expectCode('include-bytes-limit', () => load(aggregate, {
    limits: { maxIncludes: 256, maxIncludedBytes: 3 },
    providerOptions: { onRead: (path) => aggregateReads.push(path) },
  }))
  assert.deepEqual(aggregateReads, ['.true-up.json', 'a.json'])

  const multibyte = repo('bytes-limit-multibyte')
  const multibyteJson = '{"_x":"\u00e9"}'
  assert.equal(multibyteJson.length, 10)
  assert.equal(Buffer.byteLength(multibyteJson, 'utf8'), 11)
  put(multibyte, '.true-up.json', composedRoot(['child.json']))
  put(multibyte, 'child.json', multibyteJson)
  assert.equal(load(multibyte, { limits: { maxIncludes: 256, maxIncludedBytes: 11 } }).composition.includedBytes, 11)
  expectCode('include-bytes-limit', () => load(multibyte, { limits: { maxIncludes: 256, maxIncludedBytes: 10 } }))

  const defaultProvider = virtualProvider({
    entry: { kind: 'regular', bytes: jsonBytes(composedRoot(['huge.json'])), realInside: true },
    fragments: { 'huge.json': { kind: 'regular', bytes: Buffer.alloc(33_554_433, 0x20) } },
  })
  expectCode('include-bytes-limit', () => load(repo('bytes-limit-default'), { provider: defaultProvider }))
})

test('bounds: exactly 256 fragments are each read once', () => {
  const root = repo('count-exact')
  const includes = Array.from({ length: 256 }, (_, i) => `f/${String(i).padStart(3, '0')}.json`)
  put(root, '.true-up.json', composedRoot(includes.slice().reverse()))
  for (const path of includes) put(root, path, {})
  const reads = []
  const bundle = load(root, { providerOptions: { onRead: (path) => reads.push(path) } })
  assert.equal(bundle.composition.fragmentCount, 256)
  assert(!Object.hasOwn(bundle.config, 'zones'))
  assert.deepEqual(reads, ['.true-up.json', ...includes])
})

test('bounds: virtual provider observes one bounded read per accepted source and decreasing aggregate allowance', () => {
  const events = []
  const provider = virtualProvider({
    entry: { kind: 'regular', bytes: jsonBytes(composedRoot(['b.json', 'a.json'])), realInside: true },
    fragments: {
      'a.json': { kind: 'regular', bytes: Buffer.from('{}') },
      'b.json': { kind: 'regular', bytes: Buffer.from('{}') },
    },
    events,
  })
  const bundle = load(repo('virtual-once'), { provider })
  assert.equal(bundle.composition.includedBytes, 4)
  assert.deepEqual(events, [
    { op: 'selectEntry', names: ['.true-up.json', 'true-up.config.json'] },
    { op: 'inspectAndRead', path: 'a.json', options: { role: 'include', maxBytes: 33_554_432 }, count: 1 },
    { op: 'inspectAndRead', path: 'b.json', options: { role: 'include', maxBytes: 33_554_430 }, count: 1 },
  ])
})

test('validation barrier: child failure wins before out computation and loader writes nothing', () => {
  const parent = repo('write-barrier-parent')
  const root = join(parent, 'target')
  mkdirSync(root)
  put(root, '.true-up.json', composedRoot(['missing.json'], { out: '../outside.json' }))
  put(root, '.true-up/depgraph.json', 'sentinel graph\n')
  put(root, '.true-up/depgraph.json.tmp', 'sentinel graph temp\n')
  put(root, 'custom.json', 'sentinel custom\n')
  put(parent, 'outside.json', 'sentinel outside\n')
  put(parent, 'outside.json.tmp', 'sentinel outside temp\n')
  const before = snapshot(parent)
  expectCode('include-missing', () => load(root))
  assert.deepEqual(snapshot(parent), before)
  assert.equal(readFileSync(join(parent, 'outside.json'), 'utf8'), 'sentinel outside\n')
})

test('validation barrier: an invalid root declaration path stops before any fragment read', () => {
  const root = repo('root-declaration-path-barrier')
  put(root, '.true-up.json', composedRoot(['z.json'], {
    seed: [{ from: '../escape.md', to: 'source.json' }],
  }))
  put(root, 'z.json', '{ malformed')
  const reads = []
  expectCode('invalid-source-shape', () => load(root, { providerOptions: { onRead: (path) => reads.push(path) } }), (error) => {
    assert.equal(error.source, '.true-up.json')
    assert.equal(error.pointer, '/seed/0/from')
  })
  assert.deepEqual(reads, ['.true-up.json'])
})

test('validation barrier: an invalid declaration in the first canonical fragment stops the next read', () => {
  const root = repo('fragment-declaration-path-barrier')
  put(root, '.true-up.json', composedRoot(['z.json', 'a.json']))
  put(root, 'a.json', { facts: { '../escape.json': [['items', 'id']] } })
  put(root, 'z.json', '{ malformed')
  const reads = []
  expectCode('invalid-source-shape', () => load(root, { providerOptions: { onRead: (path) => reads.push(path) } }), (error) => {
    assert.equal(error.source, 'a.json')
    assert.equal(error.pointer, '/facts/..~1escape.json')
  })
  assert.deepEqual(reads, ['.true-up.json', 'a.json'])
})

test('normalized semantics: deeply nested valid JSON does not escape as a raw call-stack error', () => {
  const root = repo('deep-semantic-normalization')
  const depth = 3000
  const nested = `${'{"x":'.repeat(depth)}"leaf"${'}'.repeat(depth)}`
  put(root, '.true-up.json', composedRoot(['child.json']))
  put(root, 'child.json', `{"zones":[{"path":"","metadata":${nested}}]}`)
  const bundle = load(root)
  assert.equal(bundle.mode, 'composed')
  assert(bundle.normalizedConfigBytes.includes('"leaf"'))
  assert(bundle.normalizedConfigBytes.endsWith('\n'))
})

test('normalized semantics: seeded owner partitions are invariant and failures are replayable/minimized', () => {
  const owners = [
    { kind: 'facts', key: 'a.json', values: [['items', 'id'], ['items', 'id']] },
    { kind: 'facts', key: 'z.json', values: [['rows', 'key']] },
    { kind: 'zones', key: 'docs/', values: [{ path: 'docs/', intent: 'first' }, { path: 'docs/', intent: 'second' }] },
    { kind: 'zones', key: '', values: [{ path: '', visibility: 'public' }] },
    { kind: 'seed', key: 'a\u0000b', values: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b', kind: 'derives-facts-from' }] },
    { kind: 'seed', key: 'c\u0000d', values: [{ from: 'c', to: 'd', kind: 'tests' }] },
    { kind: 'imports', key: 'dep', values: { path: 'imports/dep.json' } },
    { kind: 'exports', key: 'public.a', values: [{ id: 'public.a', from: 'a.json#items.a' }] },
  ]
  const materialize = (name, assignment, includeOrder) => {
    const root = repo(name)
    const fragments = Array.from({ length: 4 }, () => ({}))
    const arrays = (obj, key) => { if (!obj[key]) obj[key] = []; return obj[key] }
    owners.forEach((owner, index) => {
      const fragment = fragments[assignment[index]]
      if (owner.kind === 'facts' || owner.kind === 'imports') {
        fragment[owner.kind] ||= {}
        fragment[owner.kind][owner.key] = owner.values
      } else arrays(fragment, owner.kind).push(...owner.values)
    })
    const paths = fragments.map((_, i) => `domain/${i}.json`)
    put(root, '.true-up.json', composedRoot(includeOrder.map((i) => paths[i]), { symbols: false }))
    fragments.forEach((fragment, i) => put(root, paths[i], fragment))
    return load(root)
  }
  const seeds = [0x5eed, 0xc0ffee, 0xdecafbad, 0x12345678, 0x9e3779b9]
  const rand = (seed) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const fisherYates = (values, next) => {
    const shuffled = [...values]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = next() % (index + 1)
      ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
    }
    return shuffled
  }
  const reference = materialize('partition-reference', owners.map(() => 0), [0, 1, 2, 3])
  let attempt = 0
  for (const seed of seeds) {
    const next = rand(seed)
    const assignment = owners.map(() => next() % 4)
    const order = fisherYates([0, 1, 2, 3], next)
    const candidate = materialize(`partition-${seed.toString(16)}`, assignment, order)
    if (candidate.normalizedConfigBytes === reference.normalizedConfigBytes) continue

    let minimized = [...assignment]
    for (let owner = 0; owner < minimized.length; owner++) {
      if (minimized[owner] === 0) continue
      const trial = [...minimized]
      trial[owner] = 0
      const trialBundle = materialize(`partition-minimize-${seed.toString(16)}-${attempt++}`, trial, order)
      if (trialBundle.normalizedConfigBytes !== reference.normalizedConfigBytes) minimized = trial
    }
    const counterexample = {
      property: 'owner-partition-invariance',
      seed,
      originalAssignment: assignment,
      minimizedAssignment: minimized,
      includeOrder: order,
      expectedHash: sha256(reference.normalizedConfigBytes),
      actualHash: sha256(candidate.normalizedConfigBytes),
    }
    writeFileSync(join(runRoot, 'property-counterexample.json'), JSON.stringify(counterexample, null, 2) + '\n')
    assert.fail(`partition seed ${seed.toString(16)} changed semantics; replay ${join(runRoot, 'property-counterexample.json')}`)
  }
})

test('merge: seeded collision origins stay complete and canonical under Fisher-Yates manifest permutations', () => {
  const seeds = [0x5eed, 0xc0ffee, 0xdecafbad, 0x12345678, 0x9e3779b9]
  const rand = (seed) => () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed }
  const fisherYates = (values, next) => {
    const shuffled = [...values]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = next() % (index + 1)
      ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
    }
    return shuffled
  }
  for (const seed of seeds) {
    const next = rand(seed)
    const count = 2 + (next() % 3)
    const paths = ['a.json', 'm.json', 'q.json', 'z.json'].slice(0, count)
    const root = repo(`collision-${seed.toString(16)}`)
    put(root, '.true-up.json', composedRoot(fisherYates(paths, next)))
    for (const path of paths) put(root, path, { facts: { 'shared/~owner.json': [['items', path]] } })
    const error = expectCode('cross-source-conflict', () => load(root))
    const conflict = error.conflicts.find((item) => item.identity === 'facts:shared/~owner.json')
    if (!conflict) {
      writeFileSync(join(runRoot, 'property-counterexample.json'), JSON.stringify({
        property: 'collision-origin-completeness',
        seed,
        minimizedSources: paths.slice(0, 2),
      }, null, 2) + '\n')
      assert.fail(`collision seed ${seed.toString(16)} omitted the logical owner`)
    }
    const expectedOrigins = paths.map((source) => ({ source, pointer: '/facts/shared~1~0owner.json' }))
    try { assert.deepEqual(conflict.origins, expectedOrigins) }
    catch (error) {
      writeFileSync(join(runRoot, 'property-counterexample.json'), JSON.stringify({
        property: 'collision-origin-completeness',
        seed,
        originalSources: paths,
        minimizedSources: paths.slice(0, 2),
        expectedOrigins,
        actualOrigins: conflict.origins,
      }, null, 2) + '\n')
      throw error
    }
  }
})

test('contract: every and only frozen Wave 1 composition detail code is exercised', () => {
  assert.deepEqual([...observedErrorCodes].sort(), stableErrorCodes)
  assert.deepEqual([...CONFIG_COMPOSITION_ERROR_CODES].sort(), stableErrorCodes)
})

let passed = 0
for (const { name, fn } of tests) {
  try { fn(); passed++ }
  catch (error) {
    const failure = {
      ok: false,
      name,
      seedCorpus: [0x5eed, 0xc0ffee, 0xdecafbad, 0x12345678, 0x9e3779b9],
      scratch: runRoot,
      error: error?.stack || String(error),
    }
    writeFileSync(join(runRoot, 'counterexample.json'), JSON.stringify(failure, null, 2) + '\n')
    process.stderr.write(`${failure.error}\ncounterexample: ${join(runRoot, 'counterexample.json')}\n`)
    process.exit(1)
  }
}

const report = {
  ok: true,
  tests: passed,
  seedCorpus: [0x5eed, 0xc0ffee, 0xdecafbad, 0x12345678, 0x9e3779b9],
  limits: COMPOSITION_LIMITS,
  scratch: runRoot,
}
writeFileSync(join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report) + '\n')
