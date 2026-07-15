// Deterministic, read-only true-up config loader.
//
// This module intentionally has no dependency on engine.mjs: importing the engine dispatches a CLI,
// computes OUT, and may build/write. Wave 1 tests this loader directly; Wave 2 wires its result into
// the CLI only after the complete config has parsed, validated, merged, and passed ownership checks.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

export const COMPOSITION_LIMITS = Object.freeze({
  maxIncludes: 256,
  maxIncludedBytes: 32 * 1024 * 1024,
})

export const CONFIG_COMPOSITION_ERROR_CODES = Object.freeze([
  'composition-sentinel-invalid', 'composition-root-symlink', 'composition-root-not-regular',
  'composition-root-realpath-escape', 'root-invalid-utf8', 'root-invalid-json',
  'include-count-limit', 'include-bytes-limit', 'include-path-empty', 'include-path-backslash',
  'include-path-absolute', 'include-path-nul', 'include-path-invalid-unicode', 'include-path-escape', 'include-path-duplicate',
  'include-root', 'include-forbidden-location', 'include-ignored', 'include-missing',
  'include-symlink', 'include-realpath-escape', 'include-not-regular', 'fragment-invalid-utf8',
  'fragment-invalid-json', 'duplicate-json-key', 'nested-include', 'root-only-key', 'unknown-key',
  'invalid-source-shape', 'cross-source-conflict',
])

const ENTRY_NAMES = Object.freeze(['.true-up.json', 'true-up.config.json'])
const ROOT_SCALARS = Object.freeze(['out', 'symbols', 'strictSpans', 'deadlineMs', 'repoId', '$schema'])
const DECLARATIONS = Object.freeze(['facts', 'zones', 'seed', 'imports', 'exports'])
const ROOT_KEYS = new Set(['compositionVersion', 'include', 'zones', ...ROOT_SCALARS, 'facts', 'seed', 'imports', 'exports'])
const FRAGMENT_KEYS = new Set(DECLARATIONS)
const FRAGMENT_ROOT_ONLY = new Set(ROOT_SCALARS)
const VISIBILITY = new Set(['public', 'internal', 'private', 'secret'])
const FORBIDDEN_INCLUDE_ROOTS = new Set(['.git', '.jj', '.true-up'])
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// Plain assignment for every key except literal '__proto__', where assignment would mutate the
// prototype instead of creating an own property. defineProperty everywhere is semantically identical
// but an order of magnitude slower, and this runs per key of every loaded declaration.
const safeSet = (object, key, value) => {
  if (key === '__proto__') {
    Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true })
  } else object[key] = value
}
const pointerEscape = (value) => {
  const text = String(value)
  if (!text.includes('~') && !text.includes('/')) return text
  return text.replaceAll('~', '~0').replaceAll('/', '~1')
}
const pointer = (...parts) => '/' + parts.map(pointerEscape).join('/')
// For strings without UTF-16 surrogate code units, code-unit order equals code-point order equals
// UTF-8 byte order, so plain string comparison is exact and allocation-free. Only strings containing
// units >= 0xD800 (astral pairs or lone surrogates) need the byte-exact Buffer comparison.
const hasSurrogateRange = (value) => {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) >= 0xd800) return true
  return false
}
const utf8Compare = (a, b) => {
  const left = String(a)
  const right = String(b)
  if (!hasSurrogateRange(left) && !hasSurrogateRange(right)) {
    return left < right ? -1 : left > right ? 1 : 0
  }
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) || (left < right ? -1 : left > right ? 1 : 0)
}
const hasUnpairedSurrogate = (value) => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}
// Sort an array of strings in UTF-8 byte order, scanning each string for surrogate-range units once
// (instead of once per pairwise comparison inside the sort). All-clean inputs — the overwhelmingly
// common case for config keys and repo paths — use the engine's native comparator.
const utf8SortStrings = (values) => {
  let clean = true
  for (const value of values) if (hasSurrogateRange(value)) { clean = false; break }
  return clean ? values.sort() : values.sort(utf8Compare)
}
const sortedKeys = (object) => utf8SortStrings(Object.keys(object))
const originCompare = (a, b) => utf8Compare(a.source, b.source) || utf8Compare(a.pointer || '', b.pointer || '')

const deepSort = (value) => {
  if (!Array.isArray(value) && !plainObject(value)) return value
  const output = Array.isArray(value) ? [] : {}
  const stack = [{ input: value, output }]
  while (stack.length) {
    const frame = stack.pop()
    const keys = Array.isArray(frame.input)
      ? Array.from({ length: frame.input.length }, (_, index) => index)
      : sortedKeys(frame.input)
    const children = []
    for (const key of keys) {
      const child = frame.input[key]
      if (Array.isArray(child) || plainObject(child)) {
        const target = Array.isArray(child) ? [] : {}
        safeSet(frame.output, key, target)
        children.push({ input: child, output: target })
      } else safeSet(frame.output, key, child)
    }
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index])
  }
  return output
}

