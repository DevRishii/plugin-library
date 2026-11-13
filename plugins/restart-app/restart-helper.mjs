/**
 * Detached relauncher for the DeepSeek Harness desktop shell.
 *
 * The Host cannot relaunch its parent Electron shell, and a helper started as
 * an ordinary child would be torn down with it. This module is spawned
 * detached from the Host with `ELECTRON_RUN_AS_NODE`, so it keeps running after
 * the app exits: it closes the shell and the Host, then starts the app again.
 *
 * Usage: restart-helper.mjs --main <pid> --host <pid> --app <exe> --delay <ms> --log <file>
 */

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Milliseconds to wait before closing the app, giving the command reply time to arrive. */
const MIN_DELAY_MS = 250
/** How long to wait for a killed process to disappear. */
const EXIT_TIMEOUT_MS = 15_000
/** Attempts for starting the app again. */
const LAUNCH_ATTEMPTS = 3

/**
 * Parse `--name value` pairs.
 * @param argv - arguments after the script path.
 * @returns the named options.
 */
function parseOptions(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (typeof name !== 'string' || !name.startsWith('--')) continue
    if (typeof value === 'string') options[name.slice(2)] = value
  }
  return options
}

const options = parseOptions(process.argv.slice(2))
const logPath = typeof options.log === 'string' ? options.log : undefined
const mainPid = Number(options.main)
const hostPid = Number(options.host)
const appPath = typeof options.app === 'string' ? options.app : process.execPath
const requestedDelay = Number(options.delay)
const startingDelay = Number.isFinite(requestedDelay) && requestedDelay >= MIN_DELAY_MS ? requestedDelay : 1_500

/** Append one diagnostic line; a log failure never stops the relaunch. */
function log(line) {
  if (logPath === undefined) return
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // The relaunch matters more than its diagnosis.
  }
}

/** The system taskkill path; PATH may be trimmed inside the app's environment. */
function taskkillPath() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

/**
 * Whether a process id still names a live process.
 * @param pid - process id to test.
 * @returns true while the process exists.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Force one process to stop.
 * @param pid - process id to stop.
 * @param label - diagnostic name of the target.
 */
function forceKill(pid, label) {
  if (!Number.isInteger(pid) || pid <= 0) {
    log(`skip kill: no ${label} pid`)
    return
  }
  try {
    execFileSync(taskkillPath(), ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: EXIT_TIMEOUT_MS,
    })
    log(`killed ${label} ${String(pid)}`)
  } catch (error) {
    log(`kill ${label} ${String(pid)} finished with ${String(error?.status ?? error?.message ?? error)}`)
  }
}

/**
 * Wait until a process id stops naming a live process.
 * @param pid - process id to watch.
 * @param timeoutMs - longest wait.
 * @returns whether the process is gone.
 */
async function waitUntilGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await delay(150)
  }
  return !isAlive(pid)
}

/** Environment for the app: the shell's executable must not start in Node mode. */
function appEnvironment() {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

/**
 * Start the app and report whether it stayed up.
 * @param attempt - attempt number for the log.
 * @returns whether the app is running.
 */
function launchApp(attempt) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(appPath, [], {
        detached: true,
        stdio: 'ignore',
        cwd: dirname(appPath),
        env: appEnvironment(),
      })
    } catch (error) {
      finish({ ok: false, reason: String(error?.message ?? error) })
      return
    }
    child.on('error', (error) => finish({ ok: false, reason: String(error?.message ?? error) }))
    child.on('exit', (code, signal) => {
      if (code === 0) {
        // Another instance already owned the single-instance lock: the app is up.
        finish({ ok: true, alreadyRunning: true })
      } else {
        finish({ ok: false, reason: `exited with ${String(code ?? signal)}` })
      }
    })
    child.unref()
    setTimeout(() => finish({ ok: true, pid: child.pid }), 2_500)
    log(`launch attempt ${String(attempt)}: started ${appPath}`)
  })
}

/**
 * Close the shell and the Host, then start the app again.
 * @returns the process exit code for this helper.
 */
async function main() {
  log(`helper start main=${String(mainPid)} host=${String(hostPid)} app=${appPath} delay=${String(startingDelay)}`)
  await delay(startingDelay)
  // The shell goes first: a Host that disappears under a live shell only raises
  // the shell's crash recovery dialog.
  forceKill(mainPid, 'shell')
  const shellGone = await waitUntilGone(mainPid, EXIT_TIMEOUT_MS)
  log(`shell gone: ${String(shellGone)}`)
  forceKill(hostPid, 'host')
  await waitUntilGone(hostPid, EXIT_TIMEOUT_MS)
  log('host gone')
  // Let the listening socket and the single-instance lock settle.
  await delay(1_000)
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    const result = await launchApp(attempt)
    if (result.ok) {
      log(`app running${result.alreadyRunning === true ? ' (existing instance)' : ` pid=${String(result.pid)}`}`)
      return 0
    }
    log(`launch attempt ${String(attempt)} failed: ${String(result.reason)}`)
    await delay(1_500)
  }
  log('FAILED to relaunch the app')
  return 1
}

main().then((code) => {
  process.exitCode = code
}, (error) => {
  log(`helper failed: ${String(error?.stack ?? error)}`)
  process.exitCode = 1
})
