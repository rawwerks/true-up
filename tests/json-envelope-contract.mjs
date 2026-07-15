#!/usr/bin/env node
// Contract regression: every command advertised as JSON-capable emits exactly one JSON object
// with the uniform {_v, ok} envelope. This drives the production CLI process; it does not import
// engine internals. Fixtures and the machine-readable report live under the configured scratch root.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SOURCE_CLI = join(ROOT, 'bin', 'true-up')
const SCRATCH = process.env.TRUE_UP_JSON_ENVELOPE_SCRATCH
  ? resolve(process.env.TRUE_UP_JSON_ENVELOPE_SCRATCH)
  : join(homedir(), 'scratch', 'true-up-json-envelope-agent')

mkdirSync(SCRATCH, { recursive: true })
const RUN = mkdtempSync(join(SCRATCH, 'run-'))
const EMPTY_GIT_CONFIG = join(RUN, 'empty-gitconfig')
writeFileSync(EMPTY_GIT_CONFIG, '')

const BASE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  NODE_PATH: '',
  TRUE_UP_DEADLINE_MS: '30000',
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...BASE_ENV, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function runAsync(command, args, options = {}) {
  return new Promise((done) => {
    execFile(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...BASE_ENV, ...(options.env || {}) },
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      done({
        command,
        args,
        status: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        signal: error && error.signal ? error.signal : null,
        error: error && !Number.isInteger(error.code) ? error.message : null,
        stdout,
        stderr,
      })
    })
  })
}

const cli = (args, options) => run(process.execPath, [SOURCE_CLI, ...args], options)

function git(repo, args) {
  const r = run('git', ['-C', repo, ...args], { cwd: repo })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function initRepo(repo, { leak = false, symbols = false } = {}) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'json-envelope@example.invalid'])
  git(repo, ['config', 'user.name', 'JSON Envelope Harness'])

  if (symbols) {
    writeJson(join(repo, '.true-up.json'), {
      symbols: true,
      zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] }],
      seed: [],
    })
    writeFileSync(join(repo, 'source.py'), 'def answer():\n    return 42\n')
  } else {
    writeJson(join(repo, '.true-up.json'), {
      out: '.true-up/depgraph.json',
      repoId: 'json-envelope-fixture',
      facts: { 'data.json': [['items', 'id']] },
      zones: [{
        path: '',
        visibility: 'public',
        audience: 'world',
        intent: 'public',
        rules: ['no-machine-local-paths'],
      }],
      seed: [{ from: 'doc.md', to: 'data.json#items.a', kind: 'derives-facts-from' }],
      exports: [{ id: 'item-a', from: 'data.json#items.a', audience: 'public' }],
    })
    writeJson(join(repo, 'data.json'), { items: [{ id: 'a', value: 1 }] })
    writeFileSync(join(repo, 'doc.md'), '# Fixture\n')
    if (leak) writeFileSync(join(repo, 'leak.txt'), `machine-local source is ${join('/', 'home', 'example', 'private.txt')}\n`)
  }

  git(repo, ['add', '.'])
  git(repo, ['commit', '--no-verify', '-qm', 'fixture'])
}