// JSON.stringify is recursive and can throw a raw RangeError for valid, byte-bounded JSON. Emit the
// already-canonical projection iteratively so deeply nested inert metadata cannot escape the loader's
// stable result/error contract. Inputs originate in JSON, so there are no cycles or non-JSON values.
const stringifyJson = (value, { sortKeys = false } = {}) => {
  const chunks = []
  const stack = [{ kind: 'value', value }]
  while (stack.length) {
    const item = stack.pop()
    if (item.kind === 'text') { chunks.push(item.value); continue }
    const current = item.value
    if (!Array.isArray(current) && !plainObject(current)) {
      chunks.push(JSON.stringify(current))
      continue
    }
    const keys = Array.isArray(current)
      ? Array.from({ length: current.length }, (_, index) => index)
      : (sortKeys ? deepSortedEmissionKeys(current) : Object.keys(current))
    stack.push({ kind: 'text', value: Array.isArray(current) ? ']' : '}' })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (index < keys.length - 1) stack.push({ kind: 'text', value: ',' })
      stack.push({ kind: 'value', value: current[key] })
      if (!Array.isArray(current)) stack.push({ kind: 'text', value: `${JSON.stringify(key)}:` })
    }
    chunks.push(Array.isArray(current) ? '[' : '{')
  }
  return chunks.join('')
}
// Byte-equivalent to stringifyJson(deepSort(value)) without materializing the sorted copy. That
// equivalence requires emulating JS object key enumeration, not just utf8 order: when deepSort
// inserts keys into its fresh object, the engine surfaces array-index-like keys (canonical integers
// 0..2^32-2) in ascending numeric order ahead of every other key regardless of insertion order,
// while the remaining keys keep deepSort's utf8 insertion order.
const isArrayIndexKey = (key) => {
  if (key === '0') return true
  if (!/^[1-9][0-9]*$/.test(key)) return false
  return Number(key) <= 4294967294
}
const deepSortedEmissionKeys = (object) => {
  const indexKeys = []
  const stringKeys = []
  for (const key of Object.keys(object)) (isArrayIndexKey(key) ? indexKeys : stringKeys).push(key)
  indexKeys.sort((a, b) => Number(a) - Number(b))
  return indexKeys.concat(utf8SortStrings(stringKeys))
}
const stringifyJsonSorted = (value) => stringifyJson(value, { sortKeys: true })

export class ConfigLoadError extends Error {
  constructor(code, detail = {}) {
    const source = detail.source || null
    const at = detail.pointer || null
    super(`${code}${source ? ` in ${source}` : ''}${at ? ` at ${at}` : ''}`)
    Object.defineProperty(this, 'name', { value: 'ConfigLoadError', configurable: true })
    this.code = code
    this.trueUpKind = 'invalid-config'
    for (const key of ['source', 'pointer', 'includeChain', 'origins', 'location', 'conflicts']) {
      if (detail[key] !== undefined) this[key] = detail[key]
    }
  }

  toJSON() {
    return Object.fromEntries(Object.entries(this))
  }
}

const fail = (code, detail) => { throw new ConfigLoadError(code, detail) }

const inside = (root, candidate) => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const readAtMost = (fd, maxBytes = Infinity) => {
  const chunks = []
  let total = 0
  const finite = Number.isFinite(maxBytes)
  const ceiling = finite ? maxBytes + 1 : Infinity
  for (;;) {
    const remaining = ceiling - total
    if (remaining <= 0) break
    const size = finite ? Math.min(64 * 1024, remaining) : 64 * 1024
    const chunk = Buffer.allocUnsafe(size)
    const count = readSync(fd, chunk, 0, size, null)
    if (!count) break
    chunks.push(chunk.subarray(0, count))
    total += count
  }
  return Buffer.concat(chunks, total)
}

