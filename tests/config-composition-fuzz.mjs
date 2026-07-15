#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  ConfigLoadError,
  loadConfigBundle,
  semanticProjection,
} from '../lib/config.mjs'

const PARSER_FLOOR_PER_SECOND = 1_000
const DEFAULT_CASES_PER_SEED = 80
const DEFAULT_BENCH_EXECUTIONS = 5_000
const DEFAULT_SEEDS = Object.freeze([
  0x00005eed,
  0x00c0ffee,
  0x12345678,
  0x9e3779b9,
  0xdecafbad,
])

const MR_MATRIX = Object.freeze([
  { id: 'include_permutation_equivalence', fault: 4, impact: 3, cost: 1 },
  { id: 'valid_repartition_equivalence', fault: 5, impact: 5, cost: 2 },
  { id: 'inert_underscore_metadata_equivalence', fault: 3, impact: 4, cost: 1 },
  { id: 'compound_permutation_repartition', fault: 5, impact: 4, cost: 2 },
  { id: 'independent_failure_order', fault: 4, impact: 5, cost: 2 },
].map((row) => Object.freeze({ ...row, score: (row.fault * row.impact) / row.cost })))

for (const relation of MR_MATRIX) {
  if (relation.score < 2) throw new Error(`metamorphic relation ${relation.id} scored below 2`)
}

const VALID_RELATIONS = MR_MATRIX.slice(0, 4).map(({ id }) => id)

class MrFailure extends Error {
  constructor(relation, message, context = {}) {
    super(`${relation}: ${message}`)
    this.name = 'MrFailure'
    this.relation = relation
    this.context = context
  }
}

class Rng {
  constructor(seed) {
    this.state = (seed >>> 0) || 0x6d2b79f5
  }

  u32() {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x >>> 0
    return this.state
  }

  int(bound) {
    if (!Number.isSafeInteger(bound) || bound <= 0) throw new Error(`invalid PRNG bound ${bound}`)
    return this.u32() % bound
  }

  bool() {
    return (this.u32() & 1) === 1
  }
}

const clone = (value) => structuredClone(value)
const jsonBytes = (value) => Buffer.from(JSON.stringify(value))

const mixSeed = (seed, caseIndex, size) => {
  let mixed = (seed ^ Math.imul(caseIndex + 1, 0x9e3779b1) ^ Math.imul(size + 7, 0x85ebca6b)) >>> 0
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, 0x7feb352d) >>> 0
  mixed ^= mixed >>> 15
  return mixed >>> 0
}

