/**
 * Host half of the Restart app bundle.
 *
 * A profile that replaced an already-installed plugin package loads the new
 * code only when the Desktop app starts again. The Host is a child process of
 * the Electron shell and cannot relaunch that shell itself, so this half
 * registers the `/restart-app` command the browser button dispatches and hands
 * the relaunch to a detached helper that survives the app's exit.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

/** Cordis function-plugin name. */
export const name = 'restart-app'
/** The command registry owns the Host entry point the button calls. */
export const inject = ['commands']

/** Windows image name of the Desktop shell that owns this Host. */
const APP_IMAGE = 'deepseek harness.exe'
/** Slash command the button dispatches. */
const COMMAND = 'restart-app'
/** Detached relauncher shipped beside this module. */
const HELPER = fileURLToPath(new URL('./restart-helper.mjs', import.meta.url))
/** Milliseconds the helper waits before it closes the app, so this reply lands first. */
const DEFAULT_DELAY_MS = 1500
/** Promise form of `execFile`, used for the one process lookup. */
const execFileAsync = promisify(execFile)

/**
 * Resolve one process's Windows image name.
 * @param pid - process id to look up.
 * @returns the image name, or undefined when the lookup cannot run.
 */
async function imageNameOf(pid) {
  try {
    const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe')
    const { stdout } = await execFileAsync(tasklist, ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    })
    const line = stdout.split(/\r?\n/u).find(entry => entry.trim() !== '')
    if (line === undefined) return undefined
    const match = /^"([^"]+)"/u.exec(line.trim())
    return match?.[1]
  } catch {
    return undefined
  }
}

/** True when this Host is the Desktop app's child rather than a terminal run. */
function runningInDesktopApp() {
  if (process.platform !== 'win32') return false
  return basename(process.execPath).toLowerCase() === APP_IMAGE
}

/**
 * Start the detached relauncher and return the text the command reports.
 *
 * Every check happens before anything is spawned: a refusal leaves the app
 * untouched and says why.
 * @param state - one object owned by the plugin instance, so a second click
 *   cannot schedule a second restart while the first one is closing the app.
 * @returns the command outcome text with whether the restart was scheduled.
 */
async function scheduleRestart(state) {
  if (state.pending) return { ok: false, text: 'A restart is already in progress.' }
  state.pending = true
  const refuse = (text) => {
    state.pending = false
    return { ok: false, text }
  }
  if (!runningInDesktopApp()) {
    return refuse('Restart is available only in the DeepSeek Harness desktop app; a Host started from a terminal has no app to relaunch.')
  }
  const mainPid = process.ppid
  if (typeof mainPid !== 'number' || mainPid <= 0) {
    return refuse('Restart could not locate the Desktop app that owns this Host.')
  }
  const parentImage = await imageNameOf(mainPid)
  if (parentImage !== undefined && parentImage.toLowerCase() !== APP_IMAGE) {
    return refuse(`Restart could not confirm that ${parentImage} is the DeepSeek Harness desktop app.`)
  }
  if (!existsSync(HELPER)) {
    return refuse(`Restart helper is missing: ${HELPER}`)
  }
  const logDirectory = join(tmpdir(), 'dsh-restart-app')
  const logPath = join(logDirectory, `restart-${String(Date.now())}.log`)
  try {
    await mkdir(logDirectory, { recursive: true })
    const child = spawn(process.execPath, [
      HELPER,
      '--main', String(mainPid),
      '--host', String(process.pid),
      '--app', process.execPath,
      '--delay', String(DEFAULT_DELAY_MS),
      '--log', logPath,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: dirname(process.execPath),
      // The shell runs this executable in Node mode; the helper needs the same
      // mode while the app it launches must not inherit it.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on('error', (error) => {
      console.warn('restart-app: could not start the relauncher', error)
    })
    child.unref()
  } catch (error) {
    return refuse(`Restart could not start its helper: ${String(error?.message ?? error)}`)
  }
  return { ok: true, text: 'Restarting DeepSeek Harness. The app closes and reopens; its sessions are kept.' }
}

/**
 * Register the restart command.
 * @param ctx - Cordis context.
 */
export function apply(ctx) {
  const state = { pending: false }
  ctx.effect(() => ctx.commands.register({
    name: COMMAND,
    description: 'Restart DeepSeek Harness so plugin changes installed in this profile take effect.',
    handler: async () => {
      const outcome = await scheduleRestart(state)
      return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
    },
  }), 'restart-app: /restart-app command')
}