// Node-backed provider for production. Tests can inject a provider with the same two-method surface.
// It never enumerates the repository and never writes. Includes are component-lstat'd before opening;
// O_NOFOLLOW closes the final-component race, fstat rejects non-regular inputs, and the opened target's
// real path is checked before any bytes are read.
export function createNodeConfigProvider({
  repoRoot,
  entryNames = ENTRY_NAMES,
  isIgnored,
  trackingState = () => null,
  onRead = () => {},
} = {}) {
  const rootAbs = resolve(repoRoot)
  const rootReal = realpathSync(rootAbs)
  const descriptorRoot = existsSync('/proc/self/fd') ? '/proc/self/fd' : (existsSync('/dev/fd') ? '/dev/fd' : null)
  const ignored = isIgnored || ((repoPath) => {
    const result = spawnSync('git', ['-C', rootReal, 'check-ignore', '-q', '--', repoPath], { stdio: 'ignore' })
    if (result.status === 0) return true
    if (result.status === 1) return false
    throw new Error('ignore classification unavailable')
  })

  const includeResult = (repoPath, extra = {}) => ({ path: repoPath, tracking: trackingState(repoPath), ...extra })
  const inspectInclude = (repoPath, maxBytes) => {
    if (ignored(repoPath)) return includeResult(repoPath, { kind: 'regular', ignored: true })
    if (!descriptorRoot) return includeResult(repoPath, { kind: 'not-regular' })

    const parts = repoPath.split('/')
    let directoryFd = null
    let fileFd = null
    try {
      directoryFd = openSync(rootReal, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0))
      for (const part of parts.slice(0, -1)) {
        const candidate = `${descriptorRoot}/${directoryFd}/${part}`
        let stat
        try { stat = lstatSync(candidate) }
        catch { return includeResult(repoPath, { kind: 'missing' }) }
        if (stat.isSymbolicLink()) return includeResult(repoPath, { kind: 'symlink' })
        if (!stat.isDirectory()) return includeResult(repoPath, { kind: 'not-regular' })
        let nextFd = null
        try {
          nextFd = openSync(candidate, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0))
          if (!fstatSync(nextFd).isDirectory()) {
            closeSync(nextFd)
            nextFd = null
            return includeResult(repoPath, { kind: 'not-regular' })
          }
        } catch {
          if (nextFd !== null) try { closeSync(nextFd) } catch {}
          try {
            if (lstatSync(candidate).isSymbolicLink()) return includeResult(repoPath, { kind: 'symlink' })
          } catch { return includeResult(repoPath, { kind: 'missing' }) }
          return includeResult(repoPath, { kind: 'not-regular' })
        }
        closeSync(directoryFd)
        directoryFd = nextFd
        nextFd = null
      }

      const candidate = `${descriptorRoot}/${directoryFd}/${parts.at(-1)}`
      let lexicalStat
      try { lexicalStat = lstatSync(candidate) }
      catch { return includeResult(repoPath, { kind: 'missing' }) }
      if (lexicalStat.isSymbolicLink()) return includeResult(repoPath, { kind: 'symlink' })
      if (!lexicalStat.isFile()) return includeResult(repoPath, { kind: 'not-regular' })
      try {
        fileFd = openSync(candidate, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0) | (fsConstants.O_NOFOLLOW || 0))
      } catch {
        try {
          if (lstatSync(candidate).isSymbolicLink()) return includeResult(repoPath, { kind: 'symlink' })
        } catch { return includeResult(repoPath, { kind: 'missing' }) }
        return includeResult(repoPath, { kind: 'not-regular' })
      }
      const stat = fstatSync(fileFd)
      if (!stat.isFile()) return includeResult(repoPath, { kind: 'not-regular' })
      let openedReal
      try { openedReal = realpathSync(`${descriptorRoot}/${fileFd}`) }
      catch { return includeResult(repoPath, { kind: 'not-regular' }) }
      if (!inside(rootReal, openedReal)) return includeResult(repoPath, { kind: 'outside' })
      if (Number.isFinite(maxBytes) && stat.size > maxBytes) {
        return includeResult(repoPath, { kind: 'regular', tooLarge: true, size: stat.size, realInside: true })
      }
      onRead(repoPath)
      const bytes = readAtMost(fileFd, maxBytes)
      return includeResult(repoPath, {
        kind: 'regular',
        bytes,
        tooLarge: Number.isFinite(maxBytes) && bytes.length > maxBytes,
        size: bytes.length,
        realInside: true,
      })
    } finally {
      if (fileFd !== null) try { closeSync(fileFd) } catch {}
      if (directoryFd !== null) try { closeSync(directoryFd) } catch {}
    }
  }

  const inspectAndRead = (repoPath, { role = 'include', maxBytes = Infinity } = {}) => {
    if (role === 'include') return inspectInclude(repoPath, maxBytes)
    const parts = repoPath.split('/')
    let current = rootAbs
    let finalStat = null
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index])
      try { finalStat = lstatSync(current) }
      catch { return { path: repoPath, kind: 'missing', tracking: trackingState(repoPath) } }
      if (finalStat.isSymbolicLink() && !(role === 'entry' && index === parts.length - 1)) {
        return { path: repoPath, kind: 'symlink', tracking: trackingState(repoPath) }
      }
    }

    let realPath
    try { realPath = realpathSync(current) }
    catch { return { path: repoPath, kind: 'missing', tracking: trackingState(repoPath) } }
    const realInside = inside(rootReal, realPath)
    if (role === 'include' && !realInside) return { path: repoPath, kind: 'outside', tracking: trackingState(repoPath) }

    const finalSymlink = !!finalStat?.isSymbolicLink()
    if (!finalSymlink && !finalStat?.isFile()) {
      return { path: repoPath, kind: 'not-regular', realInside, tracking: trackingState(repoPath) }
    }

    let fd = null
    try {
      const noFollow = !finalSymlink ? (fsConstants.O_NOFOLLOW || 0) : 0
      fd = openSync(current, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0) | noFollow)
      const stat = fstatSync(fd)
      if (!stat.isFile()) return { path: repoPath, kind: 'not-regular', realInside, tracking: trackingState(repoPath) }
      let openedReal = realPath
      try { openedReal = realpathSync(`${descriptorRoot || '/proc/self/fd'}/${fd}`) }
      catch {
        try {
          const after = lstatSync(current)
          if (!finalSymlink && (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino)) {
            return { path: repoPath, kind: 'not-regular', tracking: trackingState(repoPath) }
          }
          openedReal = realpathSync(current)
        } catch { return { path: repoPath, kind: finalSymlink ? 'symlink' : 'not-regular', tracking: trackingState(repoPath) } }
      }
      const openedInside = inside(rootReal, openedReal)
      if (role === 'include' && !inside(rootReal, openedReal)) {
        return { path: repoPath, kind: 'outside', tracking: trackingState(repoPath) }
      }
      if (Number.isFinite(maxBytes) && stat.size > maxBytes) {
        return { path: repoPath, kind: finalSymlink ? 'symlink' : 'regular', tooLarge: true, size: stat.size, realInside: openedInside, tracking: trackingState(repoPath) }
      }
      onRead(repoPath)
      const bytes = readAtMost(fd, maxBytes)
      return {
        path: repoPath,
        kind: finalSymlink ? 'symlink' : 'regular',
        bytes,
        tooLarge: Number.isFinite(maxBytes) && bytes.length > maxBytes,
        size: bytes.length,
        realInside: openedInside,
        tracking: trackingState(repoPath),
      }
    } catch {
      return { path: repoPath, kind: finalSymlink ? 'symlink' : 'not-regular', realInside, tracking: trackingState(repoPath) }
    } finally {
      if (fd !== null) try { closeSync(fd) } catch {}
    }
  }

  const selectEntry = () => {
    for (const path of entryNames) {
      if (!existsSync(resolve(rootAbs, path))) continue
      return inspectAndRead(path, { role: 'entry' })
    }
    return null
  }

  return { selectEntry, inspectAndRead }
}

