#!/usr/bin/env node
// Wave 4 Track A — machine-readable config-composition contract and discoverability gate.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPOSITION_LIMITS, CONFIG_COMPOSITION_ERROR_CODES } from '../lib/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const ENTRY = join(REPO, 'bin/true-up')
const scratchBase = resolve(process.env.TRUE_UP_CONFIG_CAPABILITIES_SCRATCH
  || join(homedir(), 'scratch', 'true-up-config-composition', 'capabilities-tests'))
mkdirSync(scratchBase, { recursive: true })
const runRoot = mkdtempSync(join(scratchBase, 'run-'))
const hostile = join(runRoot, 'outside-repo-with-broken-config')
mkdirSync(join(hostile, 'config'), { recursive: true })
writeFileSync(join(hostile, '.true-up.json'), `${JSON.stringify({ compositionVersion: 1, include: ['config/broken.json'], zones: null })}\n`)
writeFileSync(join(hostile, 'config/broken.json'), '{"seed":[')
writeFileSync(join(hostile, 'sentinel'), 'UNCHANGED\n')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const command = (args, cwd = hostile) => spawnSync(process.execPath, [ENTRY, ...args], {
  cwd,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
})
const assertRun = (result, label, expected = 0) => {
  assert.equal(result.error, undefined, `${label}: ${result.error}`)
  assert.equal(result.status, expected, `${label}: rc=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  return result
}
const json = (result, label) => {
  assertRun(result, label)
  try { return JSON.parse(result.stdout) }
  catch (error) { assert.fail(`${label}: stdout was not JSON: ${error}\n${result.stdout}`) }
}
const tree = (root) => {
  const out = {}
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, rel)
      else out[rel] = sha256(readFileSync(path))
    }
  }
  walk(root)
  return out
}

const before = tree(hostile)
const help = assertRun(command(['--help']), 'help outside repo with broken config').stdout
const robot = assertRun(command(['robot-docs']), 'robot docs outside repo with broken config').stdout
const robotJson = json(command(['robot-docs', '--json']), 'robot docs JSON outside repo with broken config')
const capabilities = json(command(['capabilities']), 'capabilities outside repo with broken config')
const capabilitiesJson = json(command(['capabilities', '--json']), 'capabilities --json outside repo with broken config')
assert.deepEqual(tree(hostile), before, 'config-independent contract commands traversed or mutated the hostile fixture')
assert.equal(existsSync(join(hostile, '.true-up')), false, 'config-independent contract command created graph state')
assert.deepEqual(capabilitiesJson, capabilities, 'capabilities differs when redundant --json is present')
assert.equal(robotJson.guide, robot)

const expectedComposition = {
  schema_version: 1,
  activation: {
    entry_precedence: ['.true-up.json', 'true-up.config.json'],
    intent_if_any: ['own:compositionVersion', 'own:include', 'effective:zones===null'],
    sentinel: {
      compositionVersion: 1,
      include: { type: 'array', items: 'string', minItems: 1 },
      zones: null,
    },
    invalid_sentinel: { behavior: 'fail-closed', detail_code: 'composition-sentinel-invalid', legacy_fallback: false },
  },
  keys: {
    root: ['$schema', 'compositionVersion', 'deadlineMs', 'exports', 'facts', 'imports', 'include', 'out', 'repoId', 'seed', 'strictSpans', 'symbols', 'zones'],
    fragment: ['exports', 'facts', 'imports', 'seed', 'zones'],
    root_only: ['$schema', 'compositionVersion', 'deadlineMs', 'include', 'out', 'repoId', 'strictSpans', 'symbols'],
    root_declarations: ['exports', 'facts', 'imports', 'seed'],
    fragment_declarations: ['exports', 'facts', 'imports', 'seed', 'zones'],
    root_zone_value: null,
    fragment_zone_type: 'array',
    inert_metadata_prefix: '_',
    unknown_non_metadata: 'reject',
  },
  includes: {
    mode: 'literal-one-level',
    discovery: 'none',
    globs: false,
    recursive: false,
    max_depth: 1,
    max_count: COMPOSITION_LIMITS.maxIncludes,
    max_total_bytes: COMPOSITION_LIMITS.maxIncludedBytes,
    canonical_order: 'utf8-byte-ascending-normalized-repo-relative-path',
  },
  merge: {
    canonical_source_order: 'utf8-byte-ascending-repo-relative-path',
    manifest_order_semantic: false,
    source_local_array_order: 'preserved',
    source_local_multiplicity: 'preserved',
    cross_source: 'single-owner-fail-closed',
    conflict_identities: {
      facts: 'normalized-fact-source-path',
      zones: 'normalized-zone-path',
      seed: 'tuple(normalized-from,normalized-to)',
      imports: 'alias',
      exports: 'id',
    },
    provenance: {
      declaration_origin_fields: ['source', 'pointer'],
      conflict_fields: ['identity', 'origins'],
      source_paths: 'repo-relative',
      absolute_paths: false,
      raw_values: false,
    },
  },
  paths: {
    base: 'selected-worktree-root',
    separator: '/',
    absolute: 'reject',
    lexical_escape: 'reject',
    realpath_escape: 'reject',
    symlinks: 'reject-any-component',
    regular_files_only: true,
    ignored: 'reject',
    forbidden_roots: ['.git', '.jj', '.true-up'],
  },
  workspace: {
    linked_worktrees: 'isolated-by-selected-root',
    graph_cache: 'per-worktree',
    working_tree_untracked: 'read-and-report',
    git_committed_source: 'selected-worktree-index-only-no-head-fallback',
    jj_committed_source: '@',
    committed_untracked_or_unstaged: 'fail-closed',
    committed_revalidation: 'before-and-after-source-hash',
  },
  migration: {
    mode: 'manual-v1',
    command: null,
    hidden_migrator: false,
    structural_only: true,
    preserve: ['source-local-array-order', 'source-local-multiplicity', 'existing-graph-semantics'],
    rollback: {
      mode: 'restore-prior-flat-config',
      fragments: 'leave-unreferenced-or-remove',
      graph: 'rebuild-from-restored-flat-config',
    },
  },
  compatibility: {
    old_loader_guard: {
      sentinel: 'zones:null',
      expected_behavior: 'exit-2-fail-closed',
      verified_against: ['0.1.4', 'pre-composition-0.2.1'],
    },
    unsupported_version: { behavior: 'fail-closed', detail_code: 'composition-sentinel-invalid', legacy_fallback: false },
  },
  inspection: {
    graph: {
      composition_fields: ['compositionVersion', 'entry', 'fragmentCount', 'includedBytes', 'sourceCount'],
      config_source_fields: ['path', 'role', 'bytes', 'hash'],
      edge_provenance_field: 'declaredIn',
      edge_provenance_fields: ['source', 'pointer'],
    },
    status: {
      composition_fields: ['compositionVersion', 'entry', 'fragmentCount', 'includedBytes', 'sourceCount'],
      config_source_fields: ['path', 'role', 'bytes', 'hash', 'state'],
      warning_field: 'configSourceWarnings',
    },
  },
  error_contract: {
    top_level_kind: 'invalid-config',
    detail_code_field: 'detail.code',
    public_detail_fields: ['code', 'source', 'pointer', 'includeChain', 'origins', 'location', 'conflicts'],
    inventory_field: 'config_composition.error_codes',
  },
  error_codes: [...CONFIG_COMPOSITION_ERROR_CODES],
}

assert.equal(Object.isFrozen(CONFIG_COMPOSITION_ERROR_CODES), true, 'production error inventory must stay frozen')
assert.deepEqual(capabilities.config_composition, expectedComposition, 'capabilities config-composition contract drifted')
assert.deepEqual(capabilities.config_composition.error_codes, [...CONFIG_COMPOSITION_ERROR_CODES], 'capabilities omitted/reordered a production composition detail code')
assert.equal(new Set(capabilities.config_composition.error_codes).size, CONFIG_COMPOSITION_ERROR_CODES.length, 'composition error inventory contains duplicates')

for (const [surface, output] of [['help', help], ['robot-docs', robot]]) {
  assert.match(output, /compositionVersion/, `${surface} omits composition activation`)
  assert.match(output, /zones["']?\s*:\s*null/, `${surface} omits old-loader fail-closed sentinel`)
  assert.match(output, /literal/i, `${surface} omits literal include semantics`)
  assert.match(output, /manual/i, `${surface} omits manual migration`)
  assert.match(output, /rollback/i, `${surface} omits rollback`)
  assert.match(output, /config_composition/, `${surface} does not point to the machine contract field`)
}
assert.match(robot, /256/, 'robot docs omit include-count bound')
assert.match(robot, /32 MiB/, 'robot docs omit aggregate-byte bound')

const generated = JSON.parse(readFileSync(join(REPO, 'meta/contract.json'), 'utf8'))
const expectedFacts = Object.entries(expectedComposition)
  .map(([name, value]) => ({ name, value }))
  .sort((a, b) => a.name.localeCompare(b.name))
assert.deepEqual(generated.config_composition, expectedFacts, 'generated composition facts do not exactly derive from capabilities')
assert(generated.commands.some((item) => item.name === 'capabilities'), 'generated command facts regressed')
assert.deepEqual(generated.agent_guidance.map((item) => item.name), ['declared-seed-edge'], 'existing generated agent guidance regressed')

assertRun(spawnSync(process.execPath, [join(REPO, 'meta/build-contract.mjs'), '--check'], {
  cwd: REPO,
  encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
}), 'generated contract --check')

rmSync(runRoot, { recursive: true, force: true })
assert.equal(existsSync(runRoot), false, 'fixture cleanup failed')
process.stdout.write(`config composition capabilities: PASS; schema=${expectedComposition.schema_version}; detail-codes=${CONFIG_COMPOSITION_ERROR_CODES.length}; fixtures-cleaned=true\n`)
