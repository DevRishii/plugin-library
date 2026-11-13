/**
 * Deterministic extraction of receipt facts from a Session event log.
 *
 * Every field here comes from a durable event: tool calls and results for file
 * operations and shell commands, `assistant/message` usage for token cost,
 * `request/context` for provider/model switches, `todo/write` for the open
 * checklist, and `turn/end` for why a turn stopped. The extractor never reads
 * the workspace and never calls a model, so a receipt cannot invent work.
 */
import { absolutePath, displayPath } from './paths.mjs'
import { priceUsage } from './pricing.mjs'

/** Tools whose arguments carry a file mutation. */
export const FILE_TOOLS = new Set(['write', 'edit'])
/** Tools whose arguments carry a shell command. */
export const COMMAND_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal', 'run_command', 'exec_command'])
/** Test-runner command patterns. */
const TEST_COMMAND = /\b(vitest|jest|mocha|pytest|node\s+--test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|deno\s+test|go\s+test|cargo\s+test|dotnet\s+test)\b/i
/** Output patterns that mark a test run as failing; uppercase FAIL avoids prose like "a failed attempt". */
const TEST_FAILURE = /(\b\d+\s+failing\b|\bTests?:\s+[^\n]*\bfailed\b|\bnot ok \d+|\bFAIL(?:ED)?\b|✗|AssertionError)/
/** Marker that ends a shell result and carries its exit code. */
const EXIT_MARKER = /\[exit code:\s*(-?\d+)\]/
/** TODO spellings recognized in written content, by urgency. */
const TODO_MARKER = /\b(TODO|FIXME|XXX)\b/

/**
 * Parse a tool call's JSON arguments without throwing.
 * @param {unknown} raw - the argument string.
 * @returns {Record<string, unknown>} the parsed object, or an empty one.
 */
export function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The text a tool result carries.
 * @param {object} event - a `tool/result` event.
 * @returns {string} the joined text blocks.
 */
export function resultText(event) {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n')
}

/**
 * Pick the most informative failure line from a shell result.
 * The `[stderr]` section wins when present; a bare PowerShell category line
 * (`ParserError:`) is skipped in favor of the message below it, and PowerShell
 * source excerpts (`  23 | ...`, `+ CategoryInfo`) are ignored.
 * @param {string[]} lines - normalized non-empty result lines.
 * @returns {string | null} the selected line.
 */
export function selectFailureLine(lines) {
  const stderrAt = lines.findIndex(line => line.trim() === '[stderr]')
  const scope = stderrAt >= 0 ? lines.slice(stderrAt + 1) : lines
  const categoryOnly = line => /^[A-Za-z][A-Za-z. ]*:\s*$/.test(line.trim())
  const cleaned = []
  for (const line of scope) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === '[stderr]' || EXIT_MARKER.test(trimmed)) continue
    if (/^\d+\s*\|/.test(trimmed)) continue
    if (/^~+$/.test(trimmed)) continue
    if (/^Line \|$/.test(trimmed) || /^At line:/.test(trimmed)) continue
    if (/^[-–—]{3,}$/.test(trimmed)) continue
    if (/^(FullName|Name|Length|Mode|LastWriteTime)\b/.test(trimmed)) continue
    if (/^[+-] (CategoryInfo|FullyQualifiedErrorId|PSComputerName)/.test(trimmed)) continue
    const piped = /^\|\s*(.*)$/.exec(trimmed)
    const text = piped === null ? trimmed : piped[1].trim()
    if (text === '' || /^~+$/.test(text)) continue
    cleaned.push(text)
  }
  const chosen = cleaned.find(line => !categoryOnly(line)) ?? cleaned.at(-1)
  return chosen === undefined ? null : chosen.slice(0, 240)
}

/**
 * Extract the exit code and first failing line from a shell result.
 * @param {string} text - the tool result text.
 * @param {boolean} isError - whether the tool marked the result as an error.
 * @returns {{exitCode: number|null, firstFailureLine: string|null}} the outcome.
 */
export function commandOutcome(text, isError) {
  const marker = EXIT_MARKER.exec(text)
  const exitCode = marker === null ? (isError ? 1 : 0) : Number(marker[1])
  if (exitCode === 0 && !isError) return { exitCode, firstFailureLine: null }
  const lines = text.replace(/\r/g, '').split('\n').filter(line => line.trim() !== '')
  return { exitCode, firstFailureLine: selectFailureLine(lines) }
}

/**
 * Read usage buckets from an assistant message.
 * @param {object} event - an `assistant/message` event.
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number} | null} usage.
 */
export function assistantUsage(event) {
  const usage = event.data?.usage
  if (usage === undefined || usage === null) return null
  if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return null
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...typeof usage.cacheReadTokens === 'number' ? { cacheReadTokens: usage.cacheReadTokens } : {},
    ...typeof usage.cacheWriteTokens === 'number' ? { cacheWriteTokens: usage.cacheWriteTokens } : {},
  }
}