function initRawRepo(repo, files) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'json-envelope@example.invalid'])
  git(repo, ['config', 'user.name', 'JSON Envelope Harness'])
  for (const [name, content] of Object.entries(files)) {
    const path = join(repo, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  git(repo, ['add', '.'])
  git(repo, ['commit', '--no-verify', '-qm', 'fixture'])
}

const successRepo = join(RUN, 'success-repo')
const failureRepo = join(RUN, 'failure-repo')
const symbolsRepo = join(RUN, 'symbols-repo')
const invalidConfigRepo = join(RUN, 'invalid-config-repo')
const brokenGraphRepo = join(RUN, 'broken-graph-repo')
const outsideRepo = join(RUN, 'outside-repo')
const externalHooks = join(RUN, 'external-hooks')
mkdirSync(outsideRepo, { recursive: true })
mkdirSync(externalHooks, { recursive: true })
initRepo(successRepo)
initRepo(failureRepo, { leak: true })
initRepo(symbolsRepo, { symbols: true })
initRawRepo(invalidConfigRepo, {
  '.true-up.json': '{ "zones": null }\n',
  'README.md': '# Invalid config fixture\n',
})
initRawRepo(brokenGraphRepo, {
  '.true-up.json': JSON.stringify({
    repoId: 'broken-graph-fixture',
    zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'public', rules: [] }],
    seed: [{ from: 'doc.md', to: 'missing.json', kind: 'derives-facts-from' }],
    exports: [{ id: 'doc', from: 'doc.md', audience: 'public' }],
  }, null, 2) + '\n',
  'doc.md': '# Broken graph fixture\n',
})

// Build and commit the success fixture's graph so both working-tree and --committed checks are green.
const setupBuild = cli(['--repo', successRepo, 'build'])
if (setupBuild.status !== 0) {
  throw new Error(`fixture graph build failed (${setupBuild.status}): ${setupBuild.stderr || setupBuild.stdout}`)
}
git(successRepo, ['add', '.true-up/depgraph.json'])
git(successRepo, ['commit', '--no-verify', '-qm', 'track graph'])

// Simulate a packed, zero-optional-dependency install. Module resolution begins under this scratch
// tree, not the source checkout's node_modules, so symbols:true must exercise the fail-loud path.
const bareTool = join(RUN, 'bare-tool')
mkdirSync(bareTool, { recursive: true })
cpSync(join(ROOT, 'bin'), join(bareTool, 'bin'), { recursive: true })
cpSync(join(ROOT, 'lib'), join(bareTool, 'lib'), { recursive: true })
cpSync(join(ROOT, 'package.json'), join(bareTool, 'package.json'))
const BARE_CLI = join(bareTool, 'bin', 'true-up')

const rawCapabilities = cli(['capabilities', '--json'], { cwd: outsideRepo })
let capabilities = null
try { capabilities = JSON.parse(rawCapabilities.stdout.trim()) } catch {}
if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
  throw new Error(`cannot derive JSON command inventory from capabilities: rc=${rawCapabilities.status} stdout=${rawCapabilities.stdout.slice(0, 300)} stderr=${rawCapabilities.stderr.slice(0, 300)}`)
}
const contractVersion = capabilities.contract_version

