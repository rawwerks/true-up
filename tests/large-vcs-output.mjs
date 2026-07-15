#!/usr/bin/env node
// Regression harness for VCS reads above Node's historical 1 MiB child-process buffer default.
// Large repository state must be complete or fail loud; it must never collapse to an empty repo/fact set.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [entryArg, workArg, reportArg] = process.argv.slice(2)
if (!entryArg || !workArg || !reportArg) {
  throw new Error('usage: node tests/large-vcs-output.mjs <true-up-entry> <new-work-dir> <report.json>')
}
const entry = resolve(entryArg)
const work = resolve(workArg)
const reportPath = resolve(reportArg)
const maxBuffer = 128 * 1024 * 1024
const oneMiB = 1024 * 1024
if (!existsSync(entry)) throw new Error(`entrypoint does not exist: ${entry}`)
if (existsSync(work)) throw new Error(`refusing to replace existing work directory: ${work}`)
mkdirSync(work, { recursive: true })

const cleanEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const git = (repo, args, options = {}) => spawnSync('git', ['-C', repo, ...args], {
  encoding: 'utf8',
  maxBuffer,
  env: cleanEnv,
  ...options,
})
const jj = (repo, args, options = {}) => spawnSync('jj', ['-R', repo, '--no-pager', ...args], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer,
  env: cleanEnv,
  ...options,
})
const run = (repo, args, env = cleanEnv) => spawnSync(process.execPath, [entry, '--repo', repo, ...args], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer,
  env,
})
const assertRun = (result, label, expectedExit = 0) => {
  if (result.error || result.status !== expectedExit) {
    throw new Error(`${label}: exit=${result.status} error=${result.error || ''}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
}
const parseEnvelope = (result, label, expectedExit = 0) => {
  assertRun(result, label, expectedExit)
  let value
  try { value = JSON.parse(result.stdout) } catch (error) { throw new Error(`${label}: invalid JSON: ${error}`) }
  if (typeof value?.ok !== 'boolean' || value?._v !== 1) throw new Error(`${label}: incomplete JSON envelope`)
  return { value, bytes: Buffer.byteLength(result.stdout), sha256: sha256(result.stdout) }
}
const initRepo = (name) => {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  assertRun(git(repo, ['init', '-q']), `${name}: git init`)
  return repo
}
const commitAll = (repo, message) => {
  assertRun(git(repo, ['add', '-A']), `${message}: git add`)
  assertRun(git(repo, ['-c', 'user.name=true-up vcs test', '-c', 'user.email=vcs@true-up.invalid', 'commit', '-qm', message]), `${message}: git commit`)
}

// Case 1: `git ls-files` exceeds 1 MiB, but only two paths belong to true-up's text universe. Index-only
// cache entries keep the fixture fast while reproducing the exact child-buffer pressure.
const listRepo = initRepo('large-file-list')
writeFileSync(join(listRepo, '.true-up.json'), JSON.stringify({
  zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'large-vcs-output', rules: ['no-machine-local-paths'] }],
  seed: [{ from: 'leak.md', to: '.true-up.json', kind: 'derives-facts-from' }],
}, null, 2) + '\n')
writeFileSync(join(listRepo, 'leak.md'), `machine-local path: ${join('/', 'home', 'example', 'private-data')}\n`)
commitAll(listRepo, 'large file-list fixture')

const blobRun = git(listRepo, ['hash-object', '-w', '--stdin'], { input: '' })
assertRun(blobRun, 'hash empty blob')
const emptyBlob = blobRun.stdout.trim()
const padding = 'x'.repeat(180)
let indexInfo = ''
for (let i = 0; i < 6000; i++) {
  indexInfo += `100644 ${emptyBlob}\t.true-up/noise-${String(i).padStart(4, '0')}-${padding}\n`
}
assertRun(git(listRepo, ['update-index', '--index-info'], { input: indexInfo }), 'populate large index')
const lsFiles = git(listRepo, ['ls-files'])
assertRun(lsFiles, 'large git ls-files')
const lsFilesBytes = Buffer.byteLength(lsFiles.stdout)
if (lsFilesBytes <= oneMiB) throw new Error(`large git ls-files fixture is only ${lsFilesBytes} bytes`)

const graph = parseEnvelope(run(listRepo, ['graph', '--json']), 'large-list graph --json')
if (!graph.value.graph?.nodes?.['file:leak.md'] || graph.value.graph.edges.length !== 1) {
  throw new Error('large-list graph silently lost tracked nodes/edges')
}
const externalities = parseEnvelope(run(listRepo, ['--externalities', '--json']), 'large-list externalities --json', 1)
if (externalities.value.ok !== false || externalities.value.count < 1 || !externalities.value.hits.some((h) => h.path === 'leak.md')) {
  throw new Error('large-list externalities silently missed the tracked leak')
}

// Git's default line-oriented path output is not a machine protocol: embedded newlines become extra
// records, tabs are ambiguous, and core.quotePath turns ordinary non-ASCII names into quoted octal
// display strings. Every path-producing read must use NUL framing and decode each record exactly.
const specialPathRepo = initRepo('opaque-git-paths')
const specialPaths = ['line\nbreak.md', 'tab\tpath.md', 'café.md', '\uFEFFleak.md']
const specialDocs = ['newline-doc.md', 'tab-doc.md', 'unicode-doc.md', 'bom-doc.md']
writeFileSync(join(specialPathRepo, '.true-up.json'), JSON.stringify({
  zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'opaque-git-paths', rules: ['no-machine-local-paths'] }],
  seed: specialPaths.map((to, i) => ({ from: specialDocs[i], to, kind: 'derives-facts-from' })),
}, null, 2) + '\n')
for (let i = 0; i < specialPaths.length; i++) {
  writeFileSync(join(specialPathRepo, specialPaths[i]), `machine-local path: ${join('/', 'home', 'example', `opaque-${i}`)}\n`)
  writeFileSync(join(specialPathRepo, specialDocs[i]), `# Derived from ${JSON.stringify(specialPaths[i])}\n`)
}
assertRun(run(specialPathRepo, []), 'opaque Git paths initial build')
commitAll(specialPathRepo, 'opaque Git paths fixture')
const specialGitList = git(specialPathRepo, ['ls-files', '-z'], { encoding: null })
assertRun(specialGitList, 'opaque Git paths raw NUL list')
for (const path of specialPaths) {
  if (!specialGitList.stdout.includes(Buffer.from(path + '\0'))) throw new Error(`Git did not preserve expected opaque fixture path: ${JSON.stringify(path)}`)
}
const specialGraph = parseEnvelope(run(specialPathRepo, ['graph', '--json']), 'opaque Git paths graph --json')
for (const path of specialPaths) {
  if (!specialGraph.value.graph?.nodes?.[`file:${path}`]) throw new Error(`graph lost opaque Git path: ${JSON.stringify(path)}`)
}
for (let i = 0; i < specialPaths.length; i++) {
  const edge = specialGraph.value.graph.edges.find((e) => e.from === `file:${specialDocs[i]}` && e.to === `file:${specialPaths[i]}`)
  if (!edge) throw new Error(`seed did not resolve opaque Git path: ${JSON.stringify(specialPaths[i])}`)
}
const specialLeaks = parseEnvelope(run(specialPathRepo, ['--externalities', '--json']), 'opaque Git paths externalities --json', 1)
for (const path of specialPaths) {
  if (!specialLeaks.value.hits.some((hit) => hit.path === path)) throw new Error(`externalities lost opaque Git path: ${JSON.stringify(path)}`)
}
for (let i = 0; i < specialPaths.length; i++) {
  writeFileSync(join(specialPathRepo, specialPaths[i]), `changed machine-local path: ${join('/', 'home', 'example', `changed-${i}`)}\n`)
}
const specialImpact = parseEnvelope(run(specialPathRepo, ['--impact', '--since', 'HEAD', '--proof', '--json']), 'opaque Git paths impact --json')
for (const doc of specialDocs) {
  if (!specialImpact.value.advisory.some((item) => item.node === `file:${doc}`)) throw new Error(`impact lost dependent of opaque Git path: ${JSON.stringify(doc)}`)
}

// Git rename detection can collapse a staged source deletion+addition into only the destination path.
// Impact must still see the deleted graph node, because that is where existing dependents are wired.
const renameRepo = initRepo('staged-source-rename')
writeFileSync(join(renameRepo, '.true-up.json'), JSON.stringify({
  seed: [{ from: 'doc.md', to: 'old-source.md', kind: 'derives-facts-from' }],
}, null, 2) + '\n')
writeFileSync(join(renameRepo, 'old-source.md'), '# source\n')
writeFileSync(join(renameRepo, 'doc.md'), '# dependent\n')
assertRun(run(renameRepo, []), 'staged rename initial build')
commitAll(renameRepo, 'staged rename fixture')
assertRun(git(renameRepo, ['mv', 'old-source.md', 'new-source.md']), 'stage source rename')
const stagedRename = parseEnvelope(run(renameRepo, ['--impact', '--since', 'HEAD', '--proof', '--json']), 'staged source rename impact --json')
if (!stagedRename.value.advisory.some((item) => item.node === 'file:doc.md')) {
  throw new Error('staged Git rename collapsed the deleted source and lost its dependent')
}

// A tracked symlink's link text is repository content. Leak/policy scans must inspect that text, not
// follow an existing external target or silently skip a broken one.
const symlinkLeakRepo = initRepo('symlink-link-text-leak')
writeFileSync(join(symlinkLeakRepo, '.true-up.json'), JSON.stringify({
  zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'symlink-leak', rules: ['no-machine-local-paths'] }],
}, null, 2) + '\n')
const symlinkLeakTarget = join('/', 'home', 'example', 'private-target')
symlinkSync(symlinkLeakTarget, join(symlinkLeakRepo, 'public.md'))
commitAll(symlinkLeakRepo, 'symlink link-text leak fixture')
const storedSymlink = git(symlinkLeakRepo, ['show', 'HEAD:public.md'])
assertRun(storedSymlink, 'read tracked symlink blob')
if (storedSymlink.stdout !== symlinkLeakTarget) throw new Error('Git symlink blob does not match fixture link text')
const symlinkGraph = parseEnvelope(run(symlinkLeakRepo, ['graph', '--json']), 'symlink link-text graph --json')
if (symlinkGraph.value.graph?.nodes?.['file:public.md']?.kind !== 'symlink') throw new Error('graph no longer classifies tracked symlink without following it')
const symlinkExternalities = parseEnvelope(run(symlinkLeakRepo, ['--externalities', '--json']), 'symlink link-text externalities --json', 1)
if (!symlinkExternalities.value.hits.some((hit) => hit.path === 'public.md')) throw new Error('externalities skipped leaking symlink link text')
const symlinkPolicy = parseEnvelope(run(symlinkLeakRepo, ['--policy', '--json']), 'symlink link-text policy --json', 1)
if (!symlinkPolicy.value.violations.some((violation) => violation.path === 'public.md' && violation.rule === 'no-machine-local-paths')) {
  throw new Error('policy skipped leaking symlink link text')
}