const locationResolver = (text, tick, source) => {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (index > 0 && (index & 4095) === 0) tick(`duplicate-key scan ${source}`)
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return (index) => {
    let low = 0
    let high = starts.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (starts[middle] <= index) low = middle
      else high = middle
    }
    return { line: low + 1, column: index - starts[low] + 1 }
  }
}

const jsonStringAt = (text, start, decode, progress) => {
  let index = start + 1
  let escaped = false
  while (index < text.length) {
    const char = text[index++]
    if (char === '"') break
    if (char === '\\') {
      escaped = true
      index += text[index] === 'u' ? 5 : 1
    }
    progress(index)
  }
  if (!decode) return index
  return {
    end: index,
    value: escaped ? JSON.parse(text.slice(start, index)) : text.slice(start + 1, index - 1),
  }
}

// Mode selection deliberately preserves legacy JSON.parse last-wins behavior. Duplicate-key
// rejection starts only after the parsed object activates composition (contract section 9).
const hasCompositionIntent = (parsed) => plainObject(parsed)
  && (own(parsed, 'compositionVersion') || own(parsed, 'include') || parsed.zones === null)

const syntaxLocation = (error) => {
  const message = String(error?.message || '')
  const lineColumnMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i)
  if (lineColumnMatch) return { line: Number(lineColumnMatch[1]), column: Number(lineColumnMatch[2]) }
  const positionMatch = message.match(/position\s+(\d+)/i)
  return positionMatch ? { offset: Number(positionMatch[1]) } : undefined
}

// JSON.parse provides the standards-complete syntax/value implementation. This scanner runs only on
// already-valid JSON and records decoded object keys, including escaped-equivalent spellings, so
// last-wins semantics cannot hide a duplicate in composed mode.
const assertNoDuplicateKeys = (text, source, includeChain, tick) => {
  let index = 0
  let steps = 0
  let nextProgress = 4096
  let selectedDuplicate = null
  const progress = (offset) => {
    if (offset < nextProgress) return
    tick(`duplicate-key scan ${source}`)
    nextProgress = ((offset >>> 12) + 1) << 12
  }
  const whitespace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
  const skip = () => {
    while (whitespace(text.charCodeAt(index))) {
      index++
      progress(index)
    }
  }
  const stringToken = () => {
    const start = index
    const token = jsonStringAt(text, start, true, progress)
    index = token.end
    return { start, value: token.value }
  }
  const skipString = () => { index = jsonStringAt(text, index, false, progress) }
  const stack = []
  const consumeValue = (at) => {
    skip()
    const char = text[index]
    if (char === '{') {
      index++
      stack.push({ kind: 'object', at, state: 'key', seen: new Map(), keyPointer: null })
      return
    }
    if (char === '[') {
      index++
      stack.push({ kind: 'array', at, state: 'value', item: 0 })
      return
    }
    if (char === '"') { skipString(); return }
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (whitespace(code) || code === 0x2c || code === 0x5d || code === 0x7d) break
      index++
      progress(index)
    }
  }
  skip()
  consumeValue('')
  while (stack.length) {
    if ((++steps & 4095) === 0) tick(`duplicate-key scan ${source}`)
    const frame = stack[stack.length - 1]
    skip()
    if (frame.kind === 'object') {
      if (frame.state === 'key') {
        if (text[index] === '}') { index++; stack.pop(); continue }
        const key = stringToken()
        frame.keyPointer = `${frame.at}/${pointerEscape(key.value)}`
        const first = frame.seen.get(key.value)
        if (first === undefined) {
          frame.seen.set(key.value, key.start)
        } else if (!selectedDuplicate) {
          selectedDuplicate = {
            scope: frame.seen,
            key: key.value,
            pointer: frame.keyPointer,
            starts: [first, key.start],
          }
        } else if (selectedDuplicate.scope === frame.seen && selectedDuplicate.key === key.value) {
          selectedDuplicate.starts.push(key.start)
        }
        frame.state = 'colon'
      } else if (frame.state === 'colon') {
        index++ // colon (syntax already validated by JSON.parse)
        frame.state = 'value'
      } else if (frame.state === 'value') {
        frame.state = 'comma'
        consumeValue(frame.keyPointer)
      } else if (text[index] === '}') {
        index++
        stack.pop()
      } else {
        index++ // comma
        frame.state = 'key'
      }
    } else if (frame.state === 'value') {
      if (text[index] === ']') { index++; stack.pop(); continue }
      const itemPointer = `${frame.at}/${frame.item++}`
      frame.state = 'comma'
      consumeValue(itemPointer)
    } else if (text[index] === ']') {
      index++
      stack.pop()
    } else {
      index++ // comma
      frame.state = 'value'
    }
  }
  if (selectedDuplicate) {
    const locate = locationResolver(text, tick, source)
    const origins = selectedDuplicate.starts.map((start) => ({ source, pointer: selectedDuplicate.pointer, ...locate(start) }))
    fail('duplicate-json-key', { source, pointer: selectedDuplicate.pointer, includeChain, origins })
  }
}