/**
 * The provider/model route an event records.
 * @param {object} event - a `request/context`, `request/header`, or `assistant/message` event.
 * @returns {{provider: string, model: string} | null} the route.
 */
export function routeOf(event) {
  if (event.type === 'request/context') {
    const { provider, model } = event.data ?? {}
    return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : null
  }
  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    return typeof config?.provider === 'string' && typeof config?.model === 'string'
      ? { provider: config.provider, model: config.model }
      : null
  }
  const source = event.data?.message?.source
  return source?.kind === 'model' && typeof source.provider === 'string' && typeof source.model === 'string'
    ? { provider: source.provider, model: source.model }
    : null
}

/**
 * The first failure-looking line when a test command failed without a marker.
 * @param {string} text - result text.
 * @returns {string | null} the trimmed line.
 */
function failureLineFromText(text) {
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === '[stderr]' || EXIT_MARKER.test(trimmed)) continue
    if (/^(✔|ok\b)/i.test(trimmed)) continue
    if (/fail|error|not ok|✗/i.test(trimmed)) return trimmed.slice(0, 240)
  }
  return null
}

/**
 * Collect the file mutations, shell commands, model usage, plugin changes, and
 * open checklist a Session log recorded.
 * @param {Array<object>} events - events in file order.
 * @param {{cwd: string, home?: string}} options - session working directory.
 * @returns {object} the extracted facts.
 */