// JavaScript strings cannot faithfully name an arbitrary non-UTF-8 Unix path. Git can, so capture
// path streams as bytes and fail loud when a record cannot be decoded instead of substituting U+FFFD
// and scanning a nonexistent path.
const invalidUtf8Repo = initRepo('invalid-utf8-git-path')
writeFileSync(join(invalidUtf8Repo, '.true-up.json'), JSON.stringify({
  zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'invalid-utf8-path', rules: ['no-machine-local-paths'] }],
}, null, 2) + '\n')
const invalidUtf8Path = Buffer.concat([Buffer.from(`${invalidUtf8Repo}/bad-`), Buffer.from([0xff]), Buffer.from('.md')])
writeFileSync(invalidUtf8Path, `machine-local path: ${join('/', 'home', 'example', 'invalid-utf8')}\n`)
commitAll(invalidUtf8Repo, 'invalid UTF-8 Git path fixture')
const invalidUtf8List = git(invalidUtf8Repo, ['ls-files', '-z'], { encoding: null })
assertRun(invalidUtf8List, 'invalid UTF-8 Git path raw list')
if (!invalidUtf8List.stdout.includes(Buffer.from([0xff]))) throw new Error('invalid UTF-8 Git fixture did not preserve its raw filename byte')
const invalidUtf8Graph = parseEnvelope(run(invalidUtf8Repo, ['graph', '--json']), 'invalid UTF-8 Git path graph --json', 2)
if (invalidUtf8Graph.value.kind !== 'vcs-read-failed') throw new Error('invalid UTF-8 Git path did not fail graph read loud')
const invalidUtf8Leaks = parseEnvelope(run(invalidUtf8Repo, ['--externalities', '--json']), 'invalid UTF-8 Git path externalities --json', 2)
if (invalidUtf8Leaks.value.kind !== 'vcs-read-failed') throw new Error('invalid UTF-8 Git path did not fail leak scan loud')