const parseStrict = (bytes, source, role, includeChain, tick = () => {}) => {
  let text
  try { text = decoder.decode(bytes) }
  catch { fail(role === 'root' ? 'root-invalid-utf8' : 'fragment-invalid-utf8', { source, includeChain }) }
  let data
  try { data = JSON.parse(text) }
  catch (error) {
    fail(role === 'root' ? 'root-invalid-json' : 'fragment-invalid-json', { source, includeChain, location: syntaxLocation(error) })
  }
  assertNoDuplicateKeys(text, source, includeChain, tick)
  return data
}

const validateFacts = (facts, source, includeChain) => {
  if (!plainObject(facts)) fail('invalid-source-shape', { source, pointer: '/facts', includeChain })
  for (const path of sortedKeys(facts)) {
    const selectors = facts[path]
    if (!Array.isArray(selectors)) fail('invalid-source-shape', { source, pointer: pointer('facts', path), includeChain })
    selectors.forEach((selector, index) => {
      if (!Array.isArray(selector) || selector.length !== 2 || selector.some((item) => typeof item !== 'string')) {
        fail('invalid-source-shape', { source, pointer: pointer('facts', path, index), includeChain })
      }
    })
    normalizeDeclarationPath(path, source, pointer('facts', path), { includeChain })
  }
}

const validateZones = (zones, source, includeChain) => {
  if (!Array.isArray(zones)) fail('invalid-source-shape', { source, pointer: '/zones', includeChain })
  zones.forEach((zone, index) => {
    const base = pointer('zones', index)
    if (!plainObject(zone)) fail('invalid-source-shape', { source, pointer: base, includeChain })
    if (own(zone, 'audience') && typeof zone.audience !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/audience`, includeChain })
    if (own(zone, 'intent') && typeof zone.intent !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/intent`, includeChain })
    if (typeof zone.path !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/path`, includeChain })
    normalizeDeclarationPath(zone.path, source, `${base}/path`, { allowEmpty: true, includeChain })
    if (own(zone, 'rules') && (!Array.isArray(zone.rules) || zone.rules.some((rule) => typeof rule !== 'string'))) fail('invalid-source-shape', { source, pointer: `${base}/rules`, includeChain })
    if (own(zone, 'visibility') && !VISIBILITY.has(zone.visibility)) fail('invalid-source-shape', { source, pointer: `${base}/visibility`, includeChain })
  })
}

const validateSeed = (seed, source, includeChain) => {
  if (!Array.isArray(seed)) fail('invalid-source-shape', { source, pointer: '/seed', includeChain })
  const normalized = []
  seed.forEach((edge, index) => {
    const base = pointer('seed', index)
    if (!plainObject(edge)) fail('invalid-source-shape', { source, pointer: base, includeChain })
    if (typeof edge.from !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/from`, includeChain })
    const from = normalizeDeclarationPath(edge.from, source, `${base}/from`, { includeChain })
    if (own(edge, 'kind') && typeof edge.kind !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/kind`, includeChain })
    if (typeof edge.to !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/to`, includeChain })
    const to = normalizeDeclarationPath(edge.to, source, `${base}/to`, { allowImported: true, splitFact: true, includeChain })
    let via
    if (own(edge, 'via')) {
      if (typeof edge.via !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/via`, includeChain })
      via = normalizeDeclarationPath(edge.via, source, `${base}/via`, { includeChain })
    }
    normalized.push({ ...edge, from, to, ...(own(edge, 'via') ? { via } : {}) })
  })
  return normalized
}

const validateImports = (imports, source, includeChain) => {
  if (!plainObject(imports)) fail('invalid-source-shape', { source, pointer: '/imports', includeChain })
  for (const alias of sortedKeys(imports)) {
    const base = pointer('imports', alias)
    if (hasUnpairedSurrogate(alias)) fail('invalid-source-shape', { source, pointer: base, includeChain })
    const spec = imports[alias]
    if (!plainObject(spec)) fail('invalid-source-shape', { source, pointer: base, includeChain })
    if (own(spec, 'audience') && typeof spec.audience !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/audience`, includeChain })
    if (typeof spec.path !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/path`, includeChain })
    normalizeDeclarationPath(spec.path, source, `${base}/path`, { includeChain })
    if (own(spec, 'repoId') && typeof spec.repoId !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/repoId`, includeChain })
  }
}

const validateExports = (exports, source, includeChain) => {
  if (!Array.isArray(exports)) fail('invalid-source-shape', { source, pointer: '/exports', includeChain })
  exports.forEach((item, index) => {
    const base = pointer('exports', index)
    if (!plainObject(item)) fail('invalid-source-shape', { source, pointer: base, includeChain })
    if (own(item, 'audience') && typeof item.audience !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/audience`, includeChain })
    if (own(item, 'declassify') && typeof item.declassify !== 'boolean') fail('invalid-source-shape', { source, pointer: `${base}/declassify`, includeChain })
    if (typeof item.from !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/from`, includeChain })
    normalizeDeclarationPath(item.from, source, `${base}/from`, { allowImported: true, splitFact: true, includeChain })
    if (typeof item.id !== 'string') fail('invalid-source-shape', { source, pointer: `${base}/id`, includeChain })
    if (hasUnpairedSurrogate(item.id)) fail('invalid-source-shape', { source, pointer: `${base}/id`, includeChain })
  })
}

const validateDeclarations = (data, source, { skipZones = false, includeChain = [source] } = {}) => {
  const normalized = {}
  if (own(data, 'facts')) validateFacts(data.facts, source, includeChain)
  if (!skipZones && own(data, 'zones')) validateZones(data.zones, source, includeChain)
  if (own(data, 'seed')) normalized.seed = validateSeed(data.seed, source, includeChain)
  if (own(data, 'imports')) validateImports(data.imports, source, includeChain)
  if (own(data, 'exports')) validateExports(data.exports, source, includeChain)
  return normalized
}