export function extractFacts(events, options) {
  const { cwd, home } = options
  const results = new Map()
  for (const event of events) {
    const callId = event.type === 'tool/result' ? event.data?.message?.toolCallId : undefined
    if (typeof callId === 'string') results.set(callId, event)
  }

  const files = new Map()
  const commands = []
  const usage = []
  const routes = []
  const todoWrites = []
  const plugins = []
  const settings = []
  const turns = new Map()
  const todoMarkers = []
  let steps = 0
  let toolCalls = 0
  let firstEventAt = null
  let lastEventAt = null

  const noteFile = (call, args, result) => {
    const name = call.data?.name
    const rawPath = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : null
    if (rawPath === null) return
    const absolute = absolutePath(cwd, rawPath)
    const display = displayPath(cwd, absolute, home)
    if (!files.has(display)) files.set(display, { path: display, absolute, ops: [] })
    const entry = files.get(display)
    const operation = result?.data?.meta?.operation
    const op = {
      seq: call.seq,
      time: call.time ?? null,
      turn: call.data?.turn ?? null,
      tool: name,
      operation: name === 'write' ? (operation === 'create' ? 'create' : 'update') : 'edit',
      ...name === 'write' ? { content: typeof args.content === 'string' ? args.content : null } : {},
      ...name === 'edit' ? {
        oldString: typeof args.old_string === 'string' ? args.old_string : null,
        newString: typeof args.new_string === 'string' ? args.new_string : null,
        replaceAll: args.replace_all === true,
      } : {},
      ok: result === undefined ? null : result.data?.message?.isError !== true,
    }
    entry.ops.push(op)
    const candidate = name === 'edit' ? op.newString : op.content
    if (typeof candidate === 'string') {
      const lines = candidate.split('\n')
      for (let index = 0; index < lines.length && todoMarkers.length < 100; index += 1) {
        if (TODO_MARKER.test(lines[index])) {
          todoMarkers.push({ path: display, line: index + 1, kind: TODO_MARKER.exec(lines[index])[1], text: lines[index].trim().slice(0, 200), seq: call.seq })
        }
      }
    }
  }

  const noteCommand = (call, args, result) => {
    const command = typeof args.command === 'string' ? args.command : null
    if (command === null) return
    const text = result === undefined ? '' : resultText(result)
    const isError = result?.data?.message?.isError === true
    const { exitCode, firstFailureLine } = result === undefined
      ? { exitCode: null, firstFailureLine: null }
      : commandOutcome(text, isError)
    const failedTests = exitCode !== 0 && (TEST_COMMAND.test(command) || TEST_FAILURE.test(text))
    const failure = failedTests ? TEST_FAILURE.exec(text.replace(/\r/g, '')) : null
    commands.push({
      seq: call.seq,
      time: call.time ?? null,
      turn: call.data?.turn ?? null,
      tool: call.data?.name,
      command,
      exitCode,
      ok: exitCode === 0,
      isError,
      firstFailureLine,
      failedTests,
      failureSummary: failure !== null
        ? lineAt(text, failure.index)
        : failedTests ? failureLineFromText(text) : null,
    })
  }

  for (const event of events) {
    if (typeof event.time === 'number') {
      firstEventAt ??= event.time
      lastEventAt = event.time
    }
    switch (event.type) {
      case 'step/start':
        steps += 1
        break
      case 'turn/start':
        turns.set(event.data?.turn, { turn: event.data?.turn, startedAt: event.time ?? null, endedAt: null, reason: null })
        break
      case 'turn/end': {
        const turn = turns.get(event.data?.turn)
        if (turn !== undefined) {
          turn.endedAt = event.time ?? null
          turn.reason = event.data?.reason?.kind ?? null
        }
        break
      }
      case 'request/context': {
        const route = routeOf(event)
        if (route !== null) routes.push({ seq: event.seq, time: event.time ?? null, turn: event.data?.turn ?? null, ...route })
        break
      }
      case 'assistant/message': {
        const recorded = assistantUsage(event)
        const route = routeOf(event)
        if (route !== null) routes.push({ seq: event.seq, time: event.time ?? null, turn: event.data?.turn ?? null, ...route })
        if (recorded !== null && route !== null) {
          usage.push({ seq: event.seq, time: event.time ?? null, turn: event.data?.turn ?? null, provider: route.provider, model: route.model, usage: recorded })
        }
        break
      }
      case 'todo/write':
        if (Array.isArray(event.data?.todos)) todoWrites.push({ seq: event.seq, time: event.time ?? null, todos: event.data.todos })
        break
      case 'command/run':
        if (typeof event.data?.name === 'string' && event.data.name !== '') {
          settings.push({ seq: event.seq, time: event.time ?? null, name: event.data.name, args: typeof event.data.args === 'string' ? event.data.args.trim() : '' })
        }
        break
      case 'tool/call': {
        toolCalls += 1
        const name = event.data?.name
        const args = parseArguments(event.data?.arguments)
        const result = results.get(event.data?.callId)
        if (FILE_TOOLS.has(name)) noteFile(event, args, result)
        else if (COMMAND_TOOLS.has(name)) noteCommand(event, args, result)
        else if (name === 'plugin_manager') {
          plugins.push({
            seq: event.seq,
            time: event.time ?? null,
            action: typeof args.action === 'string' ? args.action : null,
            target: typeof args.target === 'string' ? args.target : null,
            enabled: typeof args.enabled === 'boolean' ? args.enabled : null,
          })
        }
        break
      }
      default:
        break
    }
  }

  const switches = []
  let previousRoute = null
  for (const route of routes) {
    const key = `${route.provider}\0${route.model}`
    if (key === previousRoute) continue
    previousRoute = key
    switches.push(route)
  }

  const models = []
  for (const record of usage) {
    let model = models.find(candidate => candidate.provider === record.provider && candidate.model === record.model)
    if (model === undefined) {
      model = {
        provider: record.provider,
        model: record.model,
        requests: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        unpricedRequests: 0,
      }
      models.push(model)
    }
    model.requests += 1
    model.usage.inputTokens += record.usage.inputTokens
    model.usage.outputTokens += record.usage.outputTokens
    model.usage.cacheReadTokens += record.usage.cacheReadTokens ?? 0
    model.usage.cacheWriteTokens += record.usage.cacheWriteTokens ?? 0
    const priced = priceUsage(record.model, record.usage, record.time ?? lastEventAt ?? 0)
    if (priced.usd === null) model.unpricedRequests += 1
    else model.costUsd += priced.usd
  }
  for (const model of models) model.costUsd = round(model.costUsd, 6)

  const turnsOut = [...turns.values()].map((turn) => {
    const records = usage.filter(record => record.turn === turn.turn)
    const turnCost = round(records.reduce((sum, record) => {
      const priced = priceUsage(record.model, record.usage, record.time ?? turn.startedAt ?? 0)
      return sum + (priced.usd ?? 0)
    }, 0), 6)
    const last = records.at(-1)
    return {
      turn: turn.turn,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      durationMs: turn.startedAt !== null && turn.endedAt !== null ? turn.endedAt - turn.startedAt : null,
      reason: turn.reason,
      provider: last?.provider ?? null,
      model: last?.model ?? null,
      usage: records.length === 0 ? null : {
        inputTokens: records.reduce((sum, record) => sum + record.usage.inputTokens, 0),
        outputTokens: records.reduce((sum, record) => sum + record.usage.outputTokens, 0),
        cacheReadTokens: records.reduce((sum, record) => sum + (record.usage.cacheReadTokens ?? 0), 0),
        cacheWriteTokens: records.reduce((sum, record) => sum + (record.usage.cacheWriteTokens ?? 0), 0),
      },
      costUsd: turnCost,
    }
  })

  return {
    files: [...files.values()].map(file => ({ ...file, ops: file.ops.sort((left, right) => left.seq - right.seq) })),
    commands,
    usage,
    models,
    switches,
    turns: turnsOut,
    steps,
    toolCalls,
    firstEventAt,
    lastEventAt,
    todoWrites,
    todoMarkers,
    plugins,
    settings,
  }
}

/**
 * The line containing an offset in a text block.
 * @param {string} text - result text.
 * @param {number} index - match offset.
 * @returns {string} the trimmed line.
 */
function lineAt(text, index) {
  const normalized = text.replace(/\r/g, '')
  const start = normalized.lastIndexOf('\n', index) + 1
  const end = normalized.indexOf('\n', index)
  return normalized.slice(start, end < 0 ? undefined : end).trim().slice(0, 240)
}

/**
 * Round to a fixed number of decimals without float dust.
 * @param {number} value - input.
 * @param {number} decimals - decimal places.
 * @returns {number} rounded value.
 */
export function round(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