const cases = [
  // Every json:true command advertised by capabilities (canonical coverage keys are checked below).
  { id: 'capabilities', key: 'capabilities', args: ['capabilities', '--json'], cwd: outsideRepo, exit: 0, ok: true },
  { id: 'robot-docs', key: 'robot-docs', args: ['robot-docs', '--json'], cwd: outsideRepo, exit: 0, ok: true },
  { id: 'version-flag', key: '--version', args: ['--version', '--json'], cwd: outsideRepo, exit: 0, ok: true },
  { id: 'status', key: 'status', args: ['--repo', successRepo, 'status', '--json'], exit: 0, ok: true },
  { id: 'status-since', args: ['--repo', successRepo, 'status', '--since', 'HEAD', '--json'], exit: 0, ok: true },
  { id: 'graph', key: 'graph', args: ['--repo', successRepo, 'graph', '--json'], exit: 0, ok: true },
  { id: 'build-no-write', key: 'build', args: ['--repo', successRepo, 'build', '--no-write', '--json'], exit: 0, ok: true },
  { id: 'bare-build-no-write', key: '(no args)', args: ['--repo', successRepo, '--no-write', '--json'], exit: 0, ok: true },
  { id: 'check-worktree', key: '--check', args: ['--repo', successRepo, '--check', '--json'], exit: 0, ok: true },
  { id: 'check-committed', args: ['--repo', successRepo, '--check', '--committed', '--json'], exit: 0, ok: true },
  { id: 'impact-target', key: '--impact', args: ['--repo', successRepo, '--impact', 'data.json#items.a', '--json'], exit: 0, ok: true },
  { id: 'impact-proof', args: ['--repo', successRepo, '--impact', '--since', 'HEAD', '--proof', '--json'], exit: 0, ok: true },
  { id: 'policy', key: '--policy', args: ['--repo', successRepo, '--policy', '--json'], exit: 0, ok: true },
  { id: 'policy-report', args: ['--repo', successRepo, '--policy', '--report', '--json'], exit: 0, ok: true },
  { id: 'externalities', key: '--externalities', args: ['--repo', successRepo, '--externalities', '--json'], exit: 0, ok: true },
  { id: 'externalities-report', args: ['--repo', successRepo, '--externalities', '--report', '--json'], exit: 0, ok: true },
  { id: 'verify-scope', key: '--verify-scope', args: ['--repo', successRepo, '--verify-scope', '--since', 'HEAD', '--json'], exit: 0, ok: true },
  { id: 'run-dry', key: 'run', args: ['--repo', successRepo, 'run', '--since', 'HEAD', '--no-write', '--json'], exit: 0, ok: true },
  { id: 'run-strict-dry', args: ['--repo', successRepo, 'run', '--since', 'HEAD', '--strict', '--no-write', '--json'], exit: 0, ok: true },
  { id: 'gate', key: 'gate', args: ['--repo', successRepo, 'gate', '--json'], exit: 0, ok: true },
  { id: 'gate-committed', args: ['--repo', successRepo, 'gate', '--committed', '--json'], exit: 0, ok: true },
  { id: 'hooks-dry', key: 'hooks', args: ['--repo', successRepo, 'hooks', '--json'], exit: 0, ok: true },
  { id: 'hooks-ci', args: ['--repo', successRepo, 'hooks', '--ci', '--json'], exit: 0, ok: true },
  { id: 'hooks-install', serial: 'normal-hooks', args: ['--repo', successRepo, 'hooks', '--install', '--json'], exit: 0, ok: true },
  { id: 'hooks-uninstall', serial: 'normal-hooks', args: ['--repo', successRepo, 'hooks', '--uninstall', '--json'], exit: 0, ok: true },
  { id: 'export', key: 'export', args: ['--repo', successRepo, 'export', '--audience', 'public', '--json'], exit: 0, ok: true },

  // Documented aliases that are intentionally not separate capability rows.
  { id: 'robot-help-alias', args: ['--robot-help', '--json'], cwd: outsideRepo, exit: 0, ok: true },
  { id: 'version-word-alias', args: ['version', '--json'], cwd: outsideRepo, exit: 0, ok: true },
  { id: 'version-short-alias', args: ['-v', '--json'], cwd: outsideRepo, exit: 0, ok: true },

  // Gate/usage failures: stdout remains one envelope; diagnostics, when required, stay on stderr.
  { id: 'status-missing-since-value', usageGuard: 'status-missing-since-value', args: ['--repo', successRepo, 'status', '--since', '--json'], exit: 2, ok: false, kind: 'missing-flag-value', diagnostic: true },
  { id: 'verify-scope-missing-since-value', usageGuard: 'verify-scope-missing-since-value', args: ['--repo', successRepo, '--verify-scope', '--since', '--json'], exit: 2, ok: false, kind: 'missing-flag-value', diagnostic: true },
  { id: 'run-missing-since-value', usageGuard: 'run-missing-since-value', args: ['--repo', successRepo, 'run', '--since', '--no-write', '--json'], exit: 2, ok: false, kind: 'missing-flag-value', diagnostic: true },
  { id: 'repo-missing-value-tail', usageGuard: 'repo-missing-value-tail', args: ['status', '--json', '--repo'], cwd: successRepo, exit: 2, ok: false, kind: 'missing-flag-value', diagnostic: true },
  { id: 'capabilities-stray-positional', usageGuard: 'capabilities-stray-positional', args: ['capabilities', 'stray', '--json'], cwd: outsideRepo, exit: 2, ok: false, kind: 'unexpected-arg', diagnostic: true },
  { id: 'version-stray-positional', usageGuard: 'version-stray-positional', args: ['version', 'stray', '--json'], cwd: outsideRepo, exit: 2, ok: false, kind: 'unexpected-arg', diagnostic: true },
  { id: 'status-bad-ref', args: ['--repo', successRepo, 'status', '--since', 'not-a-ref', '--json'], exit: 2, ok: false, kind: 'bad-ref', diagnostic: true },
  { id: 'status-outside-vcs', args: ['status', '--json'], cwd: outsideRepo, exit: 2, ok: false, kind: 'not-a-vcs-repo', diagnostic: true },
  { id: 'graph-invalid-config', args: ['--repo', invalidConfigRepo, 'graph', '--json'], exit: 2, ok: false, kind: 'invalid-config', diagnostic: true },
  { id: 'graph-build-error', args: ['--repo', brokenGraphRepo, 'graph', '--json'], exit: 1, ok: false, kind: 'graph-build-errors', diagnostic: true },
  { id: 'impact-build-error-no-write', args: ['--repo', brokenGraphRepo, '--impact', 'doc.md', '--no-write', '--json'], exit: 1, ok: false, kind: 'graph-build-errors', diagnostic: true },
  { id: 'verify-scope-build-error', args: ['--repo', brokenGraphRepo, '--verify-scope', '--since', 'HEAD', '--json'], exit: 1, ok: false, kind: 'graph-build-errors', diagnostic: true },
  { id: 'run-build-error-no-write', args: ['--repo', brokenGraphRepo, 'run', '--since', 'HEAD', '--no-write', '--json'], exit: 1, ok: false, kind: 'graph-build-errors', diagnostic: true },
  { id: 'impact-unknown', args: ['--repo', successRepo, '--impact', 'missing.file', '--json'], exit: 2, ok: false, kind: 'unknown-target', diagnostic: true },
  { id: 'check-not-built', args: ['--repo', failureRepo, '--check', '--json'], exit: 1, ok: false, kind: 'stale-graph' },
  { id: 'policy-violation', args: ['--repo', failureRepo, '--policy', '--json'], exit: 1, ok: false, kind: 'policy-violation' },
  { id: 'policy-violation-report', args: ['--repo', failureRepo, '--policy', '--report', '--json'], exit: 0, ok: false, kind: 'policy-violation' },
  { id: 'externalities-violation', args: ['--repo', failureRepo, '--externalities', '--json'], exit: 1, ok: false, kind: 'externalities-violation' },
  { id: 'externalities-violation-report', args: ['--repo', failureRepo, '--externalities', '--report', '--json'], exit: 0, ok: false, kind: 'externalities-violation' },
  { id: 'verify-scope-bad-ref', args: ['--repo', successRepo, '--verify-scope', '--since', 'not-a-ref', '--json'], exit: 2, ok: false, kind: 'bad-ref', diagnostic: true },
  { id: 'run-bad-ref', args: ['--repo', successRepo, 'run', '--since', 'not-a-ref', '--no-write', '--json'], exit: 2, ok: false, kind: 'bad-ref', diagnostic: true },
  { id: 'gate-failure', args: ['--repo', failureRepo, 'gate', '--json'], exit: 1, ok: false, kind: 'gate-failed' },
  { id: 'export-missing-audience', args: ['--repo', successRepo, 'export', '--json'], exit: 2, ok: false, kind: 'usage', diagnostic: true },
  { id: 'export-build-error', args: ['--repo', brokenGraphRepo, 'export', '--audience', 'public', '--json'], exit: 1, ok: false, kind: 'graph-build-errors', diagnostic: true },
  { id: 'unknown-command', args: ['--repo', successRepo, 'not-a-command', '--json'], exit: 2, ok: false, kind: 'unknown-command', diagnostic: true },
  { id: 'unknown-flag', args: ['--repo', successRepo, '--check', '--comitted', '--json'], exit: 2, ok: false, kind: 'unknown-flag', diagnostic: true },
  {
    id: 'symbols-optional-deps-absent',
    contractKey: 'graph',
    command: process.execPath,
    commandArgs: [BARE_CLI, '--repo', symbolsRepo, 'graph', '--json'],
    exit: 2,
    ok: false,
    kind: 'symbols-unavailable',
    diagnostic: true,
  },
]