const validateRoot = (data, source) => {
  const includeChain = [source]
  if (!plainObject(data)) fail('invalid-source-shape', { source, pointer: '', includeChain })
  for (const key of sortedKeys(data)) {
    if (key.startsWith('_')) continue
    if (!ROOT_KEYS.has(key)) fail('unknown-key', { source, pointer: pointer(key), includeChain })
  }
  for (const key of ROOT_SCALARS.slice().sort(utf8Compare)) {
    if (!own(data, key)) continue
    const valid = key === 'deadlineMs'
      ? typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0
      : (key === 'symbols' || key === 'strictSpans' ? typeof data[key] === 'boolean' : typeof data[key] === 'string')
    if (!valid) fail('invalid-source-shape', { source, pointer: pointer(key), includeChain })
  }
  // In composed roots `zones: null` is the activation sentinel, not a zone declaration.
  // Fragment zones remain ordinary arrays and are validated by validateFragment below.
  return validateDeclarations(data, source, { skipZones: true, includeChain })
}

const validateFragment = (data, source, entryPath) => {
  const includeChain = [entryPath, source]
  if (!plainObject(data)) fail('invalid-source-shape', { source, pointer: '', includeChain })
  if (own(data, 'include') || own(data, 'compositionVersion')) {
    fail('nested-include', { source, pointer: own(data, 'include') ? '/include' : '/compositionVersion', includeChain })
  }
  for (const key of sortedKeys(data)) {
    if (key.startsWith('_')) continue
    if (FRAGMENT_ROOT_ONLY.has(key)) fail('root-only-key', { source, pointer: pointer(key), includeChain })
    if (!FRAGMENT_KEYS.has(key)) fail('unknown-key', { source, pointer: pointer(key), includeChain })
  }
  return validateDeclarations(data, source, { includeChain })
}

