#!/usr/bin/env node
/**
 * Durable local harness registration for the Hivemind PR-review swarm.
 *
 * Invoked by the installers as:
 *   node <engine>/src/harness-registration.mjs --config-dir <opencode-config-dir>
 *
 * What it fixes, narrowly and idempotently:
 *   1. If the hivemind-architect's effective subagent permission for
 *      `pr-reviewer` is denied, append the explicit allow LAST (V2 permission
 *      arrays are order-sensitive).
 *   2. If the global pr-reviewer entry has no model, default it from the
 *      configured researcher or builder model. An explicitly configured
 *      reviewer model is never overwritten.
 *   3. Ensure the global pr-reviewer entry is read-only (deny-all permissions).
 *   4. Stamp the installed reviewer agent frontmatter model from the chosen
 *      configured model. A frontmatter model overrides the global JSON model,
 *      so leaving the source default in place silently selects the wrong
 *      provider.
 *
 * The opencode.json file is JSONC. Comments and trailing commas are parsed and
 * the original text is patched surgically, so unrelated settings, comments,
 * formatting, and line endings are preserved. Any parse failure aborts before a
 * single byte is written.
 *
 * No network, no live harness, and no dependency on the repository checkout.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DENY_ALL = Object.freeze([{ action: '*', resource: '*', effect: 'deny' }])
const REVIEWER_ALLOW = Object.freeze({
  action: 'subagent',
  resource: 'pr-reviewer',
  effect: 'allow'
})

export class JsoncParseError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'JsoncParseError'
    this.offset = details.offset
    this.line = details.line
    this.column = details.column
  }
}

/* -------------------------------------------------------------------------- */
/* JSONC parser (positions retained for surgical text patching)               */
/* -------------------------------------------------------------------------- */

function lineColumn(text, offset) {
  const before = text.slice(0, offset)
  const line = before.split(/\r\n|\r|\n/).length
  const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'))
  return { line, column: offset - lastBreak }
}

export function parseJsonc(text, source = 'opencode.json') {
  let i = 0
  let hadComments = false
  const limit = text.length

  function fail(message) {
    const pos = lineColumn(text, i)
    throw new JsoncParseError(
      `${source}: ${message} at line ${pos.line}, column ${pos.column}`,
      { offset: i, line: pos.line, column: pos.column }
    )
  }

  function skipTrivia() {
    while (i < limit) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++
        continue
      }
      if (c === '/' && text[i + 1] === '/') {
        hadComments = true
        i += 2
        while (i < limit && text[i] !== '\n' && text[i] !== '\r') i++
        continue
      }
      if (c === '/' && text[i + 1] === '*') {
        hadComments = true
        i += 2
        while (i < limit && !(text[i] === '*' && text[i + 1] === '/')) i++
        if (i >= limit) fail('unterminated block comment')
        i += 2
        continue
      }
      break
    }
  }

  function parseStringNode() {
    const start = i
    if (text[i] !== '"') fail('expected a double-quoted string')
    i++
    let escaped = false
    while (i < limit) {
      const c = text[i]
      if (escaped) {
        escaped = false
        i++
        continue
      }
      if (c === '\\') {
        escaped = true
        i++
        continue
      }
      if (c === '"') {
        i++
        const raw = text.slice(start, i)
        let value
        try {
          value = JSON.parse(raw)
        } catch {
          fail('invalid string literal')
        }
        return { type: 'string', start, end: i, value }
      }
      if (c === '\n' || c === '\r') fail('newline inside a string literal')
      i++
    }
    fail('unterminated string literal')
  }

  function parseNumberNode() {
    const start = i
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(i)
    )
    if (!match) fail('invalid number')
    i += match[0].length
    return { type: 'number', start, end: i, value: Number(match[0]) }
  }

  function parseLiteralNode(literal, value) {
    if (text.slice(i, i + literal.length) !== literal) {
      fail(`expected '${literal}'`)
    }
    const start = i
    i += literal.length
    return { type: 'literal', start, end: i, value }
  }

  function parseObjectNode() {
    const start = i
    i++ // {
    const properties = []
    skipTrivia()
    if (text[i] === '}') {
      i++
      return { type: 'object', start, end: i, properties }
    }
    while (true) {
      skipTrivia()
      if (text[i] !== '"') fail('expected an object property name')
      const keyNode = parseStringNode()
      skipTrivia()
      if (text[i] !== ':') fail("expected ':' after an object property name")
      i++
      skipTrivia()
      const valueNode = parseValueNode()
      properties.push({ key: keyNode.value, keyNode, value: valueNode })
      skipTrivia()
      if (text[i] === ',') {
        i++
        skipTrivia()
        if (text[i] === '}') {
          i++
          return { type: 'object', start, end: i, properties }
        }
        continue
      }
      if (text[i] === '}') {
        i++
        return { type: 'object', start, end: i, properties }
      }
      fail("expected ',' or '}' in object")
    }
  }

  function parseArrayNode() {
    const start = i
    i++ // [
    const items = []
    skipTrivia()
    if (text[i] === ']') {
      i++
      return { type: 'array', start, end: i, items }
    }
    while (true) {
      skipTrivia()
      items.push(parseValueNode())
      skipTrivia()
      if (text[i] === ',') {
        i++
        skipTrivia()
        if (text[i] === ']') {
          i++
          return { type: 'array', start, end: i, items }
        }
        continue
      }
      if (text[i] === ']') {
        i++
        return { type: 'array', start, end: i, items }
      }
      fail("expected ',' or ']' in array")
    }
  }

  function parseValueNode() {
    skipTrivia()
    const c = text[i]
    if (c === '{') return parseObjectNode()
    if (c === '[') return parseArrayNode()
    if (c === '"') return parseStringNode()
    if (c === 't') return parseLiteralNode('true', true)
    if (c === 'f') return parseLiteralNode('false', false)
    if (c === 'n') return parseLiteralNode('null', null)
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumberNode()
    if (i >= limit) fail('unexpected end of input')
    fail(`unexpected character '${c}'`)
  }

  skipTrivia()
  const root = parseValueNode()
  skipTrivia()
  if (i !== limit) fail('unexpected trailing content')

  return { root, value: nodeToValue(root), hadComments }
}