// Hooks external-dir refusal and explicit --force are stateful, so run them after configuring the
// isolated failure fixture. The path is inside this harness's scratch run, never a real shared dir.
git(failureRepo, ['config', '--local', 'core.hooksPath', externalHooks])
cases.push(
  { id: 'hooks-external-refusal', serial: 'external-hooks', args: ['--repo', failureRepo, 'hooks', '--install', '--json'], exit: 2, ok: false, kind: 'hooks-dir-outside-repo', diagnostic: true },
  { id: 'hooks-external-force-install', serial: 'external-hooks', args: ['--repo', failureRepo, 'hooks', '--install', '--force', '--json'], exit: 0, ok: true },
  { id: 'hooks-external-force-uninstall', serial: 'external-hooks', args: ['--repo', failureRepo, 'hooks', '--uninstall', '--force', '--json'], exit: 0, ok: true },
)

function capabilityKey(name) {
  if (name === '(no args)') return name
  return String(name).trim().split(/\s+/)[0]
}

const advertised = [...new Set(
  (capabilities.commands || []).filter((c) => c && c.json === true).map((c) => capabilityKey(c.name)),
)].sort()
const covered = [...new Set(cases.map((c) => c.key).filter(Boolean))].sort()
const missingCoverage = advertised.filter((key) => !covered.includes(key))
const inventedCoverage = covered.filter((key) => !advertised.includes(key))
const requiredUsageGuards = [
  'status-missing-since-value',
  'verify-scope-missing-since-value',
  'run-missing-since-value',
  'repo-missing-value-tail',
  'capabilities-stray-positional',
  'version-stray-positional',
].sort()
const coveredUsageGuards = [...new Set(cases.map((c) => c.usageGuard).filter(Boolean))].sort()
const missingUsageGuards = requiredUsageGuards.filter((guard) => !coveredUsageGuards.includes(guard))
const inventedUsageGuards = coveredUsageGuards.filter((guard) => !requiredUsageGuards.includes(guard))
const commandContracts = new Map((capabilities.commands || []).map((command) => [capabilityKey(command.name), command]))
const commandAliases = new Map([
  ['--robot-help', 'robot-docs'],
  ['version', '--version'],
  ['-v', '--version'],
])
function caseContractKey(test) {
  if (test.contractKey) return test.contractKey
  if (test.key) return test.key
  const args = [...(test.args || [])]
  const commandArgs = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') { i++; continue }
    if (args[i] === '--json' || args[i] === '--no-write') continue
    commandArgs.push(args[i])
  }
  const first = commandArgs[0]
  if (!first) return '(no args)'
  if (commandAliases.has(first)) return commandAliases.get(first)
  return commandContracts.has(first) ? first : null
}
const errorCodes = Array.isArray(capabilities.error_codes) ? capabilities.error_codes : []
const caseContractErrors = []
for (const test of cases) {
  const key = caseContractKey(test)
  if (key) {
    const contract = commandContracts.get(key)
    if (!contract) caseContractErrors.push(`${test.id}: missing capabilities command row ${key}`)
    else if (!Array.isArray(contract.exits) || !contract.exits.includes(test.exit)) {
      caseContractErrors.push(`${test.id}: exit ${test.exit} absent from capabilities ${key}.exits=${JSON.stringify(contract.exits)}`)
    }
  } else if (!capabilities.exit_codes || !capabilities.exit_codes[String(test.exit)]) {
    caseContractErrors.push(`${test.id}: exit ${test.exit} absent from global capabilities.exit_codes`)
  }
  if (test.ok === false) {
    if (typeof test.kind !== 'string' || !test.kind) caseContractErrors.push(`${test.id}: failure case has no exact expected kind`)
    else if (!errorCodes.includes(test.kind)) caseContractErrors.push(`${test.id}: expected kind ${test.kind} absent from capabilities.error_codes`)
  }
}

