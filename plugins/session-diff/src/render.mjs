/**
 * Render one Session receipt as deterministic JSON, Markdown, or standalone HTML.
 *
 * Every renderer is pure: it reads only the receipt object, never the workspace,
 * the clock, or the network. Missing values are displayed as `unknown` rather
 * than leaking JavaScript's `undefined` or `NaN` into a report.
 */
import { formatUsd } from './pricing.mjs'

const UNKNOWN = 'unknown'
const HASH_CHARS = 12
const COMMAND_CHARS = 80
const FAILURE_CHARS = 100

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})

const CSS = `:root {
  color-scheme: light;
  --ink: #17202a;
  --muted: #5b6773;
  --line: #d8dee5;
  --panel: #ffffff;
  --bg: #f4f6f8;
  --code: #f0f3f6;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  padding: 2rem 1rem;
  color: var(--ink);
  background: var(--bg);
  font: 16px/1.55 "Segoe UI", "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 72rem; margin: 0 auto; }
h1 { font-size: 1.75rem; margin: 0 0 1rem; }
h2 {
  font-size: 1.25rem;
  margin: 2rem 0 .75rem;
  padding-bottom: .35rem;
  border-bottom: 1px solid var(--line);
}
h3 { font-size: 1rem; margin: 1.25rem 0 .5rem; }
p { margin: .5rem 0 1rem; }
code {
  padding: .1rem .3rem;
  border-radius: 4px;
  background: var(--code);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: .9em;
}
table {
  width: 100%;
  margin: .5rem 0 1rem;
  border-collapse: collapse;
  background: var(--panel);
}
th, td {
  padding: .45rem .6rem;
  border: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
th { background: #e9edf2; font-weight: 600; }
td code { padding: 0; background: transparent; }
tbody tr:nth-child(even) { background: #fafbfc; }
dl.meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: .3rem 1rem;
  margin: 0 0 1.5rem;
}
dl.meta dt { color: var(--muted); font-weight: 600; }
dl.meta dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: .5rem 0 1rem; padding-left: 1.4rem; }
li { margin: .25rem 0; }
.ref { color: var(--muted); font-size: .9em; }
.generated {
  margin-top: 2rem;
  padding-top: .75rem;
  border-top: 1px solid var(--line);
  color: var(--muted);
}
.empty { color: var(--muted); font-style: italic; }
@media (max-width: 640px) {
  body { padding: 1rem .5rem; }
  table { font-size: .9rem; }
}`

/**
 * Render a receipt as pretty JSON.
 * @param {object} receipt - the Session receipt.
 * @returns {string} pretty JSON ending with exactly one newline.
 */
export function renderJson(receipt) {
  const text = JSON.stringify(receipt, null, 2) ?? 'null'
  return `${text.replace(/\n+$/, '')}\n`
}

/**
 * Render a receipt as Markdown.
 * @param {object} receipt - the Session receipt.
 * @returns {string} a deterministic Markdown report ending with one newline.
 */
