# @local/turn-cost

Shows an estimated API cost for the current session in the composer
statistics row, immediately before the shipped total-token reading.

## What it does

- The shipped composer statistics are two `conversation.composer.dock`
  entries: `activity` (order 0) and `usage` (order 1). This plugin adds a
  third control, `session-cost` at order 0.5, so it renders between them and
  keeps both shipped controls, their readings, and their dialogs intact.
- The reading is `≈ $x.xxx` tagged `est.`, with a tooltip naming it
  "Est. session cost" and disclosing the approximation.
- Clicking the reading opens a breakdown panel: total cost, the priced model
  and peak/off-peak rate, exact token counts, and the cost split across
  uncached input, cache read, cache write, and output.
- The panel's **Models** tab groups completed turns by provider/model from the
  Chat snapshot's turn usage and prices each route with that model's rates.
  It reads the loaded Chat window, so paged-out turns appear only in the Total
  tab.
- The panel's **Refresh** button asks the Client sessions service to re-read
  the session's projections (`refreshProjections(sessionId)`) and then
  re-renders the estimate from the latest token counts. The reading is also
  reactive, so new usage normally updates it without pressing Refresh.
- It prices the four buckets of the whole-log `tokenUsage` projection
  (`cacheReadTokens`, `uncachedInputTokens`, `cacheWriteTokens`,
  `outputTokens`) with each model's own published input, cache-read,
  cache-write, and output rates.
- The session's `modelSelection` projection picks the rate row. `lastUsed`
  (the route that served the recorded requests) wins over `next`, so merely
  selecting a different model does not reprice tokens that were billed at the
  previous model's rates.

## Pricing coverage

The table in `client.js` covers DeepSeek and the Gemini, Claude, and OpenAI
chat models in the pi-ai catalog installed with this Harness. Headline rates
for the current frontier models, USD per 1,000,000 tokens:

| Model | Input | Cache read | Cache write | Output |
|---|---:|---:|---:|---:|
| Gemini 4 Argon | 2.00 | 0.10 | 0 | 10.00 |
| Gemini 4 Carbon | 2.00 | 0.10 | 0 | 10.00 |
| Claude Opus 5.5 | 4.00 | 0.20 | 5.00 | 20.00 |
| Claude Sonnet 5.5 | 2.00 | 0.10 | 2.50 | 10.00 |
| Claude Haiku 5.5 | 0.10 | 0.01 | 0.125 | 0.50 |
| GPT-6.1 Sol | 2.00 | 0.10 | 2.50 | 10.00 |
| GPT-6.1 Terra | 1.00 | 0.05 | 1.25 | 5.00 |
| GPT-5.6 Luna | 0.20 | 0.02 | 0.25 | 1.20 |

The Gemini, Claude, and OpenAI rows come from the installed pi-ai catalog
(`dist/providers/data/*.json`), cross-checked against the providers'
pricing pages. Gemini 4 Carbon uses its launch rate through 2026-11-30 and
doubles on 2026-12-01. GPT-6.1 Terra is published at half the Sol rate.

Model ids match exactly, then by the longest table key the id extends across
`-`, `.`, or `@`. Provider prefixes (`google/gemini-4-argon`), route prefixes
(`openai:gpt-6.1-sol`), and gateway variants (`gemini-4-argon:free`) are
removed before matching. An unrecognized id is priced at the closest
same-family fallback (Opus/Sonnet/Haiku, Gemini Flash/Argon, or GPT
Luna/Terra/Sol), and the tooltip names both the unknown model and the
fallback.

## Peak and cache pricing

- Only the DeepSeek rows carry `peak: true`. Every other provider uses its
  published flat rates all day, so the DeepSeek peak/off-peak factor is not
  applied to Gemini, Claude, or OpenAI usage.
- Cache reads use `cacheRead`; cache writes use `cacheWrite`. DeepSeek has no
  separate cache-write price, so its `cacheWrite` equals the cache-miss input
  rate. Claude and OpenAI `cacheWrite` values are the 5-minute cache rates.
  Gemini reports no separate cache-write charge, so its `cacheWrite` is 0.

## Accuracy limits

The aggregate `tokenUsage` buckets carry no per-attempt timestamp, per-request
input size, or per-model split. Consequently:

- One peak/off-peak factor is chosen from the session's last recorded activity
  time (`updatedAt`; wall clock when unavailable), not per DeepSeek attempt.
- A session that used several models is priced at the last served model's
  rates for all buckets.
- Long-context price tiers are not modeled: Claude Haiku 5.5 above 100K input
  tokens, and GPT models above 272K input tokens, bill higher rates that the
  session aggregate cannot attribute to individual requests.
- Chinese public holidays are not modeled.

The figures are an estimate, not a bill.

## Install

This bundle is already installed and linked in the `desktop` profile. Editing
`client.js` does not require a reinstall; a page refresh picks up Client-file
changes when hot reload is unavailable.