const normalizeInclude = (raw, entryPath, index) => {
  const detail = { source: entryPath, pointer: pointer('include', index), includeChain: [entryPath] }
  if (raw.length === 0) fail('include-path-empty', detail)
  if (raw.includes('\0')) fail('include-path-nul', detail)
  if (hasUnpairedSurrogate(raw)) fail('include-path-invalid-unicode', detail)
  if (raw.includes('\\')) fail('include-path-backslash', detail)
  if (raw.startsWith('/') || raw.startsWith('//') || /^[A-Za-z]:\//.test(raw)) fail('include-path-absolute', detail)
  const normalized = posix.normalize(raw)
  if (normalized === '..' || normalized.startsWith('../')) fail('include-path-escape', detail)
  if (normalized === entryPath) fail('include-root', detail)
  const first = normalized.split('/')[0]
  if (FORBIDDEN_INCLUDE_ROOTS.has(first)) fail('include-forbidden-location', detail)
  return normalized
}

const normalizeDeclarationPath = (raw, source, at, {
  allowEmpty = false,
  allowImported = false,
  splitFact = false,
  includeChain = [source],
} = {}) => {
  if (hasUnpairedSurrogate(raw)) fail('invalid-source-shape', { source, pointer: at, includeChain })
  if (allowImported && raw.startsWith('@')) return raw
  const hash = splitFact ? raw.indexOf('#') : -1
  const path = hash < 0 ? raw : raw.slice(0, hash)
  const suffix = hash < 0 ? '' : raw.slice(hash)
  if ((!allowEmpty && path.length === 0)
    || path.includes('\0')
    || path.includes('\\')
    || path.startsWith('/')
    || path.startsWith('//')
    || /^[A-Za-z]:\//.test(path)) {
    fail('invalid-source-shape', { source, pointer: at, includeChain })
  }
  const normalized = path === '' ? '' : posix.normalize(path)
  if (normalized === '..' || normalized.startsWith('../')) {
    fail('invalid-source-shape', { source, pointer: at, includeChain })
  }
  return normalized + suffix
}

const sourceMeta = (record) => ({
  path: record.path,
  role: record.role,
  bytes: record.bytes.length,
  hash: sha256(record.bytes),
  tracking: record.tracking ?? null,
})

const declarationOrigin = (source, section, key) => ({ source, pointer: pointer(section, key) })

const mergeComposed = (entryPath, rootData, records) => {
  const config = { compositionVersion: 1, include: records.filter((record) => record.role === 'fragment').map((record) => record.path) }
  for (const scalar of ROOT_SCALARS) if (own(rootData, scalar)) config[scalar] = rootData[scalar]

  const provenance = { facts: {}, zones: [], seed: [], imports: {}, exports: [] }
  const owners = new Map()
  const noteOwner = (key, origin, { identity = key, uniqueWithinSource = false } = {}) => {
    const state = owners.get(key) || { identity, origins: [], uniqueWithinSource: false }
    state.origins.push(origin)
    state.uniqueWithinSource ||= uniqueWithinSource
    owners.set(key, state)
  }

  for (const record of records) {
    const { data, normalized, path: source } = record
    const includeChain = source === entryPath ? [entryPath] : [entryPath, source]
    if (own(data, 'facts')) {
      config.facts ||= {}
      for (const rawKey of sortedKeys(data.facts)) {
        const origin = declarationOrigin(source, 'facts', rawKey)
        const key = normalizeDeclarationPath(rawKey, source, origin.pointer, { includeChain })
        safeSet(config.facts, key, data.facts[rawKey])
        safeSet(provenance.facts, key, origin)
        noteOwner(`facts:${key}`, origin, { uniqueWithinSource: true })
      }
    }
    if (Array.isArray(data.zones)) {
      for (let index = 0; index < data.zones.length; index++) {
        config.zones ||= []
        const origin = declarationOrigin(source, 'zones', index)
        const zone = { ...data.zones[index], path: normalizeDeclarationPath(data.zones[index].path, source, `${origin.pointer}/path`, { allowEmpty: true, includeChain }) }
        config.zones.push(zone)
        provenance.zones.push(origin)
        noteOwner(`zones:${zone.path}`, origin)
      }
    }
    if (own(data, 'seed')) {
      config.seed ||= []
      for (let index = 0; index < data.seed.length; index++) {
        const edge = normalized.seed[index]
        config.seed.push(edge)
        const origin = declarationOrigin(source, 'seed', index)
        provenance.seed.push(origin)
        noteOwner(`seed:${JSON.stringify([edge.from, edge.to])}`, origin, { identity: `seed:${edge.from}\0${edge.to}` })
      }
    }
    if (own(data, 'imports')) {
      config.imports ||= {}
      for (const alias of sortedKeys(data.imports)) {
        const spec = data.imports[alias]
        const normalizedSpec = {
          ...spec,
          path: normalizeDeclarationPath(spec.path, source, pointer('imports', alias, 'path'), { includeChain }),
        }
        safeSet(config.imports, alias, normalizedSpec)
        const origin = declarationOrigin(source, 'imports', alias)
        safeSet(provenance.imports, alias, origin)
        noteOwner(`imports:${alias}`, origin)
      }
    }
    if (own(data, 'exports')) {
      config.exports ||= []
      for (let index = 0; index < data.exports.length; index++) {
        const rawItem = data.exports[index]
        const item = {
          ...rawItem,
          from: normalizeDeclarationPath(rawItem.from, source, pointer('exports', index, 'from'), { allowImported: true, splitFact: true, includeChain }),
        }
        config.exports.push(item)
        const origin = declarationOrigin(source, 'exports', index)
        provenance.exports.push(origin)
        noteOwner(`exports:${item.id}`, origin)
      }
    }
  }

  const conflicts = []
  for (const [, state] of [...owners.entries()].sort(([a], [b]) => utf8Compare(a, b))) {
    const sourceCount = new Set(state.origins.map((origin) => origin.source)).size
    if (sourceCount > 1 || (state.uniqueWithinSource && state.origins.length > 1)) {
      conflicts.push({ identity: state.identity, origins: state.origins.slice().sort(originCompare) })
    }
  }
  if (conflicts.length) {
    fail('cross-source-conflict', {
      source: entryPath,
      includeChain: [entryPath],
      conflicts,
      origins: conflicts.flatMap((conflict) => conflict.origins).sort(originCompare),
    })
  }
  return { config, provenance }
}

const groupedArray = (items, identity, normalize = (item) => item) => {
  const groups = new Map()
  for (const item of items || []) {
    const key = identity(item)
    const list = groups.get(key) || []
    list.push(normalize(item))
    groups.set(key, list)
  }
  return utf8SortStrings([...groups.keys()]).flatMap((key) => groups.get(key))
}

// Production semantic oracle. It preserves owner-local multiplicity/order while removing composition
// presentation controls and sorting independent logical-owner groups.
const semanticProjectionRaw = (config) => {
  const projection = {}
  for (const scalar of ROOT_SCALARS) if (own(config, scalar)) projection[scalar] = config[scalar]
  if (own(config, 'facts')) projection.facts = config.facts
  if (own(config, 'zones')) projection.zones = groupedArray(config.zones, (zone) => zone.path)
  if (own(config, 'seed')) {
    projection.seed = groupedArray(config.seed, (edge) => JSON.stringify([edge.from, edge.to]), (edge) => ({ ...edge, kind: own(edge, 'kind') ? edge.kind : 'derives-facts-from' }))
  }
  if (own(config, 'imports')) projection.imports = config.imports
  if (own(config, 'exports')) projection.exports = groupedArray(config.exports, (item) => item.id)
  return projection
}

export function semanticProjection(config) {
  return deepSort(semanticProjectionRaw(config))
}

export function loadConfigBundle({ repoRoot, provider, limits = COMPOSITION_LIMITS, tick = () => {} } = {}) {
  const sourceProvider = provider || createNodeConfigProvider({ repoRoot })
  const maxIncludes = limits?.maxIncludes ?? COMPOSITION_LIMITS.maxIncludes
  const maxIncludedBytes = limits?.maxIncludedBytes ?? COMPOSITION_LIMITS.maxIncludedBytes
  let entry
  try { entry = sourceProvider.selectEntry(ENTRY_NAMES) }
  catch { fail('composition-root-not-regular', { source: ENTRY_NAMES[0], includeChain: [ENTRY_NAMES[0]] }) }
  if (!entry) {
    return { mode: 'legacy', entry: null, config: {}, sources: [], normalizedConfigBytes: '{}\n' }
  }
  if (!plainObject(entry) || !ENTRY_NAMES.includes(entry.path)) {
    fail('composition-root-not-regular', { source: ENTRY_NAMES[0], includeChain: [ENTRY_NAMES[0]] })
  }
  if (!entry.bytes) fail('composition-root-not-regular', { source: entry.path, includeChain: [entry.path] })

  const legacyText = entry.bytes.toString('utf8')
  let legacyData
  try { legacyData = JSON.parse(legacyText) }
  catch (error) { fail('root-invalid-json', { source: entry.path, includeChain: [entry.path], location: syntaxLocation(error) }) }
  const intent = hasCompositionIntent(legacyData)

  const entryMeta = sourceMeta({ ...entry, role: 'entry' })
  if (!intent) {
    return {
      mode: 'legacy',
      entry: entryMeta,
      config: legacyData,
      sources: [entryMeta],
      normalizedConfigBytes: stringifyJsonSorted(legacyData) + '\n',
    }
  }

  if (entry.kind === 'symlink') fail('composition-root-symlink', { source: entry.path, includeChain: [entry.path] })
  if (entry.kind !== 'regular' && entry.kind !== 'outside') fail('composition-root-not-regular', { source: entry.path, includeChain: [entry.path] })
  if (entry.kind === 'outside' || entry.realInside === false) fail('composition-root-realpath-escape', { source: entry.path, includeChain: [entry.path] })
  const rootData = parseStrict(entry.bytes, entry.path, 'root', [entry.path], tick)
  tick('composition root parsed')

  const sentinelDetail = (at) => ({ source: entry.path, pointer: at, includeChain: [entry.path] })
  if (!plainObject(rootData) || rootData.compositionVersion !== 1) fail('composition-sentinel-invalid', sentinelDetail('/compositionVersion'))
  if (!Array.isArray(rootData.include) || rootData.include.length === 0) fail('composition-sentinel-invalid', sentinelDetail('/include'))
  const invalidInclude = rootData.include.findIndex((item) => typeof item !== 'string')
  if (invalidInclude >= 0) fail('composition-sentinel-invalid', sentinelDetail(pointer('include', invalidInclude)))
  if (rootData.zones !== null) fail('composition-sentinel-invalid', sentinelDetail('/zones'))
  if (rootData.include.length > maxIncludes) {
    fail('include-count-limit', { source: entry.path, pointer: '/include', includeChain: [entry.path] })
  }
  const rootNormalized = validateRoot(rootData, entry.path)

  const normalized = rootData.include.map((path, index) => ({ path: normalizeInclude(path, entry.path, index), index }))
  const byPath = new Map()
  for (const item of normalized) {
    const key = Buffer.from(item.path).toString('hex')
    const group = byPath.get(key) || { path: item.path, items: [] }
    group.items.push(item)
    byPath.set(key, group)
  }
  for (const { items } of [...byPath.values()].sort((a, b) => utf8Compare(a.path, b.path))) {
    if (items.length > 1) {
      fail('include-path-duplicate', {
        source: entry.path,
        pointer: '/include',
        includeChain: [entry.path],
        origins: items.map((item) => ({ source: entry.path, pointer: pointer('include', item.index) })),
      })
    }
  }

  const fragments = utf8SortStrings(normalized.map((item) => item.path))
  // A production provider may classify ignore/tracking state through a VCS subprocess. Give it the
  // complete deterministic include set once so it can batch that query instead of spawning once per
  // fragment. Injected/test providers need not implement this optional read-only hook.
  if (typeof sourceProvider.prepareIncludes === 'function') sourceProvider.prepareIncludes(fragments)
  const records = [{ path: entry.path, role: 'entry', bytes: entry.bytes, tracking: entry.tracking, data: rootData, normalized: rootNormalized }]
  let includedBytes = 0
  for (const path of fragments) {
    tick(`composition fragment ${path}`)
    const remaining = maxIncludedBytes - includedBytes
    const detail = { source: path, pointer: pointer('include', normalized.find((item) => item.path === path).index), includeChain: [entry.path, path] }
    let inspected
    try { inspected = sourceProvider.inspectAndRead(path, { role: 'include', maxBytes: remaining }) }
    catch { fail('include-not-regular', detail) }
    if (!plainObject(inspected)) fail('include-not-regular', detail)
    if (inspected.ignored) fail('include-ignored', detail)
    if (inspected.kind === 'missing') fail('include-missing', detail)
    if (inspected.kind === 'symlink') fail('include-symlink', detail)
    if (inspected.kind === 'outside') fail('include-realpath-escape', detail)
    if (inspected.kind !== 'regular') fail('include-not-regular', detail)
    if (inspected.tooLarge || !inspected.bytes || inspected.bytes.length > remaining) fail('include-bytes-limit', detail)
    includedBytes += inspected.bytes.length
    const data = parseStrict(inspected.bytes, path, 'fragment', [entry.path, path], tick)
    const fragmentNormalized = validateFragment(data, path, entry.path)
    records.push({ path, role: 'fragment', bytes: inspected.bytes, tracking: inspected.tracking, data, normalized: fragmentNormalized })
  }

  records.sort((a, b) => utf8Compare(a.path, b.path))
  tick('composition merge')
  const merged = mergeComposed(entry.path, rootData, records)
  const config = merged.config
  const projection = semanticProjectionRaw(config)
  const sources = records.map(sourceMeta)
  return {
    mode: 'composed',
    entry: sources.find((source) => source.role === 'entry'),
    composition: { version: 1, fragments, fragmentCount: fragments.length, includedBytes },
    config,
    effective: {
      out: own(config, 'out') ? config.out : '.true-up/depgraph.json',
      symbols: own(config, 'symbols') ? config.symbols : false,
      strictSpans: own(config, 'strictSpans') ? config.strictSpans : false,
      deadlineMs: own(config, 'deadlineMs') ? config.deadlineMs : 600000,
    },
    normalizedConfigBytes: stringifyJsonSorted(projection) + '\n',
    sources,
    provenance: merged.provenance,
  }
}