function parseUnsigned(value, label) {
  if (!/^(?:0x[\da-f]+|\d+)$/i.test(value || '')) throw new Error(`${label} must be an unsigned integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`${label} must fit in uint32`)
  }
  return parsed >>> 0
}

function parsePositive(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseOptions(argv) {
  const options = {
    seeds: [...DEFAULT_SEEDS],
    cases: DEFAULT_CASES_PER_SEED,
    benchExecutions: DEFAULT_BENCH_EXECUTIONS,
    scratch: process.env.TRUE_UP_CONFIG_FUZZ_SCRATCH || join(homedir(), 'scratch', 'true-up-config-composition', 'wave3', 'fuzz'),
    artifacts: null,
    report: null,
    replay: null,
    size: null,
  }
  let explicitSeed = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const take = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[++i]
    }
    if (arg === '--seed') {
      options.seeds = [parseUnsigned(take(), '--seed')]
      explicitSeed = true
    } else if (arg === '--cases') {
      options.cases = parsePositive(take(), '--cases')
    } else if (arg === '--bench-executions') {
      options.benchExecutions = parsePositive(take(), '--bench-executions')
    } else if (arg === '--scratch') {
      options.scratch = resolve(take())
    } else if (arg === '--artifacts') {
      options.artifacts = resolve(take())
    } else if (arg === '--report') {
      options.report = resolve(take())
    } else if (arg === '--replay') {
      options.replay = parseUnsigned(take(), '--replay')
    } else if (arg === '--size') {
      options.size = parsePositive(take(), '--size')
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: node tests/config-composition-fuzz.mjs [options]',
        '',
        '  --seed <uint32>             run one fixed seed (decimal or 0xhex)',
        '  --cases <n>                 cases per seed (default: 80)',
        '  --replay <case-index>       replay one case; requires --seed',
        '  --size <n>                  replay a minimized generated size',
        '  --bench-executions <n>      parser throughput samples (default: 5000)',
        '  --scratch <path>             disposable scratch parent',
        '  --artifacts <path>           persistent failure artifacts',
        '  --report <path>              write the JSON report',
        '',
      ].join('\n'))
      return null
    } else {
      throw new Error(`unknown option ${arg}`)
    }
  }
  if (options.replay !== null && !explicitSeed) throw new Error('--replay requires --seed')
  if (options.size !== null && options.replay === null) throw new Error('--size requires --replay')
  options.artifacts ||= join(options.scratch, 'artifacts')
  return options
}

function generateLogicalConfig(rng, seed, caseIndex, size) {
  const bounded = Math.max(1, Math.min(size, 8))
  const factCount = 1 + rng.int(Math.min(5, bounded + 1))
  const zoneCount = 1 + rng.int(Math.min(5, bounded + 1))
  const importCount = 1 + rng.int(Math.min(3, bounded + 1))
  const seedCount = 1 + rng.int(Math.min(6, bounded + 2))
  const exportCount = 1 + rng.int(Math.min(4, bounded + 1))
  const facts = {}
  for (let i = 0; i < factCount; i++) {
    facts[`data/c${caseIndex}-fact${i}.json`] = i % 2
      ? [['items', 'id']]
      : [['items', 'id'], ['routes', 'name']]
  }
  const zones = Array.from({ length: zoneCount }, (_, i) => ({
    path: `domain/c${caseIndex}/zone${i}/`,
    visibility: ['public', 'internal', 'private', 'secret'][(i + rng.int(4)) % 4],
    audience: `audience-${i}`,
    intent: `intent-${caseIndex}-${i}`,
    rules: i % 2 ? [`rule-${i}`] : [`rule-${i}`, `rule-${i + 1}`],
  }))
  const imports = {}
  for (let i = 0; i < importCount; i++) {
    imports[`imp${caseIndex}_${i}`] = {
      path: `snapshots/c${caseIndex}-import${i}.json`,
      audience: ['public', 'internal', 'private'][i % 3],
      repoId: `repo-${seed.toString(16)}-${i}`,
    }
  }
  const factPaths = Object.keys(facts)
  const importAliases = Object.keys(imports)
  const seedEdges = Array.from({ length: seedCount }, (_, i) => {
    const edge = {
      from: `docs/c${caseIndex}-dependent${i}.md`,
      to: i % 3 === 0
        ? `${factPaths[i % factPaths.length]}#items.item-${i}`
        : i % 3 === 1
          ? `@${importAliases[i % importAliases.length]}:fact-${i}`
          : `src/c${caseIndex}-source${i}.mjs`,
    }
    if (i % 3 !== 0) edge.kind = i % 3 === 1 ? 'derives-facts-from' : 'generated-from'
    if (edge.kind === 'generated-from') edge.via = `tools/generate-${i}.mjs`
    return edge
  })
  const exports = Array.from({ length: exportCount }, (_, i) => ({
    id: `export-${caseIndex}-${i}`,
    from: i % 2 ? factPaths[i % factPaths.length] : `@${importAliases[i % importAliases.length]}:export-${i}`,
    audience: ['public', 'internal', 'private', 'secret'][i % 4],
    declassify: rng.bool(),
  }))
  return {
    $schema: `https://example.invalid/true-up/fuzz-${seed.toString(16)}.schema.json`,
    out: `.true-up/fuzz-${caseIndex}.json`,
    symbols: rng.bool(),
    strictSpans: rng.bool(),
    deadlineMs: 50 + rng.int(9_950),
    repoId: `fuzz-${seed.toString(16)}-${caseIndex}`,
    facts,
    zones,
    seed: seedEdges,
    imports,
    exports,
  }
}

function declarationUnits(logical) {
  const units = []
  for (const key of Object.keys(logical.facts).sort()) units.push({ family: 'facts', key, value: logical.facts[key] })
  logical.zones.forEach((value, index) => units.push({ family: 'zones', key: index, value }))
  logical.seed.forEach((value, index) => units.push({ family: 'seed', key: index, value }))
  for (const key of Object.keys(logical.imports).sort()) units.push({ family: 'imports', key, value: logical.imports[key] })
  logical.exports.forEach((value, index) => units.push({ family: 'exports', key: index, value }))
  return units
}