export function renderMarkdown(receipt) {
  const session = receipt?.session ?? {}
  const summary = receipt?.summary ?? {}
  const files = Array.isArray(receipt?.files) ? receipt.files : []
  const commands = Array.isArray(receipt?.commands) ? receipt.commands : []
  const turns = Array.isArray(receipt?.turns) ? receipt.turns : []
  const models = Array.isArray(receipt?.models) ? receipt.models : []
  const plugins = Array.isArray(receipt?.plugins) ? receipt.plugins : []
  const settings = Array.isArray(receipt?.settings) ? receipt.settings : []
  const threads = Array.isArray(receipt?.threads) ? receipt.threads : []
  const title = inlineText(session.title || session.id || UNKNOWN)
  const version = text(receipt?.generator?.version)
  const eventCount = countText(session.eventCount)
  const lines = []

  lines.push(`# Session receipt: ${title}`, '')
  lines.push(`- **Session ID:** ${inlineText(session.id)}`)
  lines.push(`- **Working directory:** ${inlineText(session.cwd)}`)
  lines.push(`- **Started:** ${isoTime(session.startedAt)}`)
  lines.push(`- **Ended:** ${isoTime(session.endedAt)}`)
  lines.push(`- **Duration:** ${durationText(session.durationMs)}`)
  lines.push(`- **Agent preset:** ${inlineText(session.agentPreset)}`)
  lines.push('')

  lines.push('## Summary', '')
  lines.push(`- Turns: ${countText(summary.turns)}`)
  lines.push(`- Tool calls: ${countText(summary.toolCalls)}`)
  lines.push(`- Files added: ${countText(summary.filesAdded)}`)
  lines.push(`- Files modified: ${countText(summary.filesModified)}`)
  lines.push(`- Files deleted: ${countText(summary.filesDeleted)}`)
  lines.push(`- Commands: ${countText(summary.commands)}`)
  lines.push(`- Failures: ${countText(summary.commandsFailed)}`)
  lines.push(`- Models: ${countText(summary.models)}`)
  lines.push(`- Total cost: ${costText(summary.totalCostUsd)}`)
  lines.push(`- Open threads: ${countText(summary.openThreads)}`)
  lines.push('')

  lines.push('## Files', '')
  lines.push('| Path | Status | Before | After |')
  lines.push('| --- | --- | --- | --- |')
  for (const file of files) {
    lines.push(`| ${mdCell(file.path)} | ${mdCell(file.status)} | ${mdCell(markdownFileSide(file.beforeSha256, file.beforeSource))} | ${mdCell(markdownFileSide(file.afterSha256, file.afterSource))} |`)
  }
  lines.push('')

  lines.push('## Commands', '')
  lines.push('| Exit | Tool | Command | First failing line |')
  lines.push('| --- | --- | --- | --- |')
  for (const command of commands) {
    const failure = command.firstFailureLine === null || command.firstFailureLine === undefined
      ? UNKNOWN
      : truncate(command.firstFailureLine, FAILURE_CHARS)
    lines.push(`| ${mdCell(exitText(command.exitCode))} | ${mdCell(command.tool)} | ${mdCell(truncate(command.command, COMMAND_CHARS))} | ${mdCell(failure)} |`)
  }
  lines.push('')

  lines.push('## Models and per-turn cost', '')
  lines.push('| Turn | Model | Input | Output | Cost USD |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const turn of turns) {
    lines.push(`| ${mdCell(countText(turn.turn))} | ${mdCell(turn.model)} | ${mdCell(countText(turn.usage?.inputTokens))} | ${mdCell(countText(turn.usage?.outputTokens))} | ${mdCell(costText(turn.costUsd))} |`)
  }
  lines.push('')
  lines.push('### Model totals', '')
  lines.push('| Provider | Model | Requests | Input | Output | Cost USD |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const model of models) {
    lines.push(`| ${mdCell(model.provider)} | ${mdCell(model.model)} | ${mdCell(countText(model.requests))} | ${mdCell(countText(model.usage?.inputTokens))} | ${mdCell(countText(model.usage?.outputTokens))} | ${mdCell(costText(model.costUsd))} |`)
  }
  lines.push('')

  lines.push('## Plugins and settings touched', '')
  if (plugins.length === 0 && settings.length === 0) {
    lines.push('None recorded.', '')
  } else {
    lines.push('### Plugins', '')
    if (plugins.length === 0) {
      lines.push('None recorded.', '')
    } else {
      lines.push('| Seq | Action | Target | Enabled |')
      lines.push('| --- | --- | --- | --- |')
      for (const plugin of plugins) {
        lines.push(`| ${mdCell(countText(plugin.seq))} | ${mdCell(plugin.action)} | ${mdCell(plugin.target)} | ${mdCell(enabledText(plugin.enabled))} |`)
      }
      lines.push('')
    }
    lines.push('### Settings', '')
    if (settings.length === 0) {
      lines.push('None recorded.', '')
    } else {
      lines.push('| Seq | Name | Args |')
      lines.push('| --- | --- | --- |')
      for (const setting of settings) {
        lines.push(`| ${mdCell(countText(setting.seq))} | ${mdCell(setting.name)} | ${mdCell(setting.args)} |`)
      }
      lines.push('')
    }
  }

  lines.push('## Open threads', '')
  if (threads.length === 0) {
    lines.push('None recorded.', '')
  } else {
    for (const [kind, items] of groupThreads(threads)) {
      lines.push(`### ${inlineText(kind)}`, '')
      for (const thread of items) {
        const heading = inlineText(thread.title)
        const detail = inlineText(thread.detail)
        const ref = thread.ref === null || thread.ref === undefined ? UNKNOWN : String(thread.ref)
        const prefix = heading === '' ? '' : `${heading} — `
        lines.push(`- ${prefix}${detail} (ref: ${ref})`)
      }
      lines.push('')
    }
  }

  lines.push(`_Generated by session-diff v${version} from ${eventCount} events._`)
  return `${lines.join('\n')}\n`
}

/**
 * Render a receipt as a complete standalone HTML5 document.
 * @param {object} receipt - the Session receipt.
 * @returns {string} an HTML document with no scripts or external assets.
 */
