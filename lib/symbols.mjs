// lib/symbols.mjs — Tier 2: OPTIONAL tree-sitter symbol extraction.
//
// The zero-dep core (engine.mjs) STATIC-imports this module, but this module only pulls in
// web-tree-sitter LAZILY, inside initSymbols() — so a bare clone with no node_modules still runs
// every core command. Symbol extraction is opt-in via `.true-up.json` "symbols": true; when enabled
// but the optional deps are absent, the engine fails LOUD (exit 2) rather than silently producing a
// different graph (determinism over convenience).
//
// Why config-driven (not a transient --symbols flag): the symbol set is part of the graph, and the
// graph must be reproducible. A repo that commits its graph with symbols on must build identically
// for every collaborator — so the switch lives in the tracked config, exactly like facts/zones/seed.
//
// Determinism: web-tree-sitter@0.24.7 + tree-sitter-wasms@0.1.13 are EXACT-pinned (optionalDependencies
// + committed lockfile). A symbol fact's hash is its source-span bytes, stable given a pinned grammar.
//
// Edges stay EXPLICIT (the core invariant): tree-sitter only produces better NODES (addressable,
// content-hashed code symbols). It NEVER assigns an edge — a doc still has to anchor with
// <!-- fact: path#Symbol --> for an advisory edge to exist. Correlation never assigns the arrow.

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const sha256 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// ext -> { wasm grammar, defs: the named-definition node types we lift to facts }.
// Field-name languages (py/rs/go/js/ts) resolve the name cleanly; C/C++ names live in a declarator.
const LANGS = {
  '.py': { wasm: 'tree-sitter-python.wasm', defs: ['function_definition', 'class_definition'] },
  '.rs': { wasm: 'tree-sitter-rust.wasm', defs: ['function_item', 'struct_item', 'enum_item', 'trait_item', 'type_item', 'const_item', 'static_item', 'mod_item', 'macro_definition', 'union_item'] },
  '.go': { wasm: 'tree-sitter-go.wasm', defs: ['function_declaration', 'method_declaration', 'type_declaration'] },
  '.js': { wasm: 'tree-sitter-javascript.wasm', defs: ['function_declaration', 'class_declaration', 'generator_function_declaration'] },
  '.mjs': { wasm: 'tree-sitter-javascript.wasm', defs: ['function_declaration', 'class_declaration', 'generator_function_declaration'] },
  '.ts': { wasm: 'tree-sitter-typescript.wasm', defs: ['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'abstract_class_declaration'] },
  '.c': { wasm: 'tree-sitter-c.wasm', defs: ['function_definition'] },
  '.h': { wasm: 'tree-sitter-c.wasm', defs: ['function_definition'] },
  '.cc': { wasm: 'tree-sitter-cpp.wasm', defs: ['function_definition', 'class_specifier', 'struct_specifier'] },
  '.cpp': { wasm: 'tree-sitter-cpp.wasm', defs: ['function_definition', 'class_specifier', 'struct_specifier'] },
  '.hpp': { wasm: 'tree-sitter-cpp.wasm', defs: ['function_definition', 'class_specifier', 'struct_specifier'] },
}
const WRAPPERS = /^(decorated_definition|export_statement|declaration_list|linkage_specification|template_declaration|namespace_definition)$/
// Control-flow / type keywords a C/C++ declarator heuristic can mis-grab as a "name" (e.g. an `if`
// statement parsed as a definition). A real definition is never named one of these — drop them.
const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'case', 'default', 'do', 'return', 'break', 'continue', 'goto', 'try', 'catch', 'throw', 'sizeof', 'typedef', 'using', 'namespace', 'template', 'operator'])

export const symbolExts = () => Object.keys(LANGS)
const extOf = (p) => Object.keys(LANGS).find((x) => p.endsWith(x)) || null

let RT = null // { parsers: Map<ext, {parser, defs:Set}>, version }

// Load the runtime + the grammars for the given extensions. Returns {ok, version} or {ok:false,error}.
export async function initSymbols(exts) {
  const require = createRequire(import.meta.url)
  let TS, wasmDir, version
  try {
    const mod = await import('web-tree-sitter')
    TS = mod.default || mod
    wasmDir = require.resolve('tree-sitter-wasms/package.json').replace(/package\.json$/, 'out/')
    version = require('tree-sitter-wasms/package.json').version
  } catch {
    return { ok: false, error: 'tree-sitter not installed' }
  }
  const Parser = TS.Parser || TS
  try { await Parser.init() } catch (e) { return { ok: false, error: 'tree-sitter init failed: ' + e.message } }
  // NB: in web-tree-sitter 0.24 the static `Language` is attached DURING init() — read it after.
  const Language = TS.Language || Parser.Language
  if (!Language) return { ok: false, error: 'web-tree-sitter Language API not found' }
  const parsers = new Map()
  for (const ext of new Set(exts)) {
    const spec = LANGS[ext]
    if (!spec || parsers.has(ext)) continue
    try {
      const lang = await Language.load(wasmDir + spec.wasm)
      const parser = new Parser()
      parser.setLanguage(lang)
      parsers.set(ext, { parser, defs: new Set(spec.defs) })
    } catch { /* grammar unavailable for this ext — its anchors will fail-loud, which is correct */ }
  }
  RT = { parsers, version }
  return { ok: true, version }
}

// Definition name: prefer the 'name' field; for C/C++ the name is the last identifier in the declarator.
function nameOf(node) {
  const nf = node.childForFieldName && node.childForFieldName('name')
  if (nf) return nf.text
  if (!node.descendantsOfType) return null
  const decl = node.descendantsOfType('function_declarator')[0]
  if (!decl) return null
  for (const t of ['qualified_identifier', 'field_identifier', 'identifier', 'destructor_name', 'operator_name']) {
    const ids = decl.descendantsOfType(t)
    if (ids && ids.length) return ids[0].text // first within the declarator = the function name
  }
  return null
}

// Top-level named definitions of a file -> { 'fact:path#Name': spanHash }. Unwraps common
// non-scoping wrappers (decorators, exports, namespaces) but does not descend into bodies (nested
// methods are a follow-up; reach them today with a Tier-1 span anchor).
export function extractSymbols(path, content) {
  const out = {}
  if (!RT) return out
  const lp = RT.parsers.get(extOf(path))
  if (!lp) return out
  let tree
  try { tree = lp.parser.parse(content) } catch { return out }
  const lift = (node) => {
    for (const child of node.namedChildren) {
      if (lp.defs.has(child.type)) {
        const nm = nameOf(child)
        if (nm && !KEYWORDS.has(nm)) out[`fact:${path}#${nm}`] = sha256(child.text)
      } else if (WRAPPERS.test(child.type)) {
        lift(child)
      }
    }
  }
  lift(tree.rootNode)
  return out
}