function nodeToValue(node) {
  if (node.type === 'object') {
    const out = {}
    for (const prop of node.properties) {
      Object.defineProperty(out, prop.key, {
        value: nodeToValue(prop.value),
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
    return out
  }
  if (node.type === 'array') return node.items.map(nodeToValue)
  return node.value
}

/* -------------------------------------------------------------------------- */
/* Surgical text editing helpers                                              */
/* -------------------------------------------------------------------------- */

function newlineFor(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function lineIndent(text, offset) {
  const start = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1
  const match = /^[ \t]*/.exec(text.slice(start, offset))
  return match ? match[0] : ''
}

/** Strip comments from a small snippet so comma detection is reliable. */
function stripComments(snippet) {
  let out = ''
  let j = 0
  let inString = false
  let escaped = false
  while (j < snippet.length) {
    const c = snippet[j]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      j++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      j++
      continue
    }
    if (c === '/' && snippet[j + 1] === '/') {
      while (j < snippet.length && snippet[j] !== '\n' && snippet[j] !== '\r') j++
      continue
    }
    if (c === '/' && snippet[j + 1] === '*') {
      j += 2
      while (j < snippet.length && !(snippet[j] === '*' && snippet[j + 1] === '/')) j++
      j += 2
      continue
    }
    out += c
    j++
  }
  return out
}

/** Position immediately after the last real token, before trailing trivia. */
function insertionOffset(text, node) {
  let pos = node.end - 1 // before the closing brace/bracket
  while (pos > node.start + 1 && /\s/.test(text[pos - 1])) pos--
  return pos
}

function hasCommaAfter(text, start, end) {
  return stripComments(text.slice(start, end)).includes(',')
}

/** Offset immediately after the last real value token in a container. */
function lastValueEnd(node) {
  if (node.type === 'object') {
    return node.properties.length
      ? node.properties[node.properties.length - 1].value.end
      : node.start + 1
  }
  return node.items.length ? node.items[node.items.length - 1].end : node.start + 1
}

/**
 * Append an element to a non-empty object/array without ever placing a comma
 * inside a trailing comment.
 *
 * The separator (when the container does not already have one) is inserted
 * immediately after the last value token, and the new element is inserted
 * outside any trailing trivia: on its own line before a closing bracket that
 * sits alone on its line, or inline after the trailing trivia otherwise.
 */
function appendContainerEntry(text, node, entryText, indent) {
  const nl = newlineFor(text)
  const closePos = node.end - 1
  const valueEnd = lastValueEnd(node)
  const commaNeeded = !hasCommaAfter(text, valueEnd, closePos)
  const multiline = text.slice(node.start, node.end).includes('\n')

  if (!multiline) {
    let inlinePos = closePos
    while (inlinePos > valueEnd && /[ \t]/.test(text[inlinePos - 1])) inlinePos--
    if (inlinePos === valueEnd) {
      return (
        text.slice(0, valueEnd) +
        `${commaNeeded ? ',' : ''} ${entryText}` +
        text.slice(valueEnd)
      )
    }
    const withComma = commaNeeded
      ? `${text.slice(0, valueEnd)},${text.slice(valueEnd)}`
      : text
    const target = inlinePos + (commaNeeded ? 1 : 0)
    return withComma.slice(0, target) + ` ${entryText}` + withComma.slice(target)
  }

  const lineStart =
    Math.max(text.lastIndexOf('\n', closePos - 1), text.lastIndexOf('\r', closePos - 1)) + 1
  const beforeClose = text.slice(lineStart, closePos)

  if (/^[ \t]*$/.test(beforeClose)) {
    const withComma = commaNeeded
      ? `${text.slice(0, valueEnd)},${text.slice(valueEnd)}`
      : text
    const target = lineStart + (commaNeeded ? 1 : 0)
    return withComma.slice(0, target) + `${indent}${entryText}${nl}` + withComma.slice(target)
  }

  // The closing bracket shares a line with the last value or a comment tail.
  let inlinePos = closePos
  while (inlinePos > valueEnd && /[ \t]/.test(text[inlinePos - 1])) inlinePos--
  if (inlinePos === valueEnd) {
    return (
      text.slice(0, valueEnd) +
      `${commaNeeded ? ',' : ''} ${entryText}` +
      text.slice(valueEnd)
    )
  }
  const withComma = commaNeeded
    ? `${text.slice(0, valueEnd)},${text.slice(valueEnd)}`
    : text
  const target = inlinePos + (commaNeeded ? 1 : 0)
  return withComma.slice(0, target) + ` ${entryText}` + withComma.slice(target)
}

function findProperty(objectNode, key) {
  let found = null
  for (const prop of objectNode.properties) {
    if (prop.key === key) found = prop
  }
  return found
}

function findAgentContainer(root) {
  const agents = findProperty(root, 'agents')
  if (agents && agents.value.type === 'object') {
    return { key: 'agents', node: agents.value }
  }
  const agent = findProperty(root, 'agent')
  if (agent && agent.value.type === 'object') {
    return { key: 'agent', node: agent.value }
  }
  return null
}

function findAgentEntry(root, name) {
  const primary = findAgentContainer(root)
  if (primary) {
    const prop = findProperty(primary.node, name)
    if (prop && prop.value.type === 'object') {
      return { containerKey: primary.key, containerNode: primary.node, entryNode: prop.value }
    }
  }
  for (const key of ['agents', 'agent']) {
    if (primary && primary.key === key) continue
    const containerProp = findProperty(root, key)
    if (!containerProp || containerProp.value.type !== 'object') continue
    const prop = findProperty(containerProp.value, name)
    if (prop && prop.value.type === 'object') {
      return { containerKey: key, containerNode: containerProp.value, entryNode: prop.value }
    }
  }
  return null
}

function replaceValue(text, node, replacement) {
  return text.slice(0, node.start) + replacement + text.slice(node.end)
}

function insertObjectProperty(text, objectNode, key, valueText) {
  const quoteKey = JSON.stringify(key)
  const hasProps = objectNode.properties.length > 0
  const multiline = text.slice(objectNode.start, objectNode.end).includes('\n')

  if (!hasProps) {
    const insertPos = insertionOffset(text, objectNode)
    const closePos = objectNode.end - 1
    const trailing = text.slice(insertPos, closePos)
    const nl = newlineFor(text)
    if (!multiline) {
      const indent = lineIndent(text, objectNode.start)
      return (
        text.slice(0, insertPos) +
        `${nl}${indent}  ${quoteKey}: ${valueText}${nl}${indent}` +
        text.slice(insertPos)
      )
    }
    const closeIndent = lineIndent(text, objectNode.start)
    return (
      text.slice(0, insertPos) +
      `${nl}${closeIndent}  ${quoteKey}: ${valueText}${trailing}` +
      text.slice(insertPos + trailing.length)
    )
  }

  const lastProp = objectNode.properties[objectNode.properties.length - 1]
  const indent = lineIndent(text, lastProp.keyNode.start)
  return appendContainerEntry(text, objectNode, `${quoteKey}: ${valueText}`, indent)
}

function appendArrayItem(text, arrayNode, valueText) {
  const hasItems = arrayNode.items.length > 0
  const multiline = text.slice(arrayNode.start, arrayNode.end).includes('\n')

  if (!hasItems) {
    const insertPos = insertionOffset(text, arrayNode)
    const closePos = arrayNode.end - 1
    const trailing = text.slice(insertPos, closePos)
    const nl = newlineFor(text)
    if (!multiline) {
      const indent = lineIndent(text, arrayNode.start)
      return (
        text.slice(0, insertPos) +
        `${nl}${indent}  ${valueText}${nl}${indent}` +
        text.slice(insertPos)
      )
    }
    const closeIndent = lineIndent(text, arrayNode.start)
    return (
      text.slice(0, insertPos) +
      `${nl}${closeIndent}  ${valueText}${trailing}` +
      text.slice(insertPos + trailing.length)
    )
  }

  const lastItem = arrayNode.items[arrayNode.items.length - 1]
  const indent = lineIndent(text, lastItem.start)
  return appendContainerEntry(text, arrayNode, valueText, indent)
}

/* -------------------------------------------------------------------------- */
/* Registration logic                                                         */
/* -------------------------------------------------------------------------- */

function readStringProperty(objectNode, key) {
  const prop = findProperty(objectNode, key)
  if (!prop || prop.value.type !== 'string') return ''
  return prop.value.value.trim()
}

function readObjectProperty(objectNode, key) {
  const prop = findProperty(objectNode, key)
  return prop && prop.value.type === 'object' ? prop.value : null
}

function modelFromAgent(root, name) {
  const entry = findAgentEntry(root, name)
  return entry ? readStringProperty(entry.entryNode, 'model') : ''
}

export function chooseReviewerModel(root) {
  const reviewer = findAgentEntry(root, 'pr-reviewer')
  const configured = reviewer ? readStringProperty(reviewer.entryNode, 'model') : ''
  if (configured) return configured
  return modelFromAgent(root, 'researcher') || modelFromAgent(root, 'builder') || ''
}

function permissionsOf(entryNode) {
  return findProperty(entryNode, 'permissions') || null
}

function effectiveSubagentEffect(permissionsArray) {
  let effect = null
  for (const item of permissionsArray.items) {
    if (item.type !== 'object') continue
    const action = readStringProperty(item, 'action')
    const resource = readStringProperty(item, 'resource')
    const value = readStringProperty(item, 'effect')
    if (
      (action === 'subagent' || action === '*') &&
      (resource === 'pr-reviewer' || resource === '*')
    ) {
      effect = value
    }
  }
  return effect
}

function denyAllMatches(node) {
  if (!node || node.type !== 'array' || node.items.length !== 1) return false
  const item = node.items[0]
  if (item.type !== 'object') return false
  return (
    readStringProperty(item, 'action') === '*' &&
    readStringProperty(item, 'resource') === '*' &&
    readStringProperty(item, 'effect') === 'deny'
  )
}

function compact(value) {
  return JSON.stringify(value)
}

/**
 * Pure text-to-text registration. Returns the new config and reviewer text,
 * change flags, and the model that was chosen. Throws JsoncParseError before
 * returning if the config cannot be parsed.
 *
 * @param {{ configText: string, reviewerText?: string, sourceName?: string }} input
 */
export function applyHarnessRegistration({ configText, reviewerText = '', sourceName = 'opencode.json' }) {
  if (typeof configText !== 'string') {
    throw new TypeError('configText must be a string')
  }

  const bom = configText.charCodeAt(0) === 0xfeff ? '\ufeff' : ''
  const body = bom ? configText.slice(1) : configText

  let text = body
  let guard = 0
  let changed = false

  while (guard++ < 64) {
    const { root } = parseJsonc(text, sourceName)
    let step = null

    // 1. Architect must be allowed to launch the reviewer. Append the explicit
    //    allow LAST because order-sensitive permission arrays may end in deny.
    const architect = findAgentEntry(root, 'hivemind-architect')
    if (architect) {
      const permissions = permissionsOf(architect.entryNode)
      if (permissions && permissions.value.type === 'array') {
        if (effectiveSubagentEffect(permissions.value) === 'deny') {
          step = appendArrayItem(
            text,
            permissions.value,
            compact(REVIEWER_ALLOW)
          )
        }
      }
    }

    if (!step) {
      const reviewer = findAgentEntry(root, 'pr-reviewer')
      const chosen = chooseReviewerModel(root)

      // 2. Global reviewer entry: add it if missing, default its model from
      //    researcher/builder only when the reviewer has no model, and enforce
      //    deny-all permissions.
      if (!reviewer) {
        const entry = { mode: 'subagent', permissions: DENY_ALL }
        if (chosen) entry.model = chosen
        const container = findAgentContainer(root)
        if (container) {
          step = insertObjectProperty(text, container.node, 'pr-reviewer', compact(entry))
        } else {
          step = insertObjectProperty(
            text,
            root,
            'agents',
            compact({ 'pr-reviewer': entry })
          )
        }
      } else {
        const entryNode = reviewer.entryNode
        const mode = readStringProperty(entryNode, 'mode')
        if (!mode) {
          step = insertObjectProperty(text, entryNode, 'mode', '"subagent"')
        } else {
          const model = readStringProperty(entryNode, 'model')
          if (!model && chosen) {
            step = insertObjectProperty(text, entryNode, 'model', compact(chosen))
          } else {
            const permissions = permissionsOf(entryNode)
            if (!permissions) {
              step = insertObjectProperty(text, entryNode, 'permissions', compact(DENY_ALL))
            } else if (!denyAllMatches(permissions.value)) {
              step = replaceValue(text, permissions.value, compact(DENY_ALL))
            }
          }
        }
      }
    }

    if (!step || step === text) break
    text = step
    changed = true
  }

  if (guard >= 64) {
    throw new Error('harness registration did not converge (permissions loop)')
  }

  let chosenModel = ''
  let reviewerChanged = false
  let nextReviewerText = reviewerText
  if (text !== body) {
    const { root } = parseJsonc(text, sourceName)
    chosenModel = chooseReviewerModel(root)
  } else {
    const { root } = parseJsonc(body, sourceName)
    chosenModel = chooseReviewerModel(root)
  }

  if (reviewerText && chosenModel) {
    const stamped = stampFrontmatterModel(reviewerText, chosenModel)
    if (stamped.changed) {
      nextReviewerText = stamped.text
      reviewerChanged = true
    }
  }

  return {
    configText: bom + text,
    reviewerText: nextReviewerText,
    configChanged: changed,
    reviewerChanged,
    chosenModel
  }
}

/**
 * Replace (or insert) the `model:` line in the reviewer agent's YAML
 * frontmatter. Everything outside the frontmatter is untouched.
 */
export function stampFrontmatterModel(text, model) {
  if (!model) return { text, changed: false }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return { text, changed: false }

  const frontmatter = match[1]
  const modelLine = /^model:[^\r\n]*/m
  let nextFrontmatter

  if (modelLine.test(frontmatter)) {
    nextFrontmatter = frontmatter.replace(modelLine, `model: ${model}`)
  } else {
    const nl = frontmatter.includes('\r\n') ? '\r\n' : '\n'
    nextFrontmatter = `${frontmatter}${frontmatter.endsWith('\n') ? '' : nl}model: ${model}`
  }

  if (nextFrontmatter === frontmatter) return { text, changed: false }

  const fmStart = match.index + match[0].indexOf('\n') + 1
  return {
    text:
      text.slice(0, fmStart) +
      nextFrontmatter +
      text.slice(fmStart + frontmatter.length),
    changed: true
  }
}

function timestampFor(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `_${pad(date.getMilliseconds(), 3)}`
  )
}

function uniqueBackupPath(filePath, stamp) {
  let candidate = `${filePath}.bak.${stamp}`
  let counter = 1
  while (existsSync(candidate)) {
    candidate = `${filePath}.bak.${stamp}.${counter}`
    counter++
  }
  return candidate
}

function writeWithBackup(filePath, text, stamp) {
  const backupPath = uniqueBackupPath(filePath, stamp)
  copyFileSync(filePath, backupPath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, text, 'utf8')
  return backupPath
}

/**
 * Apply registration to a real config directory.
 *
 * @param {{ configDir: string, now?: Date, stamp?: string }} options
 */
export function registerHarness({ configDir, now = new Date(), stamp = '' }) {
  if (!configDir) throw new TypeError('configDir is required')
  const resolvedDir = resolve(configDir)
  const configPath = join(resolvedDir, 'opencode.json')
  const reviewerPath = join(resolvedDir, 'agents', 'pr-reviewer.md')

  if (!existsSync(configPath)) {
    return {
      skipped: true,
      reason: `no opencode.json in ${resolvedDir}`,
      configPath,
      configChanged: false,
      reviewerChanged: false,
      chosenModel: ''
    }
  }

  const configText = readFileSync(configPath, 'utf8')
  const reviewerText = existsSync(reviewerPath)
    ? readFileSync(reviewerPath, 'utf8')
    : ''

  // Parse and compute every edit in memory first. A malformed config throws
  // here, before any backup or write.
  const result = applyHarnessRegistration({
    configText,
    reviewerText,
    sourceName: configPath
  })

  const effectiveStamp = stamp || timestampFor(now)
  let configBackup = ''
  let reviewerBackup = ''

  if (result.configChanged) {
    configBackup = writeWithBackup(configPath, result.configText, effectiveStamp)
  }
  if (result.reviewerChanged) {
    reviewerBackup = writeWithBackup(reviewerPath, result.reviewerText, effectiveStamp)
  }

  return {
    skipped: false,
    configPath,
    reviewerPath,
    configChanged: result.configChanged,
    reviewerChanged: result.reviewerChanged,
    chosenModel: result.chosenModel,
    configBackup,
    reviewerBackup
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { configDir: '', json: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--json') {
      args.json = true
    } else if (arg === '--config-dir') {
      args.configDir = argv[++index] || ''
    } else if (arg.startsWith('--config-dir=')) {
      args.configDir = arg.slice('--config-dir='.length)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('Usage: node harness-registration.mjs --config-dir <opencode-config-dir> [--json]')
    return 0
  }
  if (!args.configDir) {
    throw new Error('--config-dir is required')
  }

  const result = registerHarness({ configDir: args.configDir })

  if (args.json) {
    console.log(JSON.stringify(result))
    return 0
  }

  if (result.skipped) {
    console.log(`[harness] skipped: ${result.reason}`)
    return 0
  }

  console.log(
    `[harness] opencode.json: ${result.configChanged ? 'updated' : 'unchanged'}` +
      (result.configBackup ? ` (backup: ${result.configBackup})` : '')
  )
  console.log(
    `[harness] pr-reviewer agent: ${result.reviewerChanged ? 'updated' : 'unchanged'}` +
      (result.reviewerBackup ? ` (backup: ${result.reviewerBackup})` : '')
  )
  if (result.chosenModel) {
    console.log(`[harness] reviewer model: ${result.chosenModel}`)
  }
  return 0
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
const modulePath = fileURLToPath(import.meta.url)
if (invokedPath && resolve(modulePath) === invokedPath) {
  try {
    main()
  } catch (error) {
    console.error(`[harness] ERROR: ${error.message}`)
    process.exitCode = 1
  }
}