export function renderHtml(receipt) {
  const session = receipt?.session ?? {}
  const summary = receipt?.summary ?? {}
  const files = Array.isArray(receipt?.files) ? receipt.files : []
  const commands = Array.isArray(receipt?.commands) ? receipt.commands : []
  const turns = Array.isArray(receipt?.turns) ? receipt.turns : []
  const models = Array.isArray(receipt?.models) ? receipt.models : []
  const plugins = Array.isArray(receipt?.plugins) ? receipt.plugins : []
  const settings = Array.isArray(receipt?.settings) ? receipt.settings : []
  const threads = Array.isArray(receipt?.threads) ? receipt.threads : []
  const title = inlineText(session.title || session.id || UNKNOWN)
  const version = text(receipt?.generator?.version)
  const eventCount = countText(session.eventCount)
  const parts = []

  parts.push('<!doctype html>')
  parts.push('<html lang="en">')
  parts.push('<head>')
  parts.push('<meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  parts.push(`<title>Session receipt: ${escapeHtml(title)}</title>`)
  parts.push('<style>')
  parts.push(CSS)
  parts.push('</style>')
  parts.push('</head>')
  parts.push('<body>')
  parts.push('<main>')
  parts.push(`<h1>Session receipt: ${escapeHtml(title)}</h1>`)
  parts.push('<dl class="meta">')
  parts.push(`<dt>Session ID</dt><dd>${htmlText(session.id)}</dd>`)
  parts.push(`<dt>Working directory</dt><dd><code>${htmlText(session.cwd)}</code></dd>`)
  parts.push(`<dt>Started</dt><dd>${escapeHtml(isoTime(session.startedAt))}</dd>`)
  parts.push(`<dt>Ended</dt><dd>${escapeHtml(isoTime(session.endedAt))}</dd>`)
  parts.push(`<dt>Duration</dt><dd>${escapeHtml(durationText(session.durationMs))}</dd>`)
  parts.push(`<dt>Agent preset</dt><dd>${htmlText(session.agentPreset)}</dd>`)
  parts.push('</dl>')

  parts.push('<h2>Summary</h2>')
  parts.push('<ul>')
  parts.push(`<li><strong>Turns:</strong> ${escapeHtml(countText(summary.turns))}</li>`)
  parts.push(`<li><strong>Tool calls:</strong> ${escapeHtml(countText(summary.toolCalls))}</li>`)
  parts.push(`<li><strong>Files added:</strong> ${escapeHtml(countText(summary.filesAdded))}</li>`)
  parts.push(`<li><strong>Files modified:</strong> ${escapeHtml(countText(summary.filesModified))}</li>`)
  parts.push(`<li><strong>Files deleted:</strong> ${escapeHtml(countText(summary.filesDeleted))}</li>`)
  parts.push(`<li><strong>Commands:</strong> ${escapeHtml(countText(summary.commands))}</li>`)
  parts.push(`<li><strong>Failures:</strong> ${escapeHtml(countText(summary.commandsFailed))}</li>`)
  parts.push(`<li><strong>Models:</strong> ${escapeHtml(countText(summary.models))}</li>`)
  parts.push(`<li><strong>Total cost:</strong> ${escapeHtml(costText(summary.totalCostUsd))}</li>`)
  parts.push(`<li><strong>Open threads:</strong> ${escapeHtml(countText(summary.openThreads))}</li>`)
  parts.push('</ul>')

  parts.push('<h2>Files</h2>')
  parts.push('<table>')
  parts.push('<thead><tr><th scope="col">Path</th><th scope="col">Status</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>')
  parts.push('<tbody>')
  for (const file of files) {
    parts.push(`<tr><td><code>${htmlText(file.path)}</code></td><td>${htmlText(file.status)}</td><td>${htmlFileSide(file.beforeSha256, file.beforeSource)}</td><td>${htmlFileSide(file.afterSha256, file.afterSource)}</td></tr>`)
  }
  parts.push('</tbody>')
  parts.push('</table>')

  parts.push('<h2>Commands</h2>')
  parts.push('<table>')
  parts.push('<thead><tr><th scope="col">Exit</th><th scope="col">Tool</th><th scope="col">Command</th><th scope="col">First failing line</th></tr></thead>')
  parts.push('<tbody>')
  for (const command of commands) {
    const failure = command.firstFailureLine === null || command.firstFailureLine === undefined
      ? UNKNOWN
      : truncate(command.firstFailureLine, FAILURE_CHARS)
    parts.push(`<tr><td>${escapeHtml(exitText(command.exitCode))}</td><td>${htmlText(command.tool)}</td><td><code>${escapeHtml(truncate(command.command, COMMAND_CHARS))}</code></td><td>${escapeHtml(failure)}</td></tr>`)
  }
  parts.push('</tbody>')
  parts.push('</table>')

  parts.push('<h2>Models and per-turn cost</h2>')
  parts.push('<table>')
  parts.push('<thead><tr><th scope="col">Turn</th><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cost USD</th></tr></thead>')
  parts.push('<tbody>')
  for (const turn of turns) {
    parts.push(`<tr><td>${escapeHtml(countText(turn.turn))}</td><td>${htmlText(turn.model)}</td><td>${escapeHtml(countText(turn.usage?.inputTokens))}</td><td>${escapeHtml(countText(turn.usage?.outputTokens))}</td><td>${escapeHtml(costText(turn.costUsd))}</td></tr>`)
  }
  parts.push('</tbody>')
  parts.push('</table>')
  parts.push('<h3>Model totals</h3>')
  parts.push('<table>')
  parts.push('<thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Requests</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cost USD</th></tr></thead>')
  parts.push('<tbody>')
  for (const model of models) {
    parts.push(`<tr><td>${htmlText(model.provider)}</td><td>${htmlText(model.model)}</td><td>${escapeHtml(countText(model.requests))}</td><td>${escapeHtml(countText(model.usage?.inputTokens))}</td><td>${escapeHtml(countText(model.usage?.outputTokens))}</td><td>${escapeHtml(costText(model.costUsd))}</td></tr>`)
  }
  parts.push('</tbody>')
  parts.push('</table>')

  parts.push('<h2>Plugins and settings touched</h2>')
  if (plugins.length === 0 && settings.length === 0) {
    parts.push('<p class="empty">None recorded.</p>')
  } else {
    parts.push('<h3>Plugins</h3>')
    if (plugins.length === 0) {
      parts.push('<p class="empty">None recorded.</p>')
    } else {
      parts.push('<table>')
      parts.push('<thead><tr><th scope="col">Seq</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Enabled</th></tr></thead>')
      parts.push('<tbody>')
      for (const plugin of plugins) {
        parts.push(`<tr><td>${escapeHtml(countText(plugin.seq))}</td><td>${htmlText(plugin.action)}</td><td>${htmlText(plugin.target)}</td><td>${escapeHtml(enabledText(plugin.enabled))}</td></tr>`)
      }
      parts.push('</tbody>')
      parts.push('</table>')
    }
    parts.push('<h3>Settings</h3>')
    if (settings.length === 0) {
      parts.push('<p class="empty">None recorded.</p>')
    } else {
      parts.push('<table>')
      parts.push('<thead><tr><th scope="col">Seq</th><th scope="col">Name</th><th scope="col">Args</th></tr></thead>')
      parts.push('<tbody>')
      for (const setting of settings) {
        parts.push(`<tr><td>${escapeHtml(countText(setting.seq))}</td><td>${htmlText(setting.name)}</td><td>${htmlText(setting.args)}</td></tr>`)
      }
      parts.push('</tbody>')
      parts.push('</table>')
    }
  }

  parts.push('<h2>Open threads</h2>')
  if (threads.length === 0) {
    parts.push('<p class="empty">None recorded.</p>')
  } else {
    for (const [kind, items] of groupThreads(threads)) {
      parts.push(`<h3>${escapeHtml(kind)}</h3>`)
      parts.push('<ul>')
      for (const thread of items) {
        const heading = inlineText(thread.title)
        const detail = inlineText(thread.detail)
        const ref = thread.ref === null || thread.ref === undefined ? UNKNOWN : String(thread.ref)
        const prefix = heading === '' ? '' : `<strong>${escapeHtml(heading)}</strong> — `
        parts.push(`<li>${prefix}${escapeHtml(detail)} <span class="ref">(ref: ${escapeHtml(ref)})</span></li>`)
      }
      parts.push('</ul>')
    }
  }

  parts.push(`<p class="generated"><em>Generated by session-diff v${escapeHtml(version)} from ${escapeHtml(eventCount)} events.</em></p>`)
  parts.push('</main>')
  parts.push('</body>')
  parts.push('</html>')
  return `${parts.join('\n')}\n`
}

/**
 * Escape text for use in HTML content or a quoted HTML attribute.
 * @param {unknown} value - text to escape; null and undefined become an empty string.
 * @returns {string} escaped HTML text.
 */
export function escapeHtml(value) {
  const source = value === null || value === undefined ? '' : String(value)
  return source.replace(/[&<>"']/g, character => HTML_ESCAPES[character])
}

/**
 * Convert a receipt value to display text.
 * @param {unknown} value - input value.
 * @returns {string} text, or `unknown` for null, undefined, NaN, or an empty string.
 */
function text(value) {
  if (value === null || value === undefined) return UNKNOWN
  if (typeof value === 'number' && !Number.isFinite(value)) return UNKNOWN
  const rendered = String(value)
  return rendered === '' ? UNKNOWN : rendered
}

/**
 * Convert a value to single-line inline text.
 * @param {unknown} value - input value.
 * @returns {string} text with line breaks replaced by spaces.
 */
function inlineText(value) {
  return text(value).replace(/\s*\r?\n\s*/g, ' ')
}

/**
 * Return an empty string for an absent value, otherwise display text.
 * @param {unknown} value - input value.
 * @returns {string} possibly empty display text.
 */
function emptyText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && !Number.isFinite(value)) return ''
  return String(value).replace(/\s*\r?\n\s*/g, ' ')
}

/**
 * Render a finite count, or `unknown`.
 * @param {unknown} value - numeric input.
 * @returns {string} decimal text.
 */
function countText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : UNKNOWN
}

