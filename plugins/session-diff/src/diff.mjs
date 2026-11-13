/**
 * Compare two Session receipts without reading the filesystem.
 *
 * File identity is the receipt path, model identity is the model id, and thread
 * identity is `kind + "\u0000" + detail`. Generated timestamps are metadata, not
 * content, so two otherwise equal receipts remain identical across runs.
 */

/**
 * Compare two receipts.
 * @param {object} left - the earlier receipt.
 * @param {object} right - the later receipt.
 * @returns {{
 *   identical: boolean,
 *   from: {sessionId: string, generatedAt: number | null},
 *   to: {sessionId: string, generatedAt: number | null},
 *   session: {sameSession: boolean, sameCwd: boolean},
 *   files: {
 *     added: string[],
 *     removed: string[],
 *     changed: Array<{path: string, fromStatus: string | null, toStatus: string | null, fromAfterSha256: string | null, toAfterSha256: string | null}>
 *   },
 *   commands: {before: number, after: number, delta: number, beforeFailed: number, afterFailed: number, deltaFailed: number},
 *   cost: {before: number | null, after: number | null, delta: number, byModel: Array<{model: string, before: number | null, after: number | null, delta: number}>},
 *   models: {added: string[], removed: string[]},
 *   threads: {resolved: Array<{kind: string, detail: string}>, opened: Array<{kind: string, detail: string}>, persisted: Array<{kind: string, detail: string}>}
 * }} the comparison.
 */
export function compareReceipts(left, right) {
  const leftReceipt = left ?? {}
  const rightReceipt = right ?? {}
  const leftFiles = fileMap(leftReceipt)
  const rightFiles = fileMap(rightReceipt)
  const leftCommands = commandList(leftReceipt)
  const rightCommands = commandList(rightReceipt)
  const beforeFailed = failedCount(leftCommands)
  const afterFailed = failedCount(rightCommands)
  const leftCosts = modelCostMap(leftReceipt)
  const rightCosts = modelCostMap(rightReceipt)
  const leftModels = modelNames(leftReceipt)
  const rightModels = modelNames(rightReceipt)
  const leftThreads = threadMap(leftReceipt)
  const rightThreads = threadMap(rightReceipt)

  const addedFiles = []
  const removedFiles = []
  const changedFiles = []
  for (const path of rightFiles.keys()) {
    if (!leftFiles.has(path)) addedFiles.push(path)
  }
  for (const path of leftFiles.keys()) {
    if (!rightFiles.has(path)) {
      removedFiles.push(path)
      continue
    }
    const from = leftFiles.get(path)
    const to = rightFiles.get(path)
    if (from.status !== to.status || from.afterSha256 !== to.afterSha256) {
      changedFiles.push({
        path,
        fromStatus: from.status,
        toStatus: to.status,
        fromAfterSha256: from.afterSha256,
        toAfterSha256: to.afterSha256,
      })
    }
  }

  const byModel = []
  const modelOrder = [...leftCosts.keys()]
  for (const model of rightCosts.keys()) {
    if (!leftCosts.has(model)) modelOrder.push(model)
  }
  for (const model of modelOrder) {
    const before = leftCosts.has(model) ? leftCosts.get(model) : null
    const after = rightCosts.has(model) ? rightCosts.get(model) : null
    byModel.push({
      model,
      before,
      after,
      delta: roundCost((after ?? 0) - (before ?? 0)),
    })
  }

  const modelsAdded = [...rightModels].filter(model => !leftModels.has(model))
  const modelsRemoved = [...leftModels].filter(model => !rightModels.has(model))
  const resolved = []
  const opened = []
  const persisted = []
  for (const [key, thread] of leftThreads) {
    if (!rightThreads.has(key)) resolved.push(thread)
    else persisted.push(thread)
  }
  for (const [key, thread] of rightThreads) {
    if (!leftThreads.has(key)) opened.push(thread)
  }

  const before = costValue(leftReceipt.summary?.totalCostUsd)
  const after = costValue(rightReceipt.summary?.totalCostUsd)

  return {
    identical: contentKey(leftReceipt) === contentKey(rightReceipt),
    from: {
      sessionId: leftReceipt.session?.id ?? 'unknown',
      generatedAt: leftReceipt.generatedAt ?? null,
    },
    to: {
      sessionId: rightReceipt.session?.id ?? 'unknown',
      generatedAt: rightReceipt.generatedAt ?? null,
    },
    session: {
      sameSession: (leftReceipt.session?.id ?? null) === (rightReceipt.session?.id ?? null),
      sameCwd: (leftReceipt.session?.cwd ?? null) === (rightReceipt.session?.cwd ?? null),
    },
    files: {
      added: addedFiles,
      removed: removedFiles,
      changed: changedFiles,
    },
    commands: {
      before: leftCommands.length,
      after: rightCommands.length,
      delta: rightCommands.length - leftCommands.length,
      beforeFailed,
      afterFailed,
      deltaFailed: afterFailed - beforeFailed,
    },
    cost: {
      before,
      after,
      delta: roundCost((after ?? 0) - (before ?? 0)),
      byModel,
    },
    models: {
      added: modelsAdded,
      removed: modelsRemoved,
    },
    threads: {
      resolved,
      opened,
      persisted,
    },
  }
}

