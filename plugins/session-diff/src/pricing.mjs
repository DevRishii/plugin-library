/**
 * Token pricing for receipts.
 *
 * The table mirrors `@local/turn-cost/client.js` (the local plugin that renders
 * Session cost) so the receipt and the composer pill never disagree. Rates are
 * USD per 1,000,000 tokens, at the published peak rate. DeepSeek off-peak usage
 * bills at exactly half; the provider's peak windows are 01:00-04:00 and
 * 06:00-10:00 UTC on weekdays, as recorded in that plugin.
 */

/** Published rates per model, USD per 1,000,000 tokens. */
export const RATES = Object.freeze({
  'deepseek-flash': { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, peakPriced: true },
  'deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96, peakPriced: true },
  'deep-research-max-preview-04-2026': { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 },
  'deep-research-preview-04-2026': { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 },
  'gemini-2.5-flash': { input: 0.3, cacheRead: 0.03, cacheWrite: 0, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, cacheRead: 0.125, cacheWrite: 0, output: 10 },
  'gemini-3-flash-preview': { input: 0.5, cacheRead: 0.05, cacheWrite: 0, output: 3 },
  'gemini-3.1-pro-preview': { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 },
  'gemini-3.5-flash': { input: 1.5, cacheRead: 0.15, cacheWrite: 0, output: 9 },
  'gemini-4-argon': { input: 2, cacheRead: 0.1, cacheWrite: 0, output: 10 },
  'gemini-4-carbon': { input: 2, cacheRead: 0.1, cacheWrite: 0, output: 10 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  'claude-opus-4-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-opus-4-6': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'gpt-5.1': { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10 },
})

/** Off-peak multiplier published for DeepSeek pay-as-you-go. */
export const OFF_PEAK_FACTOR = 0.5
/** Peak windows as [startHour, endHour) in UTC, Monday through Friday. */
export const PEAK_WINDOWS = Object.freeze([[1, 4], [6, 10]])

/**
 * Whether a moment falls inside a DeepSeek peak window.
 * @param {number} epochMs - event timestamp.
 * @returns {boolean} true inside a peak window.
 */
export function isPeak(epochMs) {
  const date = new Date(epochMs)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Price one usage record for one model.
 * @param {string} model - provider model id.
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage - token buckets.
 * @param {number} epochMs - the moment the usage was recorded; selects the DeepSeek peak factor.
 * @returns {{usd: number|null, peak: boolean|null, rate: object|null, reason?: string}} the priced result.
 */
export function priceUsage(model, usage, epochMs) {
  const rate = RATES[model]
  if (rate === undefined) return { usd: null, peak: null, rate: null, reason: `no published rate for ${model}` }
  const peak = rate.peakPriced === true ? isPeak(epochMs) : null
  const factor = peak === false ? OFF_PEAK_FACTOR : 1
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const usd = (input * rate.input + output * rate.output + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite) / 1_000_000 * factor
  return { usd, peak, rate }
}

/**
 * Format USD for display, keeping cents visible.
 * @param {number|null} value - amount in USD.
 * @returns {string} `$0.0000`-style text, or `unknown`.
 */
export function formatUsd(value) {
  if (value === null || value === undefined) return 'unknown'
  return `$${value.toFixed(4)}`
}