function generateSpec(seed, caseIndex, size) {
  const rng = new Rng(mixSeed(seed, caseIndex, size))
  const logical = generateLogicalConfig(rng, seed, caseIndex, size)
  const fragmentCount = 2 + rng.int(Math.min(5, Math.max(2, size + 1)))
  const fragmentPaths = Array.from({ length: fragmentCount }, (_, i) => `fragments/c${caseIndex}-${i}.json`)
  const units = declarationUnits(logical)
  const baseTargets = []
  const repartitionTargets = []
  for (let i = 0; i < units.length; i++) {
    const choices = units[i].family.startsWith('zone')
      ? fragmentPaths.map((_, index) => index)
      : [-1, ...fragmentPaths.map((_, index) => index)]
    const basePosition = rng.int(choices.length)
    const shift = 1 + (i % (choices.length - 1))
    baseTargets.push(choices[basePosition])
    repartitionTargets.push(choices[(basePosition + shift) % choices.length])
  }
  return { seed, caseIndex, size, logical, fragmentPaths, units, baseTargets, repartitionTargets }
}

function addDeclaration(target, unit) {
  if (unit.family === 'facts' || unit.family === 'imports') {
    target[unit.family] ||= {}
    target[unit.family][unit.key] = clone(unit.value)
  } else {
    target[unit.family] ||= []
    target[unit.family].push(clone(unit.value))
  }
}

function materialize(spec, { repartition = false, permute = false, metadata = false } = {}) {
  const scalars = ['$schema', 'out', 'symbols', 'strictSpans', 'deadlineMs', 'repoId']
  const root = { compositionVersion: 1, include: [], zones: null }
  for (const key of scalars) root[key] = spec.logical[key]
  const fragments = Object.fromEntries(spec.fragmentPaths.map((path) => [path, {}]))
  const targets = repartition ? spec.repartitionTargets : spec.baseTargets
  for (let i = 0; i < spec.units.length; i++) {
    const target = targets[i] === -1 ? root : fragments[spec.fragmentPaths[targets[i]]]
    addDeclaration(target, spec.units[i])
  }
  root.include = permute ? [...spec.fragmentPaths].reverse() : [...spec.fragmentPaths]
  if (metadata) {
    root._fuzz = { case: spec.caseIndex, seed: spec.seed, flags: [true, false, null] }
    for (let i = 0; i < spec.fragmentPaths.length; i++) {
      fragments[spec.fragmentPaths[i]]._fuzz = {
        fragment: i,
        nested: { label: `ignored-${spec.caseIndex}-${i}`, values: [i, i + 1] },
      }
    }
  }
  return { root, fragments }
}

function virtualProvider(fixture) {
  const rootBytes = jsonBytes(fixture.root)
  const fragmentBytes = new Map(Object.entries(fixture.fragments).map(([path, value]) => [path, jsonBytes(value)]))
  return {
    selectEntry() {
      return { path: '.true-up.json', kind: 'regular', bytes: rootBytes, realInside: true, tracking: 'tracked' }
    },
    inspectAndRead(path) {
      const bytes = fragmentBytes.get(path)
      if (!bytes) return { path, kind: 'missing' }
      return { path, kind: 'regular', bytes, realInside: true, tracking: 'tracked' }
    },
  }
}

function loadFixture(fixture, counters, count = true) {
  if (count) counters.loaderExecutions++
  const bundle = loadConfigBundle({
    repoRoot: '/virtual/config-composition-fuzz',
    provider: virtualProvider(fixture),
  })
  return {
    normalized: bundle.normalizedConfigBytes,
    projection: JSON.stringify(semanticProjection(bundle.config)),
  }
}

function loadValid(fixture, relation, counters, count, context) {
  try {
    return loadFixture(fixture, counters, count)
  } catch (error) {
    throw new MrFailure(relation, `valid generated fixture threw ${error.code || error.name}: ${error.message}`, {
      ...context,
      fixture,
      error: publicError(error),
    })
  }
}