const sourceDocs = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
const docsChecks = {
  robotHelpAliasDocumented: /robot-docs[^\n]*--robot-help/.test(sourceDocs),
  versionAliasesDocumented: /--version[^\n]*-v[^\n]*version/.test(sourceDocs),
}
const hookFlags = capabilities.cmd_flags && capabilities.cmd_flags.hooks
const hooksFlagsComplete = Array.isArray(hookFlags)
  && ['--install', '--uninstall', '--ci', '--force'].every((flag) => hookFlags.includes(flag))

function parseOneObject(stdout) {
  const text = stdout.trim()
  if (!text) throw new Error('stdout is empty')
  const parsed = JSON.parse(text) // rejects a second JSON value or trailing human output
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('stdout JSON is not one object')
  return parsed
}

function stderrContainsJsonObject(stderr) {
  for (const line of stderr.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') return true
    } catch {}
  }
  return false
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
async function executeCase(test) {
  const command = test.command || process.execPath
  const args = test.commandArgs || [SOURCE_CLI, ...test.args]
  const observed = await runAsync(command, args, { cwd: test.cwd || ROOT })
  const errors = []
  let payload = null
  try { payload = parseOneObject(observed.stdout) } catch (error) { errors.push(`stdout: ${error.message}`) }
  if (observed.error) errors.push(`spawn: ${observed.error}`)
  if (observed.signal) errors.push(`signal: ${observed.signal}`)
  if (observed.status !== test.exit) errors.push(`exit: expected ${test.exit}, got ${observed.status}`)
  if (payload) {
    if (typeof payload.ok !== 'boolean') errors.push(`ok: expected boolean, got ${typeof payload.ok}`)
    else if (payload.ok !== test.ok) errors.push(`ok: expected ${test.ok}, got ${payload.ok}`)
    if (payload._v !== contractVersion) errors.push(`_v: expected ${contractVersion}, got ${JSON.stringify(payload._v)}`)
    if (payload.ok === false && (typeof payload.kind !== 'string' || payload.kind.length === 0)) {
      errors.push(`kind: every ok:false envelope requires a nonempty stable kind, got ${JSON.stringify(payload.kind)}`)
    } else if (payload.ok === false && payload.kind !== test.kind) {
      errors.push(`kind: expected ${JSON.stringify(test.kind)}, got ${JSON.stringify(payload.kind)}`)
    }
  }
  if (test.exit === 0 && test.ok === true && observed.stderr.trim()) errors.push('stderr: success emitted diagnostics')
  if (test.diagnostic && !observed.stderr.trim()) errors.push('stderr: expected a failure diagnostic')
  if (stderrContainsJsonObject(observed.stderr)) errors.push('stderr: JSON data leaked onto diagnostic channel')
  return {
    id: test.id,
    expected: { exit: test.exit, ok: test.ok, kind: test.kind || null, diagnostic: !!test.diagnostic },
    observed: {
      exit: observed.status,
      signal: observed.signal,
      stdoutBytes: Buffer.byteLength(observed.stdout),
      stderrBytes: Buffer.byteLength(observed.stderr),
      stdoutSha256: sha256(observed.stdout),
      stderrSha256: sha256(observed.stderr),
      envelope: payload ? { ok: payload.ok, _v: payload._v, kind: payload.kind || null } : null,
    },
    pass: errors.length === 0,
    errors,
  }
}