// A capture beyond true-up's explicit 64 MiB bound must fail loud, not return an empty list. A local
// forwarding Git shim injects deterministic backpressure only for ls-files; all repo discovery still
// goes through the real Git binary.
const whichGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: cleanEnv })
assertRun(whichGit, 'locate real git')
const shimDir = join(work, 'git-shim')
mkdirSync(shimDir)
const shim = join(shimDir, 'git')
writeFileSync(shim, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { writeSync } = require('node:fs')
const args = process.argv.slice(2)
if (process.env.TRUE_UP_TEST_GIT_MODE === 'overflow' && args.includes('ls-files')) {
  const chunk = Buffer.alloc(1024 * 1024, 0x78)
  for (let i = 0; i < 65; i++) writeSync(1, chunk)
  process.exit(0)
}
if (process.env.TRUE_UP_TEST_GIT_MODE === 'unterminated-path-stream' && args.includes('ls-files')) {
  writeSync(1, Buffer.from('orphan.md'))
  process.exit(0)
}
if (process.env.TRUE_UP_TEST_GIT_MODE === 'root-probe-failure' && args.includes('rev-parse') && args.includes('--show-toplevel')) {
  process.exit(128)
}
if (process.env.TRUE_UP_TEST_GIT_MODE === 'object-read-failure' && args.includes('cat-file')) {
  process.exit(128)
}
if (process.env.TRUE_UP_TEST_GIT_MODE === 'object-read-failure' && args.includes('rev-parse') && args.includes('--verify') && args.some((arg) => arg.includes(':data.json'))) {
  process.exit(128)
}
if (process.env.TRUE_UP_TEST_GIT_MODE === 'reject-new-cat-file' && args.includes('cat-file') && args.includes('-Z')) {
  process.exit(129)
}
const r = spawnSync(process.env.TRUE_UP_TEST_REAL_GIT, args, { stdio: 'inherit' })
if (r.error) throw r.error
process.exit(r.status ?? 2)
`)
chmodSync(shim, 0o755)
const overflowEnv = {
  ...cleanEnv,
  PATH: `${shimDir}:${cleanEnv.PATH}`,
  TRUE_UP_TEST_REAL_GIT: whichGit.stdout.trim(),
  TRUE_UP_TEST_GIT_MODE: 'overflow',
}
const overflow = parseEnvelope(run(listRepo, ['graph', '--json'], overflowEnv), 'overflow graph --json', 2)
if (overflow.value.ok !== false || overflow.value.error !== 'vcs-read-failed' || overflow.value.kind !== 'vcs-read-failed') {
  throw new Error('VCS buffer overflow did not fail loud with a structured vcs-read-failed envelope')
}
const unterminatedPathEnv = {
  ...cleanEnv,
  PATH: `${shimDir}:${cleanEnv.PATH}`,
  TRUE_UP_TEST_REAL_GIT: whichGit.stdout.trim(),
  TRUE_UP_TEST_GIT_MODE: 'unterminated-path-stream',
}
const unterminatedPath = parseEnvelope(run(listRepo, ['graph', '--json'], unterminatedPathEnv), 'unterminated Git path stream graph --json', 2)
if (unterminatedPath.value.kind !== 'vcs-read-failed') {
  throw new Error('unterminated Git path stream did not fail loud')
}

// Case 2: historical content itself exceeds 1 MiB. Replacing it with an empty steward must still
// compare against the full committed fact and report the dependent doc.
const showRepo = initRepo('large-historical-steward')
writeFileSync(join(showRepo, '.true-up.json'), JSON.stringify({
  facts: { 'data.json': [['items', 'id']] },
  zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'large-vcs-show', rules: [] }],
  seed: [{ from: 'doc.md', to: 'data.json#items.a', kind: 'derives-facts-from' }],
}, null, 2) + '\n')
writeFileSync(join(showRepo, 'data.json'), JSON.stringify({ items: [{ id: 'a', value: 'z'.repeat(1_300_000) }] }) + '\n')
writeFileSync(join(showRepo, 'doc.md'), '# Derived from fact a\n')
const initialBuild = run(showRepo, [])
assertRun(initialBuild, 'large historical initial build')
commitAll(showRepo, 'large historical steward fixture')
const historical = git(showRepo, ['show', 'HEAD:data.json'])
assertRun(historical, 'large historical git show')
const historicalBytes = Buffer.byteLength(historical.stdout)
if (historicalBytes <= oneMiB) throw new Error(`historical steward fixture is only ${historicalBytes} bytes`)
writeFileSync(join(showRepo, 'data.json'), '{"items":[]}\n')

const impact = parseEnvelope(run(showRepo, ['--impact', '--since', 'HEAD', '--json']), 'large historical impact --json')
if (!impact.value.changedFacts.includes('fact:data.json#items.a') || impact.value.counts?.advisory !== 1 || impact.value.advisory?.[0]?.node !== 'file:doc.md') {
  throw new Error('large historical VCS read silently lost the changed fact/dependent')
}

// Exit 128 from `git cat-file` is not proof that an object is absent: Git also uses it for
// operational failures. The adapter must distinguish a successful "missing" batch response from a
// failed Git process, or a real historical fact can collapse into an empty false-clean result.
const objectReadFailureEnv = {
  ...cleanEnv,
  PATH: `${shimDir}:${cleanEnv.PATH}`,
  TRUE_UP_TEST_REAL_GIT: whichGit.stdout.trim(),
  TRUE_UP_TEST_GIT_MODE: 'object-read-failure',
}
const objectReadFailure = parseEnvelope(run(showRepo, ['--impact', '--since', 'HEAD', '--json'], objectReadFailureEnv), 'object-read operational failure --json', 2)
if (objectReadFailure.value.ok !== false || objectReadFailure.value.error !== 'vcs-read-failed' || objectReadFailure.value.kind !== 'vcs-read-failed') {
  throw new Error('object-read operational failure did not fail loud with a structured vcs-read-failed envelope')
}

const legacyGitEnv = {
  ...cleanEnv,
  PATH: `${shimDir}:${cleanEnv.PATH}`,
  TRUE_UP_TEST_REAL_GIT: whichGit.stdout.trim(),
  TRUE_UP_TEST_GIT_MODE: 'reject-new-cat-file',
}
const legacyGitImpact = parseEnvelope(run(showRepo, ['--impact', '--since', 'HEAD', '--json'], legacyGitEnv), 'Git without cat-file -Z impact --json')
if (!legacyGitImpact.value.changedFacts.includes('fact:data.json#items.a') || legacyGitImpact.value.counts?.advisory !== 1) {
  throw new Error('object existence probe unnecessarily requires newer cat-file -Z support')
}

// The index is the pre-commit truth. If the graph is staged for deletion, falling back to HEAD
// incorrectly blesses the deleted graph as fresh.
const deletionRepo = initRepo('staged-graph-deletion')
writeFileSync(join(deletionRepo, '.true-up.json'), JSON.stringify({
  facts: { 'data.json': [['items', 'id']] },
  seed: [{ from: 'doc.md', to: 'data.json#items.a', kind: 'derives-facts-from' }],
}, null, 2) + '\n')
writeFileSync(join(deletionRepo, 'data.json'), '{"items":[{"id":"a","value":1}]}\n')
writeFileSync(join(deletionRepo, 'doc.md'), '# Derived from fact a\n')
assertRun(run(deletionRepo, []), 'staged deletion initial build')
commitAll(deletionRepo, 'tracked graph fixture')
const committedBeforeDeletion = parseEnvelope(run(deletionRepo, ['--check', '--committed', '--json']), 'tracked graph before staged deletion --json')
if (committedBeforeDeletion.value.ok !== true || committedBeforeDeletion.value.upToDate !== true) {
  throw new Error('fresh tracked graph did not pass before the staged-deletion check')
}
assertRun(git(deletionRepo, ['rm', '--cached', '-q', '.true-up/depgraph.json']), 'stage graph deletion')
const stagedDeletion = parseEnvelope(run(deletionRepo, ['--check', '--committed', '--json']), 'staged graph deletion --json', 1)
if (stagedDeletion.value.ok !== false || stagedDeletion.value.upToDate !== false || stagedDeletion.value.reason !== 'not committed/staged') {
  throw new Error('staged graph deletion fell back to HEAD instead of failing the committed gate')
}

// An initial Git repository has no HEAD yet. Implicit-baseline commands must compare against an empty
// repository state; they must not manufacture an invalid HEAD ref or hide a failed Git read.
const unbornRepo = initRepo('unborn-repository')
writeFileSync(join(unbornRepo, '.true-up.json'), JSON.stringify({
  facts: { 'data.json': [['items', 'id']] },
  seed: [{ from: 'doc.md', to: 'data.json#items.a', kind: 'derives-facts-from' }],
}, null, 2) + '\n')
writeFileSync(join(unbornRepo, 'data.json'), '{"items":[{"id":"a","value":1}]}\n')
writeFileSync(join(unbornRepo, 'doc.md'), '# Derived from fact a\n')
assertRun(run(unbornRepo, []), 'unborn initial build')
const unbornStatus = parseEnvelope(run(unbornRepo, ['status', '--json']), 'unborn status --json')
if (unbornStatus.value.since !== null || unbornStatus.value.workspace?.since !== null) {
  throw new Error('unborn status did not expose its empty baseline as null')
}
const unbornRun = parseEnvelope(run(unbornRepo, ['run', '--no-write', '--json']), 'unborn dry-run --json')
if (unbornRun.value.since !== null || unbornRun.value.dryRun !== true) {
  throw new Error('unborn dry-run did not use the empty baseline')
}
const unbornScopeResult = run(unbornRepo, ['--verify-scope', '--json'])
if (unbornScopeResult.status === 2) {
  throw new Error(`unborn verify-scope treated implicit HEAD as a usage error: ${unbornScopeResult.stdout}${unbornScopeResult.stderr}`)
}
const unbornScope = parseEnvelope(unbornScopeResult, 'unborn verify-scope --json', unbornScopeResult.status)
if (![0, 1].includes(unbornScopeResult.status) || unbornScope.value.since !== null) {
  throw new Error('unborn verify-scope did not evaluate against the empty baseline')
}

// Case 5: non-colocated jj must distinguish a missing item (successful empty `file list`) from an
// operationally failed required read. `@-` is the deterministic default baseline for a normal jj
// working-copy commit; probing it is unnecessary because every working-copy commit has the root as
// an ancestor. An obsolete failed probe must not fall back to `@` and erase the actual data.json
// change, while a failed required `jj diff` must fail loud.
const jjVersion = spawnSync('jj', ['--version'], { encoding: 'utf8', maxBuffer, env: cleanEnv })
let jjCase = {
  available: false,
  skipped: jjVersion.error ? `jj unavailable: ${jjVersion.error.code || jjVersion.error.message}` : `jj --version exited ${jjVersion.status}`,
}
if (!jjVersion.error && jjVersion.status === 0) {
  const jjRepo = join(work, 'non-colocated-jj')
  const jjInit = spawnSync('jj', ['git', 'init', '--no-colocate', jjRepo], { encoding: 'utf8', maxBuffer, env: cleanEnv })
  assertRun(jjInit, 'non-colocated jj init')
  if (!existsSync(join(jjRepo, '.jj')) || existsSync(join(jjRepo, '.git'))) {
    throw new Error('jj fixture is not a non-colocated workspace')
  }
  writeFileSync(join(jjRepo, '.true-up.json'), JSON.stringify({
    facts: { 'data.json': [['items', 'id']] },
    zones: [{ path: '', visibility: 'public', audience: 'world', intent: 'jj-path-transport', rules: ['no-machine-local-paths'] }],
    seed: [
      { from: 'doc.md', to: 'data.json#items.a', kind: 'derives-facts-from' },
      { from: 'jj-newline-doc.md', to: 'line\nbreak.md#special', kind: 'derives-facts-from' },
      { from: 'jj-unicode-doc.md', to: 'café.md', kind: 'derives-facts-from' },
    ],
  }, null, 2) + '\n')
  writeFileSync(join(jjRepo, 'data.json'), '{"items":[{"id":"a","value":1}]}\n')
  writeFileSync(join(jjRepo, 'doc.md'), '# Derived from fact a\n')
  writeFileSync(join(jjRepo, 'line\nbreak.md'), `# true-up:anchor id=special\nmachine-local path: ${join('/', 'home', 'example', 'jj-newline')}\n# true-up:end\n`)
  writeFileSync(join(jjRepo, 'café.md'), `machine-local path: ${join('/', 'home', 'example', 'jj-unicode')}\n`)
  writeFileSync(join(jjRepo, 'jj-newline-doc.md'), '# Derived from the newline span\n')
  writeFileSync(join(jjRepo, 'jj-unicode-doc.md'), '# Derived from the Unicode file\n')
  assertRun(run(jjRepo, []), 'non-colocated jj initial build')
  const initialJjGraph = parseEnvelope(run(jjRepo, ['graph', '--json']), 'non-colocated jj opaque paths graph --json')
  if (!initialJjGraph.value.graph?.nodes?.['file:line\nbreak.md'] ||
      !initialJjGraph.value.graph?.nodes?.['fact:line\nbreak.md#special'] ||
      !initialJjGraph.value.graph?.nodes?.['file:café.md']) {
    throw new Error('non-colocated jj graph lost newline, Unicode, or span-fact path')
  }
  const initialJjLeaks = parseEnvelope(run(jjRepo, ['--externalities', '--json']), 'non-colocated jj opaque paths externalities --json', 1)
  for (const path of ['line\nbreak.md', 'café.md']) {
    if (!initialJjLeaks.value.hits.some((hit) => hit.path === path)) throw new Error(`non-colocated jj leak scan lost path: ${JSON.stringify(path)}`)
  }
  assertRun(jj(jjRepo, ['commit', '-m', 'jj baseline fixture']), 'non-colocated jj baseline commit')
  writeFileSync(join(jjRepo, 'data.json'), '{"items":[{"id":"a","value":2}]}\n')
  writeFileSync(join(jjRepo, 'line\nbreak.md'), `# true-up:anchor id=special\nchanged machine-local path: ${join('/', 'home', 'example', 'jj-newline')}\n# true-up:end\n`)
  writeFileSync(join(jjRepo, 'café.md'), `changed machine-local path: ${join('/', 'home', 'example', 'jj-unicode')}\n`)

  const normalJjStatus = parseEnvelope(run(jjRepo, ['status', '--json']), 'non-colocated jj status --json')
  if (normalJjStatus.value.workspace?.vcs !== 'jj' || normalJjStatus.value.workspace?.jj?.colocated !== false) {
    throw new Error('normal jj status did not identify the non-colocated workspace')
  }
  if (normalJjStatus.value.since !== '@-' || normalJjStatus.value.workspace?.since !== '@-') {
    throw new Error('normal jj status did not use @- as its baseline')
  }
  if (!normalJjStatus.value.impact?.changedFacts?.includes('items.a') ||
      !normalJjStatus.value.impact?.advisory?.some((item) => item.doc === 'doc.md' && item.from === 'data.json#items.a')) {
    throw new Error('normal jj status lost the changed fact or its advisory dependent')
  }
  const specialJjImpact = parseEnvelope(run(jjRepo, ['--impact', '--since', '@-', '--proof', '--json']), 'non-colocated jj opaque paths impact --json')
  if (!specialJjImpact.value.changedFacts.includes('fact:line\nbreak.md#special') ||
      !specialJjImpact.value.advisory.some((item) => item.node === 'file:jj-newline-doc.md') ||
      !specialJjImpact.value.advisory.some((item) => item.node === 'file:jj-unicode-doc.md')) {
    throw new Error('non-colocated jj impact lost special path facts or dependents')
  }

  // Path absence is not an operational failure: jj reports it as success with an empty listing.
  // Pin that adjacent contract so a future fail-loud fix does not turn ordinary historical absence
  // into vcs-read-failed.
  const missingAtParent = jj(jjRepo, ['file', 'list', '-r', '@-', 'absent-at-parent.json'])
  assertRun(missingAtParent, 'jj missing historical path')
  if (missingAtParent.stdout !== '') throw new Error('jj missing historical path did not return an empty successful listing')

  const whichJj = spawnSync('sh', ['-c', 'command -v jj'], { encoding: 'utf8', env: cleanEnv })
  assertRun(whichJj, 'locate real jj')
  const jjShim = join(shimDir, 'jj')
  writeFileSync(jjShim, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const rev = args.indexOf('-r')
if (process.env.TRUE_UP_TEST_JJ_MODE === 'default-since-failure' && args.includes('log') && rev >= 0 && args[rev + 1] === '@-') {
  process.exit(2)
}
if (process.env.TRUE_UP_TEST_JJ_MODE === 'required-diff-failure' && args.includes('diff')) {
  process.exit(2)
}
if (process.env.TRUE_UP_TEST_JJ_MODE === 'required-log-failure' && args.includes('log')) {
  process.exit(2)
}
const r = spawnSync(process.env.TRUE_UP_TEST_REAL_JJ, args, { stdio: 'inherit' })
if (r.error) throw r.error
process.exit(r.status ?? 2)
`)
  chmodSync(jjShim, 0o755)
  const failedDefaultSinceEnv = {
    ...cleanEnv,
    PATH: `${shimDir}:${cleanEnv.PATH}`,
    TRUE_UP_TEST_REAL_JJ: whichJj.stdout.trim(),
    TRUE_UP_TEST_JJ_MODE: 'default-since-failure',
  }
  const ignoredDefaultProbe = parseEnvelope(run(jjRepo, ['status', '--json'], failedDefaultSinceEnv), 'jj obsolete default-since probe failure --json')
  if (ignoredDefaultProbe.value.since !== '@-' || ignoredDefaultProbe.value.workspace?.since !== '@-' ||
      !ignoredDefaultProbe.value.impact?.changedFacts?.includes('items.a') ||
      !ignoredDefaultProbe.value.impact?.advisory?.some((item) => item.doc === 'doc.md' && item.from === 'data.json#items.a')) {
    throw new Error('jj obsolete default-since probe failure caused a fallback to @ or erased the changed fact/advisory')
  }

  const failedDiffEnv = {
    ...cleanEnv,
    PATH: `${shimDir}:${cleanEnv.PATH}`,
    TRUE_UP_TEST_REAL_JJ: whichJj.stdout.trim(),
    TRUE_UP_TEST_JJ_MODE: 'required-diff-failure',
  }
  const failedDiff = parseEnvelope(run(jjRepo, ['status', '--json'], failedDiffEnv), 'jj required diff operational failure --json', 2)
  if (failedDiff.value.ok !== false || failedDiff.value.error !== 'vcs-read-failed' || failedDiff.value.kind !== 'vcs-read-failed') {
    throw new Error('jj required diff operational failure did not fail loud with a structured vcs-read-failed envelope')
  }
  const failedLogEnv = {
    ...cleanEnv,
    PATH: `${shimDir}:${cleanEnv.PATH}`,
    TRUE_UP_TEST_REAL_JJ: whichJj.stdout.trim(),
    TRUE_UP_TEST_JJ_MODE: 'required-log-failure',
  }
  const failedLog = parseEnvelope(run(jjRepo, ['status', '--since', '@-', '--json'], failedLogEnv), 'jj required log operational failure --json', 2)
  if (failedLog.value.ok !== false || failedLog.value.error !== 'vcs-read-failed' || failedLog.value.kind !== 'vcs-read-failed') {
    throw new Error('jj required log operational failure was misclassified as a missing/bad revset')
  }

  // A colocated repo is intentionally Git-backed. If Git root discovery fails operationally, falling
  // through to `jj root` changes committed-graph semantics from the selected Git index to jj `@` and
  // can falsely bless a staged deletion. A visible .git marker makes this a Git failure, not absence.
  const rootFallbackRepo = initRepo('colocated-root-probe-failure')
  writeFileSync(join(rootFallbackRepo, '.true-up.json'), JSON.stringify({
    seed: [{ from: 'doc.md', to: 'source.md', kind: 'derives-facts-from' }],
  }, null, 2) + '\n')
  writeFileSync(join(rootFallbackRepo, 'source.md'), '# source\n')
  writeFileSync(join(rootFallbackRepo, 'doc.md'), '# dependent\n')
  assertRun(run(rootFallbackRepo, []), 'colocated root-probe initial build')
  commitAll(rootFallbackRepo, 'colocated root-probe fixture')
  const colocateInit = spawnSync('jj', ['git', 'init', '--colocate', rootFallbackRepo], { encoding: 'utf8', maxBuffer, env: cleanEnv })
  assertRun(colocateInit, 'colocated root-probe jj init')
  if (!existsSync(join(rootFallbackRepo, '.git')) || !existsSync(join(rootFallbackRepo, '.jj'))) {
    throw new Error('root-probe fixture is not a colocated Git/jj workspace')
  }
  const rootFallbackLink = join(work, 'colocated-root-probe-failure-link')
  symlinkSync(rootFallbackRepo, rootFallbackLink, 'dir')
  assertRun(git(rootFallbackRepo, ['rm', '--cached', '-q', '.true-up/depgraph.json']), 'colocated root-probe stage graph deletion')
  const normalRootProbe = parseEnvelope(run(rootFallbackRepo, ['--check', '--committed', '--json']), 'colocated normal root probe staged deletion --json', 1)
  if (normalRootProbe.value.vcs !== 'git' || normalRootProbe.value.reason !== 'not committed/staged') {
    throw new Error('normal colocated root probe did not retain Git index-only semantics')
  }
  const rootProbeFailureEnv = {
    ...cleanEnv,
    PATH: `${shimDir}:${cleanEnv.PATH}`,
    TRUE_UP_TEST_REAL_GIT: whichGit.stdout.trim(),
    TRUE_UP_TEST_GIT_MODE: 'root-probe-failure',
  }
  const failedRootProbe = parseEnvelope(run(rootFallbackRepo, ['--check', '--committed', '--json'], rootProbeFailureEnv), 'colocated Git root-probe operational failure --json', 2)
  if (failedRootProbe.value.kind !== 'vcs-read-failed') {
    throw new Error('colocated operational Git root-probe failure fell through to jj semantics')
  }
  const failedSymlinkRootProbe = parseEnvelope(run(rootFallbackLink, ['--check', '--committed', '--json'], rootProbeFailureEnv), 'symlinked colocated Git root-probe operational failure --json', 2)
  if (failedSymlinkRootProbe.value.kind !== 'vcs-read-failed') {
    throw new Error('symlinked --repo operational Git root-probe failure fell through to jj semantics')
  }

  jjCase = {
    available: true,
    version: jjVersion.stdout.trim(),
    normalStatus: {
      bytes: normalJjStatus.bytes,
      sha256: normalJjStatus.sha256,
      since: normalJjStatus.value.since,
      changedFacts: normalJjStatus.value.impact.changedFacts,
      advisory: normalJjStatus.value.impact.advisory,
    },
    missingAtParent: { exit: missingAtParent.status, bytes: Buffer.byteLength(missingAtParent.stdout) },
    ignoredDefaultProbe: {
      bytes: ignoredDefaultProbe.bytes,
      sha256: ignoredDefaultProbe.sha256,
      since: ignoredDefaultProbe.value.since,
      changedFacts: ignoredDefaultProbe.value.impact.changedFacts,
      advisory: ignoredDefaultProbe.value.impact.advisory,
    },
    failedDiff: {
      bytes: failedDiff.bytes,
      sha256: failedDiff.sha256,
      error: failedDiff.value.error,
    },
    failedLog: {
      bytes: failedLog.bytes,
      sha256: failedLog.sha256,
      error: failedLog.value.error,
    },
    rootProbeFailure: {
      normal: { bytes: normalRootProbe.bytes, sha256: normalRootProbe.sha256, reason: normalRootProbe.value.reason },
      failed: { bytes: failedRootProbe.bytes, sha256: failedRootProbe.sha256, error: failedRootProbe.value.error },
      symlinkFailed: { bytes: failedSymlinkRootProbe.bytes, sha256: failedSymlinkRootProbe.sha256, error: failedSymlinkRootProbe.value.error },
    },
  }
}

const report = {
  ok: true,
  entry,
  maxBuffer,
  fileList: {
    paths: lsFiles.stdout.split('\n').filter(Boolean).length,
    bytes: lsFilesBytes,
    sha256: sha256(lsFiles.stdout),
    graph: { bytes: graph.bytes, sha256: graph.sha256, nodes: Object.keys(graph.value.graph.nodes).length, edges: graph.value.graph.edges.length },
    externalities: { bytes: externalities.bytes, sha256: externalities.sha256, count: externalities.value.count, files: externalities.value.files },
    overflow: { bytes: overflow.bytes, sha256: overflow.sha256, error: overflow.value.error },
    unterminatedPath: { bytes: unterminatedPath.bytes, sha256: unterminatedPath.sha256, error: unterminatedPath.value.error },
  },
  opaqueGitPaths: {
    paths: specialPaths,
    graph: { bytes: specialGraph.bytes, sha256: specialGraph.sha256, edges: specialGraph.value.graph.edges.length },
    externalities: { bytes: specialLeaks.bytes, sha256: specialLeaks.sha256, count: specialLeaks.value.count },
    impact: { bytes: specialImpact.bytes, sha256: specialImpact.sha256, advisory: specialImpact.value.counts.advisory },
    invalidUtf8: {
      graph: { bytes: invalidUtf8Graph.bytes, sha256: invalidUtf8Graph.sha256, kind: invalidUtf8Graph.value.kind },
      externalities: { bytes: invalidUtf8Leaks.bytes, sha256: invalidUtf8Leaks.sha256, kind: invalidUtf8Leaks.value.kind },
    },
  },
  stagedRename: {
    bytes: stagedRename.bytes,
    sha256: stagedRename.sha256,
    advisory: stagedRename.value.counts.advisory,
  },
  symlinkLinkText: {
    graph: { bytes: symlinkGraph.bytes, sha256: symlinkGraph.sha256, kind: symlinkGraph.value.graph.nodes['file:public.md'].kind },
    externalities: { bytes: symlinkExternalities.bytes, sha256: symlinkExternalities.sha256, count: symlinkExternalities.value.count },
    policy: { bytes: symlinkPolicy.bytes, sha256: symlinkPolicy.sha256, count: symlinkPolicy.value.count },
  },
  historical: {
    bytes: historicalBytes,
    sha256: sha256(historical.stdout),
    impact: { bytes: impact.bytes, sha256: impact.sha256, changedFacts: impact.value.changedFacts, advisory: impact.value.counts.advisory },
    objectReadFailure: { bytes: objectReadFailure.bytes, sha256: objectReadFailure.sha256, error: objectReadFailure.value.error },
    legacyGit: { bytes: legacyGitImpact.bytes, sha256: legacyGitImpact.sha256, advisory: legacyGitImpact.value.counts.advisory },
  },
  committedGate: {
    beforeDeletion: { bytes: committedBeforeDeletion.bytes, sha256: committedBeforeDeletion.sha256, upToDate: committedBeforeDeletion.value.upToDate },
    stagedDeletion: { bytes: stagedDeletion.bytes, sha256: stagedDeletion.sha256, reason: stagedDeletion.value.reason },
  },
  unborn: {
    status: { bytes: unbornStatus.bytes, sha256: unbornStatus.sha256, since: unbornStatus.value.since },
    dryRun: { bytes: unbornRun.bytes, sha256: unbornRun.sha256, since: unbornRun.value.since },
    scope: { bytes: unbornScope.bytes, sha256: unbornScope.sha256, exit: unbornScopeResult.status, since: unbornScope.value.since },
  },
  jj: jjCase,
}
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report) + '\n')