/**
 * Render an exit code, or `unknown`.
 * @param {unknown} value - numeric input.
 * @returns {string} decimal text.
 */
function exitText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : UNKNOWN
}

/**
 * Render a USD amount, never NaN.
 * @param {unknown} value - amount in USD.
 * @returns {string} formatted amount or `unknown`.
 */
function costText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN
  return formatUsd(value)
}

/**
 * Render an epoch millisecond timestamp as ISO-8601 UTC text.
 * @param {unknown} value - epoch milliseconds.
 * @returns {string} ISO timestamp or `unknown`.
 */
function isoTime(value) {
  if (value === null || value === undefined) return UNKNOWN
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? UNKNOWN : date.toISOString()
}

/**
 * Render a millisecond duration.
 * @param {unknown} value - duration in milliseconds.
 * @returns {string} duration text or `unknown`.
 */
function durationText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return UNKNOWN
  if (value < 1000) return `${Math.round(value)} ms`
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/**
 * Render a plugin enabled flag.
 * @param {unknown} value - boolean flag.
 * @returns {string} `yes`, `no`, or `unknown`.
 */
function enabledText(value) {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return UNKNOWN
}

/**
 * Shorten a hash for display.
 * @param {unknown} value - full hash.
 * @returns {string} first twelve characters plus an ellipsis.
 */