// Run all read-only cases concurrently. The two hook mutation sequences remain ordered within their
// own isolated repos/directories; those two groups can still run in parallel with each other.
const indexedResults = new Map()
const serialGroups = new Map()
for (const [index, test] of cases.entries()) {
  if (!test.serial) continue
  if (!serialGroups.has(test.serial)) serialGroups.set(test.serial, [])
  serialGroups.get(test.serial).push([index, test])
}
await Promise.all([
  ...cases.map((test, index) => test.serial ? null : executeCase(test).then((result) => indexedResults.set(index, result))).filter(Boolean),
  ...[...serialGroups.values()].map(async (group) => {
    for (const [index, test] of group) indexedResults.set(index, await executeCase(test))
  }),
])
const results = cases.map((_, index) => indexedResults.get(index))

const metaErrors = []
if (!Number.isInteger(contractVersion) || contractVersion < 1) metaErrors.push(`invalid capabilities.contract_version: ${JSON.stringify(contractVersion)}`)
if (missingCoverage.length) metaErrors.push(`advertised json:true command(s) without a canonical case: ${missingCoverage.join(', ')}`)
if (inventedCoverage.length) metaErrors.push(`canonical case(s) not advertised as json:true: ${inventedCoverage.join(', ')}`)
if (missingUsageGuards.length) metaErrors.push(`required JSON usage guard(s) missing: ${missingUsageGuards.join(', ')}`)
if (inventedUsageGuards.length) metaErrors.push(`unknown JSON usage guard(s): ${inventedUsageGuards.join(', ')}`)
if (!docsChecks.robotHelpAliasDocumented) metaErrors.push('AGENTS.md no longer documents robot-docs/--robot-help alias parity')
if (!docsChecks.versionAliasesDocumented) metaErrors.push('AGENTS.md no longer documents --version/-v/version alias parity')
if (!hooksFlagsComplete) metaErrors.push(`capabilities.cmd_flags.hooks is incomplete: ${JSON.stringify(hookFlags)}`)
if (existsSync(join(bareTool, 'node_modules'))) metaErrors.push('bare optional-dependency fixture unexpectedly contains node_modules')
metaErrors.push(...caseContractErrors)

