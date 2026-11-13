/**
 * Server-rendered Session Tripwire board.
 *
 * The host plugin serves this HTML at `/tripwire/board`; the same renderer is
 * used by `demo/render-board.mjs` to produce a static screenshot fixture.
 */

import { shortHash } from './ledger.js'

/**
 * Escape text for HTML text and attribute positions.
 * @param value - raw value.
 * @returns escaped text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Format one epoch millisecond value for display.
 * @param value - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:mm:ss UTC`, or `never`.
 */
export function formatTime(value) {
  if (!Number.isFinite(value)) return 'never'
  return `${new Date(value).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

/**
 * Describe a lease expiry relative to the render time.
 * @param expiresAt - epoch milliseconds.
 * @param now - render time.
 * @returns a short countdown.
 */
function remaining(expiresAt, now) {
  const delta = expiresAt - now
  if (delta <= 0) return 'expired'
  if (delta < 60_000) return `${Math.ceil(delta / 1000)}s`
  if (delta < 3_600_000) return `${Math.ceil(delta / 60_000)}m`
  return `${Math.ceil(delta / 3_600_000)}h`
}

/** Render the mode buttons. */
function modeButtons(status) {
  return ['observe', 'warn', 'block'].map(mode => `<button type="button" class="mode ${status.mode === mode ? 'selected' : ''}" data-tripwire-action="set-mode" data-mode="${mode}" title="Set enforcement mode to ${mode}">${mode}</button>`).join('')
}

/** Render the holders table. */
function holdersTable(status, now) {
  if (status.leases.length === 0) {
    return '<p class="empty">No leases. The first write to a path takes ownership.</p>'
  }
  const rows = status.leases.map((lease) => {
    const write = status.writes.find(entry => entry.key === lease.key)
    const expired = lease.expiresAt <= now
    return `<tr class="${expired ? 'expired' : ''}">
      <td class="path" title="${escapeHtml(lease.key)}">${escapeHtml(lease.path)}</td>
      <td><span class="mono">${escapeHtml(lease.owner)}</span><br><span class="muted">session ${escapeHtml(lease.sessionId)}</span></td>
      <td class="mono">${escapeHtml(lease.fence)}</td>
      <td class="mono">${escapeHtml(remaining(lease.expiresAt, now))}</td>
      <td class="mono">${escapeHtml(shortHash(write?.hash))}</td>
      <td class="muted">${escapeHtml(shortHash(write?.beforeHash))} → ${escapeHtml(shortHash(write?.hash))}</td>
      <td><button type="button" class="quiet" data-tripwire-action="release" data-path="${escapeHtml(lease.path)}">release</button></td>
    </tr>`
  }).join('')
  return `<table>
    <thead><tr><th>path</th><th>holder</th><th>fence</th><th>lease</th><th>hash</th><th>last change</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

/** Render the ignore chips. */
function ignoreList(status) {
  return status.ignore.map(entry => `<span class="chip">${escapeHtml(entry.pattern)}<button type="button" class="chip-x" title="Remove ${escapeHtml(entry.pattern)}" data-tripwire-action="unignore" data-pattern="${escapeHtml(entry.pattern)}">×</button></span>`).join('')
}

/** Render the conflict feed. */
function conflictFeed(status) {
  if (status.conflicts.length === 0) return '<p class="empty">No conflicts recorded.</p>'
  return `<ul class="conflicts">${status.conflicts.slice(0, 8).map((conflict) => {
    const badge = conflict.decision === 'blocked' ? 'blocked' : conflict.decision === 'warned' ? 'warned' : conflict.decision === 'stale' ? 'stale' : 'observed'
    return `<li>
      <span class="badge ${escapeHtml(badge)}">${escapeHtml(badge)}</span>
      <span class="mono path">${escapeHtml(conflict.path)}</span>
      <span class="muted">session ${escapeHtml(conflict.writerSessionId)} vs ${escapeHtml(conflict.otherSessionId ?? 'unknown')} · ${escapeHtml(formatTime(conflict.at))}</span>
    </li>`
  }).join('')}</ul>`
}

/** Render recent writes with before/after hashes. */
function writeFeed(status) {
  if (status.writes.length === 0) return '<p class="empty">No writes recorded.</p>'
  return `<ul class="writes">${status.writes.slice(0, 8).map(write => `<li>
    <span class="mono path">${escapeHtml(write.path)}</span>
    <span class="muted">session ${escapeHtml(write.sessionId)} · ${write.fence === null ? 'observed write' : `fence ${escapeHtml(write.fence)}`} · ${escapeHtml(formatTime(write.at))}</span>
    <span class="hashline">${escapeHtml(shortHash(write.beforeHash))} → ${escapeHtml(shortHash(write.hash))}${write.changed ? ' <em>changed</em>' : ''}</span>
  </li>`).join('')}</ul>`
}

/**
 * Render the complete board page.
 * @param status - snapshot returned by `TripwireLedger.status()`.
 * @param options - render clock and optional board title.
 * @returns a complete HTML document.
 */
export function renderBoard(status, options = {}) {
  const now = options.now ?? Date.now()
  const blocked = status.conflicts.filter(entry => entry.decision === 'blocked').length
  const kill = status.killSwitch === true
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Tripwire</title>
<style>
  :root { color-scheme: dark; --bg:#0d1015; --panel:#161a21; --panel2:#1d222b; --line:#2b323d; --text:#e7ecf3; --muted:#8b96a7; --accent:#5aa9ff; --ok:#4ade80; --warn:#ffb454; --bad:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; padding:28px 24px 48px; }
  header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:22px; }
  h1 { margin:0; font-size:22px; letter-spacing:.2px; }
  h1 span { color:var(--accent); }
  .sub { margin-top:6px; color:var(--muted); font-size:12px; }
  .pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--panel); border-radius:999px; padding:5px 11px; color:var(--muted); font-size:12px; }
  .pill strong { color:var(--text); font-weight:600; }
  .pill.bad strong { color:var(--bad); }
  .pill.ok strong { color:var(--ok); }
  .stats { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; margin-bottom:18px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .stat b { display:block; font-size:24px; font-weight:650; }
  .stat span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.7px; }
  .layout { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(280px,1fr); gap:16px; align-items:start; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:16px; }
  .card h2 { margin:0 0 12px; font-size:13px; text-transform:uppercase; letter-spacing:1px; color:var(--muted); font-weight:650; }
  .controls { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:16px; }
  .mode { border:1px solid var(--line); background:var(--panel2); color:var(--muted); border-radius:8px; padding:7px 13px; cursor:pointer; font:inherit; }
  .mode.selected { border-color:var(--accent); color:var(--text); background:#16304d; }
  .mode:hover { color:var(--text); }
  .danger { border:1px solid var(--bad); background:#3a1a1d; color:#ffdada; border-radius:8px; padding:7px 13px; cursor:pointer; font:inherit; }
  .safe { border:1px solid var(--ok); background:#11301f; color:#d9ffe8; border-radius:8px; padding:7px 13px; cursor:pointer; font:inherit; }
  .quiet { border:1px solid var(--line); background:transparent; color:var(--muted); border-radius:7px; padding:3px 9px; cursor:pointer; font:inherit; font-size:12px; }
  .quiet:hover { color:var(--text); border-color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.6px; padding:0 8px 8px 0; border-bottom:1px solid var(--line); }
  td { padding:9px 8px 9px 0; border-bottom:1px solid #232933; vertical-align:top; }
  tr.expired td { opacity:.55; }
  .mono { font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; }
  .muted { color:var(--muted); font-size:12px; }
  .path { max-width:360px; overflow-wrap:anywhere; }
  .empty { color:var(--muted); font-style:italic; margin:6px 0; }
  ul { list-style:none; margin:0; padding:0; }
  .conflicts li, .writes li { padding:9px 0; border-bottom:1px solid #232933; display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; }
  .conflicts li:last-child, .writes li:last-child { border-bottom:0; }
  .badge { border-radius:999px; padding:2px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.7px; border:1px solid var(--line); color:var(--muted); }
  .badge.blocked { border-color:var(--bad); color:#ffdada; background:#3a1a1d; }
  .badge.warned { border-color:var(--warn); color:#ffe9c7; background:#3a2a13; }
  .badge.stale { border-color:var(--bad); color:#ffdada; background:#3a1a1d; }
  .badge.observed { border-color:var(--accent); color:#cfe6ff; background:#16304d; }
  .hashline { margin-left:auto; color:var(--muted); font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:11.5px; }
  .chip { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); background:var(--panel2); border-radius:999px; padding:4px 6px 4px 10px; margin:0 7px 7px 0; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; }
  .chip-x { border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:15px; line-height:1; padding:0 3px; }
  .chip-x:hover { color:var(--bad); }
  .ignore-form { display:flex; gap:8px; margin-top:10px; }
  .ignore-form input { flex:1; min-width:0; background:var(--panel2); border:1px solid var(--line); border-radius:8px; color:var(--text); padding:7px 10px; font:inherit; }
  .ignore-form button { border:1px solid var(--accent); background:#16304d; color:var(--text); border-radius:8px; padding:7px 12px; cursor:pointer; font:inherit; }
  footer { margin-top:22px; color:var(--muted); font-size:12px; }
  @media (max-width: 900px) { .layout { grid-template-columns:1fr; } .stats { grid-template-columns:repeat(2,1fr); } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Session <span>Tripwire</span></h1>
      <div class="sub">workspace ${escapeHtml(status.root)} · updated ${escapeHtml(formatTime(status.updatedAt))}</div>
    </div>
    <div>
      <span class="pill ${kill ? 'bad' : 'ok'}">kill switch <strong>${kill ? 'ON' : 'OFF'}</strong></span>
      <span class="pill">mode <strong>${escapeHtml(status.mode)}</strong></span>
    </div>
  </header>

  <div class="stats">
    <div class="stat"><b>${escapeHtml(status.stats.liveWriters)}</b><span>live writers</span></div>
    <div class="stat"><b>${escapeHtml(status.stats.activeLeases)}</b><span>active leases</span></div>
    <div class="stat"><b>${escapeHtml(status.stats.writes)}</b><span>recorded writes</span></div>
    <div class="stat"><b>${escapeHtml(blocked)}</b><span>blocked conflicts</span></div>
  </div>

  <div class="controls">
    ${modeButtons(status)}
    ${kill
      ? '<button type="button" class="safe" data-tripwire-action="revive">Turn kill switch off</button>'
      : '<button type="button" class="danger" data-tripwire-action="kill">Turn kill switch on</button>'}
    <span class="muted">observe logs · warn injects a notice · block refuses the write</span>
  </div>

  <div class="layout">
    <div>
      <div class="card">
        <h2>Who holds what</h2>
        ${holdersTable(status, now)}
      </div>
      <div class="card">
        <h2>Recent writes</h2>
        ${writeFeed(status)}
      </div>
    </div>
    <div>
      <div class="card">
        <h2>Ignore list</h2>
        <div>${ignoreList(status)}</div>
        <form class="ignore-form" id="ignore-form">
          <input id="ignore-pattern" placeholder="generated/** or *.map" autocomplete="off">
          <button type="submit">add</button>
        </form>
      </div>
      <div class="card">
        <h2>Conflicts</h2>
        ${conflictFeed(status)}
      </div>
    </div>
  </div>

  <footer>
    Writes are recorded with SHA-256 hashes. A lease ends when its TTL expires, so a crashed
    session cannot hold a file forever. Board actions rewrite the workspace ledger at
    <span class="mono">.dsh/tripwire/state.json</span>.
  </footer>
</div>
<script>
  const act = async (body) => {
    try {
      const response = await fetch('/tripwire/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(await response.text())
      location.reload()
    } catch (error) {
      alert('Tripwire action failed: ' + error.message)
    }
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tripwire-action]')
    if (button === null) return
    const body = { action: button.dataset.tripwireAction }
    if (button.dataset.mode) body.mode = button.dataset.mode
    if (button.dataset.pattern) body.pattern = button.dataset.pattern
    if (button.dataset.path) body.path = button.dataset.path
    void act(body)
  })
  const form = document.getElementById('ignore-form')
  if (form !== null) {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const input = document.getElementById('ignore-pattern')
      const pattern = input.value.trim()
      if (pattern !== '') void act({ action: 'ignore', pattern })
    })
  }
  if (location.protocol !== 'file:') {
    setInterval(() => location.reload(), 5000)
  }
</script>
</body>
</html>`
}