function shortHash(value) {
  return `${String(value).slice(0, HASH_CHARS)}…`
}

/**
 * Render the before/after cell of a Markdown file row.
 * @param {string | null} hash - full hash.
 * @param {string | null} source - hash provenance.
 * @returns {string} hash preview, source label, or `unknown`.
 */
function markdownFileSide(hash, source) {
  if (typeof hash === 'string' && hash !== '') return shortHash(hash)
  if (source === 'absent' || source === 'unavailable') return source
  return UNKNOWN
}

/**
 * Render the before/after cell of an HTML file row.
 * @param {string | null} hash - full hash.
 * @param {string | null} source - hash provenance.
 * @returns {string} escaped HTML for a hash preview, source label, or `unknown`.
 */
function htmlFileSide(hash, source) {
  if (typeof hash === 'string' && hash !== '') {
    return `<code title="${escapeHtml(hash)}">${escapeHtml(shortHash(hash))}</code>`
  }
  if (source === 'absent' || source === 'unavailable') return escapeHtml(source)
  return UNKNOWN
}

/**
 * Escape a Markdown table cell.
 * @param {unknown} value - cell text.
 * @returns {string} one-line text with pipes escaped.
 */
function mdCell(value) {
  return text(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '\\`')
}

/**
 * Escape dynamic text for HTML.
 * @param {unknown} value - text.
 * @returns {string} escaped display text.
 */
function htmlText(value) {
  return escapeHtml(text(value))
}

/**
 * Truncate display text to a maximum length, including the ellipsis.
 * @param {unknown} value - text.
 * @param {number} max - maximum length.
 * @returns {string} truncated one-line text.
 */
function truncate(value, max) {
  const source = text(value).replace(/\r?\n/g, ' ')
  if (source.length <= max) return source
  return `${source.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Group open threads by kind while preserving first-seen order.
 * @param {Array<object>} threads - receipt threads.
 * @returns {Map<string, Array<object>>} threads grouped by kind.
 */
function groupThreads(threads) {
  const groups = new Map()
  for (const thread of threads) {
    const kind = text(thread.kind)
    if (!groups.has(kind)) groups.set(kind, [])
    groups.get(kind).push(thread)
  }
  return groups
}