const failures = results.filter((r) => !r.pass)
const report = {
  schemaVersion: 1,
  source: {
    cli: SOURCE_CLI,
    engineSha256: sha256(readFileSync(join(ROOT, 'lib', 'engine.mjs'))),
    capabilitiesSha256: sha256(rawCapabilities.stdout),
    contractVersion,
  },
  coverage: {
    advertised,
    covered,
    missing: missingCoverage,
    invented: inventedCoverage,
    usageGuards: {
      required: requiredUsageGuards,
      covered: coveredUsageGuards,
      missing: missingUsageGuards,
      invented: inventedUsageGuards,
    },
    docsChecks,
    hookFlags,
    errorCodes,
    caseContractErrors,
  },
  summary: {
    cases: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    metaErrors: metaErrors.length,
  },
  metaErrors,
  results,
}
const reportPath = join(RUN, 'json-envelope-contract-report.json')
writeJson(reportPath, report)
writeFileSync(join(SCRATCH, 'latest-report-path.txt'), reportPath + '\n')

for (const error of metaErrors) console.error(`META FAIL: ${error}`)
for (const failure of failures) console.error(`FAIL ${failure.id}: ${failure.errors.join('; ')}`)
console.log(`json-envelope contract: ${report.summary.passed}/${report.summary.cases} cases passed; ${report.summary.metaErrors} meta error(s)`)
console.log(`report: ${reportPath}`)
if (metaErrors.length || failures.length) process.exitCode = 1