function assertEquivalent(relation, source, followup, expectedProjection, context) {
  if (source.normalized !== followup.normalized || source.projection !== followup.projection || followup.projection !== expectedProjection) {
    throw new MrFailure(relation, 'production semantic projection changed under a valid transformation', {
      ...context,
      sourceNormalized: source.normalized,
      followupNormalized: followup.normalized,
      sourceProjection: source.projection,
      followupProjection: followup.projection,
      expectedProjection,
    })
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function publicError(error) {
  if (!(error instanceof ConfigLoadError)) return { name: error?.name, message: error?.message }
  return canonical({
    code: error.code,
    source: error.source,
    pointer: error.pointer,
    includeChain: error.includeChain,
    origins: error.origins,
    conflicts: error.conflicts,
    location: error.location,
    trueUpKind: error.trueUpKind,
  })
}

function captureProductionError(fixture, relation, counters, count, context) {
  try {
    loadFixture(fixture, counters, count)
  } catch (error) {
    if (error instanceof ConfigLoadError) {
      const detail = publicError(error)
      return { detail, fingerprint: JSON.stringify(detail) }
    }
    throw new MrFailure(relation, `unexpected non-config error ${error?.name}: ${error?.message}`, { ...context, fixture })
  }
  throw new MrFailure(relation, 'invalid generated fixture unexpectedly loaded', { ...context, fixture })
}

function failureFixtures(caseIndex) {
  const a = `invalid/c${caseIndex}-a.json`
  const z = `invalid/c${caseIndex}-z.json`
  const root = (include) => ({ compositionVersion: 1, include, zones: null })
  const definitions = [
    {
      variant: 'cross-source-collision',
      fragments: {
        [a]: { facts: { 'data/shared.json': [['items', 'id']] } },
        [z]: { facts: { 'data/shared.json': [['items', 'id']] } },
      },
    },
    {
      variant: 'path-before-type',
      fragments: {
        [a]: { seed: [{ from: '../escape.md', to: 'src/source.mjs' }] },
        [z]: { facts: null },
      },
    },
    {
      variant: 'type-before-type',
      fragments: {
        [a]: { facts: null },
        [z]: { zones: 'not-an-array' },
      },
    },
    {
      variant: 'invalid-nested-diamond',
      fragments: {
        [a]: { compositionVersion: 1, include: ['invalid/shared.json'], zones: null },
        [z]: { compositionVersion: 1, include: ['invalid/shared.json'], zones: null },
      },
    },
  ]
  const { variant, fragments } = definitions[caseIndex % definitions.length]
  return {
    variant,
    source: { root: root([a, z]), fragments: clone(fragments) },
    followup: { root: root([z, a]), fragments: clone(fragments) },
  }
}

function runSingleRelation(spec, relation, counters, count = true) {
  const baseFixture = materialize(spec)
  const expectedProjection = JSON.stringify(semanticProjection(spec.logical))
  if (relation === 'independent_failure_order') {
    const pair = failureFixtures(spec.caseIndex)
    const context = { seed: spec.seed, caseIndex: spec.caseIndex, size: spec.size, variant: pair.variant, sourceFixture: pair.source, followupFixture: pair.followup }
    const sourceError = captureProductionError(pair.source, relation, counters, count, context)
    const followupError = captureProductionError(pair.followup, relation, counters, count, context)
    if (sourceError.fingerprint !== followupError.fingerprint) {
      throw new MrFailure(relation, 'public failure changed when root include order changed', {
        ...context,
        sourceError: sourceError.detail,
        followupError: followupError.detail,
      })
    }
    return
  }
  let followupFixture
  if (relation === 'include_permutation_equivalence') followupFixture = materialize(spec, { permute: true })
  else if (relation === 'valid_repartition_equivalence') followupFixture = materialize(spec, { repartition: true })
  else if (relation === 'inert_underscore_metadata_equivalence') followupFixture = materialize(spec, { metadata: true })
  else if (relation === 'compound_permutation_repartition') followupFixture = materialize(spec, { repartition: true, permute: true })
  else throw new Error(`unknown relation ${relation}`)
  const context = { seed: spec.seed, caseIndex: spec.caseIndex, size: spec.size, sourceFixture: baseFixture, followupFixture }
  const source = loadValid(baseFixture, relation, counters, count, context)
  const followup = loadValid(followupFixture, relation, counters, count, context)
  assertEquivalent(relation, source, followup, expectedProjection, context)
}

function runCase(spec, counters) {
  const baseFixture = materialize(spec)
  const expectedProjection = JSON.stringify(semanticProjection(spec.logical))
  const base = loadValid(baseFixture, VALID_RELATIONS[0], counters, true, {
    seed: spec.seed,
    caseIndex: spec.caseIndex,
    size: spec.size,
    sourceFixture: baseFixture,
  })
  if (base.projection !== expectedProjection) {
    throw new MrFailure('valid_repartition_equivalence', 'generated source partition did not reconstruct the logical config', {
      seed: spec.seed,
      caseIndex: spec.caseIndex,
      size: spec.size,
      sourceFixture: baseFixture,
      sourceProjection: base.projection,
      expectedProjection,
    })
  }
  const transformations = [
    ['include_permutation_equivalence', materialize(spec, { permute: true })],
    ['valid_repartition_equivalence', materialize(spec, { repartition: true })],
    ['inert_underscore_metadata_equivalence', materialize(spec, { metadata: true })],
    ['compound_permutation_repartition', materialize(spec, { repartition: true, permute: true })],
  ]
  for (const [relation, followupFixture] of transformations) {
    const context = { seed: spec.seed, caseIndex: spec.caseIndex, size: spec.size, sourceFixture: baseFixture, followupFixture }
    const followup = loadValid(followupFixture, relation, counters, true, context)
    assertEquivalent(relation, base, followup, expectedProjection, context)
    counters.checks[relation]++
  }
  runSingleRelation(spec, 'independent_failure_order', counters, true)
  counters.checks.independent_failure_order++
}

function relationDetectsDifference(sourceFixture, mutantFixture) {
  const counters = { loaderExecutions: 0 }
  try {
    const source = loadFixture(sourceFixture, counters, false)
    const mutant = loadFixture(mutantFixture, counters, false)
    return source.normalized !== mutant.normalized || source.projection !== mutant.projection
  } catch (error) {
    return error instanceof ConfigLoadError
  }
}

function runMutationSensitivityChecks() {
  const a = 'mutants/a.json'
  const b = 'mutants/b.json'
  const base = {
    root: { compositionVersion: 1, include: [a, b], zones: null },
    fragments: {
      [a]: { facts: { 'data/mutant.json': [['items', 'id']] } },
      [b]: { seed: [{ from: 'docs/mutant.md', to: 'data/mutant.json#items.one' }] },
    },
  }
  const includeDrop = clone(base)
  includeDrop.root.include = [a]
  const duplicateOwner = clone(base)
  duplicateOwner.fragments[b].facts = clone(base.fragments[a].facts)
  const visibleMetadata = clone(base)
  visibleMetadata.fragments[a].metadata = { should: 'not-be-inert' }
  const compoundDrop = clone(base)
  compoundDrop.root.include.reverse()
  delete compoundDrop.fragments[b].seed
  const failurePair = failureFixtures(1)
  const changedWinner = clone(failurePair.followup)
  changedWinner.fragments[Object.keys(changedWinner.fragments).sort()[0]] = {}
  const counters = { loaderExecutions: 0 }
  const firstError = captureProductionError(failurePair.source, 'mutation-self-check', counters, false, {})
  const changedError = captureProductionError(changedWinner, 'mutation-self-check', counters, false, {})
  const originalFailure = new MrFailure('minimizer-probe', 'same root cause', {
    error: { code: 'probe-a' },
    sourceFixture: { root: { include: ['a', 'b'] }, fragments: { a: { facts: { one: [['x', 'id']] } }, b: { seed: [{ from: 'a', to: 'b' }] } } },
  })
  const smallerSameFailure = new MrFailure('minimizer-probe', 'same root cause', {
    error: { code: 'probe-a' },
    sourceFixture: { root: { include: ['a'] }, fragments: { a: {} } },
  })
  const smallerDifferentFailure = new MrFailure('minimizer-probe', 'same root cause', {
    error: { code: 'probe-b' },
    sourceFixture: { root: { include: ['a'] }, fragments: { a: {} } },
  })
  const checks = {
    include_drop: relationDetectsDifference(base, includeDrop),
    duplicate_repartition_owner: relationDetectsDifference(base, duplicateOwner),
    non_underscore_metadata: relationDetectsDifference(base, visibleMetadata),
    compound_declaration_drop: relationDetectsDifference(base, compoundDrop),
    changed_failure_winner: firstError.fingerprint !== changedError.fingerprint,
    minimizer_accepts_same_root_reduction: acceptableReduction(originalFailure, smallerSameFailure),
    minimizer_rejects_changed_root: !acceptableReduction(originalFailure, smallerDifferentFailure),
    minimizer_rejects_non_reduction: !acceptableReduction(originalFailure, originalFailure),
  }
  for (const [name, caught] of Object.entries(checks)) {
    if (!caught) throw new Error(`metamorphic self-check failed to catch planted mutant ${name}`)
  }
  return checks
}

function parserBenchmark(executions) {
  const fixture = {
    root: { compositionVersion: 1, include: ['bench.json'], zones: null },
    fragments: { 'bench.json': { facts: { 'data/bench.json': [['items', 'id']] } } },
  }
  const provider = virtualProvider(fixture)
  let checksum = 0
  for (let i = 0; i < 100; i++) {
    const bundle = loadConfigBundle({ repoRoot: '/virtual/config-composition-fuzz', provider })
    checksum ^= bundle.normalizedConfigBytes.length
  }
  const cpuStarted = process.cpuUsage()
  const started = performance.now()
  for (let i = 0; i < executions; i++) {
    const bundle = loadConfigBundle({ repoRoot: '/virtual/config-composition-fuzz', provider })
    checksum = (checksum + bundle.normalizedConfigBytes.length) >>> 0
  }
  const elapsedMs = performance.now() - started
  const cpu = process.cpuUsage(cpuStarted)
  const cpuMs = (cpu.user + cpu.system) / 1_000
  const wallExecutionsPerSecond = executions / (elapsedMs / 1_000)
  const cpuExecutionsPerSecond = executions / (cpuMs / 1_000)
  return {
    executions,
    elapsedMs,
    cpuMs,
    wallExecutionsPerSecond,
    cpuExecutionsPerSecond,
    executionsPerSecond: cpuExecutionsPerSecond,
    floorBasis: 'process-cpu-time',
    checksum,
  }
}

function failureFingerprint(failure) {
  return JSON.stringify(canonical({
    relation: failure.relation || 'harness',
    message: failure.message,
    errorCode: failure.context?.error?.code || failure.context?.error?.name || null,
    sourceErrorCode: failure.context?.sourceError?.code || null,
    followupErrorCode: failure.context?.followupError?.code || null,
  }))
}

function failureComplexity(failure) {
  const fixtures = {
    sourceFixture: failure.context?.sourceFixture || failure.context?.fixture || null,
    followupFixture: failure.context?.followupFixture || null,
  }
  return JSON.stringify(fixtures).length
}

function acceptableReduction(originalFailure, candidateFailure) {
  return candidateFailure instanceof MrFailure
    && failureFingerprint(candidateFailure) === failureFingerprint(originalFailure)
    && failureComplexity(candidateFailure) < failureComplexity(originalFailure)
}

function minimizedCounterexample(seed, caseIndex, originalSize, originalFailure) {
  const dummyCounters = { loaderExecutions: 0, checks: Object.fromEntries(MR_MATRIX.map(({ id }) => [id, 0])) }
  const targetFingerprint = failureFingerprint(originalFailure)
  const originalComplexity = failureComplexity(originalFailure)
  let best = null
  for (let candidateSize = 1; candidateSize <= originalSize; candidateSize++) {
    const candidate = generateSpec(seed, caseIndex, candidateSize)
    try {
      runSingleRelation(candidate, originalFailure.relation, dummyCounters, false)
    } catch (error) {
      const complexity = error instanceof MrFailure ? failureComplexity(error) : Number.POSITIVE_INFINITY
      if (acceptableReduction(originalFailure, error) && (!best || complexity < best.complexity)) {
        best = { size: candidateSize, failure: error, complexity }
      }
    }
  }
  return { best, originalComplexity, targetFingerprint }
}

function persistCounterexample(options, failure, seed, caseIndex, size) {
  mkdirSync(options.artifacts, { recursive: true })
  const minimization = failure instanceof MrFailure
    ? minimizedCounterexample(seed, caseIndex, size, failure)
    : null
  const minimized = minimization?.best || null
  const artifact = {
    schema: 'true-up-config-composition-counterexample/v1',
    relation: failure.relation || 'harness',
    seed,
    seedHex: `0x${seed.toString(16).padStart(8, '0')}`,
    caseIndex,
    originalSize: size,
    minimizedSize: minimized?.size ?? size,
    minimization: {
      attempted: failure instanceof MrFailure,
      result: minimized ? 'reduced' : 'irreducible',
      fingerprint: minimization?.targetFingerprint || failureFingerprint(failure),
      originalComplexity: minimization?.originalComplexity ?? failureComplexity(failure),
      minimizedComplexity: minimized?.complexity ?? failureComplexity(failure),
    },
    message: failure.message,
    original: failure.context || null,
    minimized: minimized?.failure.context || failure.context || null,
    replay: `node tests/config-composition-fuzz.mjs --seed 0x${seed.toString(16)} --replay ${caseIndex} --size ${minimized?.size ?? size}`,
  }
  const safeRelation = String(artifact.relation).replace(/[^a-z0-9_-]/gi, '-')
  const path = join(options.artifacts, `${artifact.seedHex.slice(2)}-${caseIndex}-${safeRelation}.json`)
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
  return path
}

function writeReport(path, report) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
}

function run(options) {
  mkdirSync(options.scratch, { recursive: true })
  const disposable = mkdtempSync(join(options.scratch, 'run-'))
  const counters = {
    loaderExecutions: 0,
    checks: Object.fromEntries(MR_MATRIX.map(({ id }) => [id, 0])),
  }
  const cases = []
  for (const seed of options.seeds) {
    if (options.replay !== null) {
      const size = options.size || (1 + (mixSeed(seed, options.replay, 1) % 8))
      cases.push({ seed, caseIndex: options.replay, size })
    } else {
      for (let caseIndex = 0; caseIndex < options.cases; caseIndex++) {
        const size = 1 + (mixSeed(seed, caseIndex, 1) % 8)
        cases.push({ seed, caseIndex, size })
      }
    }
  }
  const started = performance.now()
  let active = null
  let counterexample = null
  try {
    for (active of cases) runCase(generateSpec(active.seed, active.caseIndex, active.size), counters)
    const elapsedMs = performance.now() - started
    active = null
    const mutationSensitivity = runMutationSensitivityChecks()
    const benchmark = parserBenchmark(options.benchExecutions)
    if (benchmark.executionsPerSecond < PARSER_FLOOR_PER_SECOND) {
      throw new Error(`pure parser throughput ${benchmark.executionsPerSecond.toFixed(1)}/s is below ${PARSER_FLOOR_PER_SECOND}/s`)
    }
    rmSync(disposable, { recursive: true, force: true })
    const report = {
      ok: true,
      schema: 'true-up-config-composition-fuzz-report/v1',
      seeds: options.seeds.map((seed) => ({ value: seed, hex: `0x${seed.toString(16).padStart(8, '0')}` })),
      caseCount: cases.length,
      casesPerSeed: options.replay === null ? options.cases : null,
      replayCase: options.replay,
      loaderExecutions: counters.loaderExecutions,
      campaignElapsedMs: elapsedMs,
      campaignExecutionsPerSecond: counters.loaderExecutions / (elapsedMs / 1_000),
      checks: counters.checks,
      metamorphicMatrix: MR_MATRIX,
      mutationSensitivity,
      parserBenchmark: { ...benchmark, floorPerSecond: PARSER_FLOOR_PER_SECOND },
      bounds: { maxGeneratedSize: 8, maxFragments: 6, maxFacts: 5, maxZones: 5, maxSeedEdges: 6, maxImports: 3, maxExports: 4 },
      scratchCleaned: true,
      replayTemplate: 'node tests/config-composition-fuzz.mjs --seed <seed> --replay <case-index> [--size <minimized-size>]',
    }
    writeReport(options.report, report)
    return report
  } catch (error) {
    rmSync(disposable, { recursive: true, force: true })
    if (active) counterexample = persistCounterexample(options, error, active.seed, active.caseIndex, active.size)
    const report = {
      ok: false,
      schema: 'true-up-config-composition-fuzz-report/v1',
      error: { name: error.name, message: error.message, relation: error.relation || null },
      activeCase: active,
      counterexample,
      loaderExecutions: counters.loaderExecutions,
      checks: counters.checks,
      metamorphicMatrix: MR_MATRIX,
      scratchCleaned: true,
    }
    writeReport(options.report, report)
    const wrapped = new Error(JSON.stringify(report, null, 2))
    wrapped.cause = error
    throw wrapped
  }
}

let options
try {
  options = parseOptions(process.argv.slice(2))
  if (options) {
    const report = run(options)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
}