/**
 * Index receipt files by path.
 * @param {object} receipt - one receipt.
 * @returns {Map<string, {path: string, status: string | null, afterSha256: string | null}>} files by path.
 */
function fileMap(receipt) {
  const files = new Map()
  for (const file of Array.isArray(receipt.files) ? receipt.files : []) {
    if (file === null || typeof file !== 'object') continue
    if (typeof file.path !== 'string') continue
    files.set(file.path, {
      path: file.path,
      status: file.status ?? null,
      afterSha256: file.afterSha256 ?? null,
    })
  }
  return files
}

/**
 * Read a receipt's command array.
 * @param {object} receipt - one receipt.
 * @returns {Array<object>} commands, or an empty array.
 */
function commandList(receipt) {
  return Array.isArray(receipt.commands) ? receipt.commands : []
}

/**
 * Count commands that failed, preferring the receipt's explicit `ok` verdict.
 * @param {Array<object>} commands - receipt commands.
 * @returns {number} failed command count.
 */
function failedCount(commands) {
  return commands.filter((command) => {
    if (command?.ok === true) return false
    if (command?.ok === false) return true
    return command?.exitCode !== 0
  }).length
}

/**
 * Index model costs by model id, summing duplicate rows.
 * @param {object} receipt - one receipt.
 * @returns {Map<string, number | null>} model cost, or null when unpriced.
 */
function modelCostMap(receipt) {
  const totals = new Map()
  for (const entry of Array.isArray(receipt.models) ? receipt.models : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.model === null || entry.model === undefined) continue
    const model = String(entry.model)
    const current = totals.get(model) ?? { total: 0, priced: false }
    if (typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd)) {
      current.total += entry.costUsd
      current.priced = true
    }
    totals.set(model, current)
  }
  const costs = new Map()
  for (const [model, value] of totals) costs.set(model, value.priced ? roundCost(value.total) : null)
  return costs
}

/**
 * Read a receipt's unique model ids in receipt order.
 * @param {object} receipt - one receipt.
 * @returns {Set<string>} model ids.
 */
function modelNames(receipt) {
  const names = new Set()
  for (const entry of Array.isArray(receipt.models) ? receipt.models : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.model === null || entry.model === undefined) continue
    names.add(String(entry.model))
  }
  return names
}

/**
 * Index open threads by kind and detail.
 * @param {object} receipt - one receipt.
 * @returns {Map<string, {kind: string, detail: string}>} threads by identity.
 */
function threadMap(receipt) {
  const threads = new Map()
  for (const thread of Array.isArray(receipt.threads) ? receipt.threads : []) {
    if (thread === null || typeof thread !== 'object') continue
    const kind = thread.kind === null || thread.kind === undefined ? 'unknown' : String(thread.kind)
    const detail = thread.detail === null || thread.detail === undefined ? 'unknown' : String(thread.detail)
    threads.set(`${kind}\u0000${detail}`, { kind, detail })
  }
  return threads
}

/**
 * Round a cost to six decimals.
 * @param {number} value - amount in USD.
 * @returns {number} rounded amount.
 */
function roundCost(value) {
  const rounded = Math.round(value * 1_000_000) / 1_000_000
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Coerce a receipt cost to a rounded number or null.
 * @param {unknown} value - receipt field.
 * @returns {number | null} rounded amount, or null when absent or invalid.
 */
function costValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? roundCost(value) : null
}

/**
 * Content identity for a receipt, excluding only the generated timestamp.
 * @param {object} receipt - one receipt.
 * @returns {string} canonical JSON text.
 */
function contentKey(receipt) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return stableStringify(receipt)
  }
  const content = { ...receipt }
  delete content.generatedAt
  return stableStringify(content)
}

/**
 * Serialize a value with object keys sorted so property insertion order does
 * not affect identity.
 * @param {unknown} value - value to serialize.
 * @returns {string} canonical JSON text.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const fields = []
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue
    fields.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`)
  }
  return `{${fields.join(',')}}`
}
