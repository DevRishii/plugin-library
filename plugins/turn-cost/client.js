window.__ModuleLoader__.load({
  id: '@local/turn-cost',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'turn-cost';

    /**
     * Published base API prices, USD per 1,000,000 tokens, read 2026-11-11.
     *
     * DeepSeek rows carry the peak rate; off-peak usage bills at exactly half.
     * Source: api-docs.deepseek.com/quick_start/pricing.
     *
     * Gemini, Claude, and OpenAI rows come from the pi-ai catalog installed
     * with this Harness (`dist/providers/data/*.json`), cross-checked against
     * platform.claude.com and developers.openai.com. `cacheWrite` is the
     * provider's 5-minute cache-write rate; Gemini reports no separate
     * cache-write charge. Gemini 4 Carbon uses its launch rate through
     * 2026-11-30 and doubles on 2026-12-01; GPT 6.1 Terra is published at
     * half the Sol rate.
     *
     * Long-context tiers are not represented here: the whole-session token
     * aggregate cannot attribute a threshold to an individual request.
     */
    const RATES = {
      // DeepSeek. Peak rates; off-peak bills at half.
      'deepseek-flash': { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, peak: true },
      'deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96, peak: true },
      // Google Gemini.
      'deep-research-max-preview-04-2026': { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 },
      'deep-research-preview-04-2026': { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 },
      'gemini-2.5-computer-use-preview-10-2025': { input: 1.25, cacheRead: 0, cacheWrite: 0, output: 10 },
      'gemini-2.5-flash': { input: 0.3, cacheRead: 0.03, cacheWrite: 0, output: 2.5 },
      'gemini-2.5-flash-lite': { input: 0.1, cacheRead: 0.01, cacheWrite: 0, output: 0.4 },
      'gemini-2.5-pro': { input: 1.25, cacheRead: 0.125, cacheWrite: 0, output: 10 },
      'gemini-3-flash-preview': { input: 0.5, cacheRead: 0.05, cacheWrite: 0, output: 3 },
      'gemini-3.1-flash-lite': { input: 0.25, cacheRead: 0.025, cacheWrite: 0, output: 1.5 },
      'gemini-3.1-flash-lite-image': { input: 0.25, cacheRead: 0, cacheWrite: 0, output: 30 },
      'gemini-3.1-flash-lite-preview': { input: 0.25, cacheRead: 0.025, cacheWrite: 0, output: 1.5 },
      'gemini-3.1-flash-live-preview': { input: 0.75, cacheRead: 0, cacheWrite: 0, output: 4.5 },
      'gemini-3.1-pro-preview': { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 },
      'gemini-3.1-pro-preview-customtools': { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 },
      'gemini-3.5-flash': { input: 1.5, cacheRead: 0.15, cacheWrite: 0, output: 9 },
      'gemini-3.5-flash-lite': { input: 0.3, cacheRead: 0.03, cacheWrite: 0, output: 2.5 },
      'gemini-3.6-flash': { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.75 },
      'gemini-3.7-flash': { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.75 },
      'gemini-3.8-flash': { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.75 },
      'gemini-4-argon': { input: 2, cacheRead: 0.1, cacheWrite: 0, output: 10 },
      'gemini-4-carbon': { input: 2, cacheRead: 0.1, cacheWrite: 0, output: 10 },
      'gemini-flash-latest': { input: 1.5, cacheRead: 0.15, cacheWrite: 0, output: 9 },
      'gemini-flash-lite-latest': { input: 0.25, cacheRead: 0.025, cacheWrite: 0, output: 1.5 },
      'gemma-4-26b-a4b-it': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      'gemma-4-31b-it': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      // Anthropic Claude.
      'claude-fable-5': { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
      'claude-fable-5-1': { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
      'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
      'claude-haiku-4-5-20251001': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
      'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
      'claude-opus-4-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
      'claude-opus-4-5-20251101': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
      'claude-opus-4-6': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
      'claude-opus-4-7': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
      'claude-opus-4-8': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
      'claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
      'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
      'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
      'claude-sonnet-4-5-20250929': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
      'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
      'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
      'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
      // OpenAI GPT.
      'gpt-4': { input: 30, cacheRead: 0, cacheWrite: 0, output: 60 },
      'gpt-4-turbo': { input: 10, cacheRead: 0, cacheWrite: 0, output: 30 },
      'gpt-4.1': { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 },
      'gpt-4.1-mini': { input: 0.4, cacheRead: 0.1, cacheWrite: 0, output: 1.6 },
      'gpt-4.1-nano': { input: 0.1, cacheRead: 0.025, cacheWrite: 0, output: 0.4 },
      'gpt-4o': { input: 2.5, cacheRead: 1.25, cacheWrite: 0, output: 10 },
      'gpt-4o-2024-05-13': { input: 5, cacheRead: 0, cacheWrite: 0, output: 15 },
      'gpt-4o-2024-08-06': { input: 2.5, cacheRead: 1.25, cacheWrite: 0, output: 10 },
      'gpt-4o-2024-11-20': { input: 2.5, cacheRead: 1.25, cacheWrite: 0, output: 10 },
      'gpt-4o-mini': { input: 0.15, cacheRead: 0.075, cacheWrite: 0, output: 0.6 },
      'gpt-5': { input: 1.25, cacheRead: 0.125, cacheWrite: 0, output: 10 },
      'gpt-5-chat-latest': { input: 1.25, cacheRead: 0.125, cacheWrite: 0, output: 10 },
      'gpt-5-mini': { input: 0.25, cacheRead: 0.025, cacheWrite: 0, output: 2 },
      'gpt-5-nano': { input: 0.05, cacheRead: 0.005, cacheWrite: 0, output: 0.4 },
      'gpt-5-pro': { input: 15, cacheRead: 0, cacheWrite: 0, output: 120 },
      'gpt-5.1': { input: 1.25, cacheRead: 0.125, cacheWrite: 0, output: 10 },
      'gpt-5.2': { input: 1.75, cacheRead: 0.175, cacheWrite: 0, output: 14 },
      'gpt-5.2-chat-latest': { input: 1.75, cacheRead: 0.175, cacheWrite: 0, output: 14 },
      'gpt-5.2-pro': { input: 21, cacheRead: 0, cacheWrite: 0, output: 168 },
      'gpt-5.3-chat-latest': { input: 1.75, cacheRead: 0.175, cacheWrite: 0, output: 14 },
      'gpt-5.3-codex': { input: 1.75, cacheRead: 0.175, cacheWrite: 0, output: 14 },
      'gpt-5.3-codex-spark': { input: 1.75, cacheRead: 0.175, cacheWrite: 0, output: 14 },
      'gpt-5.4': { input: 2.5, cacheRead: 0.25, cacheWrite: 0, output: 15 },
      'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 4.5 },
      'gpt-5.4-nano': { input: 0.2, cacheRead: 0.02, cacheWrite: 0, output: 1.25 },
      'gpt-5.4-pro': { input: 30, cacheRead: 0, cacheWrite: 0, output: 180 },
      'gpt-5.5': { input: 5, cacheRead: 0.5, cacheWrite: 0, output: 30 },
      'gpt-5.5-pro': { input: 30, cacheRead: 0, cacheWrite: 0, output: 180 },
      'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
      'gpt-5.6-sol': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
      'gpt-5.6-terra': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
      'gpt-6-astra': { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
      'gpt-6-luna': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
      'gpt-6-sol': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
      'gpt-6.1-sol': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
      'gpt-6.1-terra': { input: 1, cacheRead: 0.05, cacheWrite: 1.25, output: 5 },
      'gpt-daybreak-blue-latest': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
      'gpt-daybreak-red-latest': { input: 12.5, cacheRead: 1.25, cacheWrite: 15.625, output: 75 },
      'gpt-realtime-2.1': { input: 4, cacheRead: 0.4, cacheWrite: 0, output: 24 },
      'o1': { input: 15, cacheRead: 7.5, cacheWrite: 0, output: 60 },
      'o1-pro': { input: 150, cacheRead: 0, cacheWrite: 0, output: 600 },
      'o3': { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 },
      'o3-mini': { input: 1.1, cacheRead: 0.55, cacheWrite: 0, output: 4.4 },
      'o3-pro': { input: 20, cacheRead: 0, cacheWrite: 0, output: 80 },
      'o4-mini': { input: 1.1, cacheRead: 0.275, cacheWrite: 0, output: 4.4 },
    };
    /** Route whose rates price a model the table does not name. */
    const DEFAULT_FALLBACK_MODEL = 'deepseek-flash';
    /** Off-peak multiplier published alongside the DeepSeek peak rates. */
    const OFF_PEAK_FACTOR = 0.5;
    /**
     * Peak windows as [startHour, endHour) in UTC, Monday through Friday:
     * 01:00-04:00 and 06:00-10:00 UTC, DeepSeek's published Chinese business
     * hours. Every other hour, and both weekend days, is off-peak. Chinese
     * public holidays are not modeled; on those days this estimate charges
     * the peak rate where the provider charges off-peak.
     */
    const PEAK_WINDOWS = [[1, 4], [6, 10]];

    /** English copy; the zh dictionary mirrors its key set. */
    const en = {
      'cost.title': 'Est. session cost',
      'cost.amount': '≈ {amount}',
      'cost.estimateTag': 'est.',
      'cost.open': 'Open cost breakdown and refresh',
      'cost.panelTitle': 'Estimated session cost',
      'cost.close': 'Close',
      'cost.refresh': 'Refresh',
      'cost.refreshing': 'Refreshing…',
      'cost.refreshFailed': 'Refresh failed; showing the last reading.',
      'cost.approxNote': 'Approximate estimate, not a bill',
      'cost.note': "Estimated from the whole session's recorded token usage at the last recorded model's published rates. Cache reads and writes use that model's own rates; DeepSeek peak/off-peak pricing applies only to DeepSeek models. Per-model splits and long-context price tiers are not modeled.",
      'cost.tokens': 'Tokens',
      'cost.cost': 'Cost',
      'cost.bucket.input': 'Uncached input',
      'cost.bucket.cacheRead': 'Cache read',
      'cost.bucket.cacheWrite': 'Cache write',
      'cost.bucket.output': 'Output',
      'cost.model': 'Priced at {model}',
      'cost.peak': 'Peak rate',
      'cost.offPeak': 'Off-peak rate',
      'cost.unknownModel': 'No published price for {model}; priced at {fallback} rates.',
      'cost.fallbackModel': 'No recorded model; priced at {fallback} rates.',
    };
    /** Simplified Chinese copy, key-identical to English. */
    const zh = {
      'cost.title': '预估会话费用',
      'cost.amount': '≈ {amount}',
      'cost.estimateTag': '预估',
      'cost.open': '打开费用明细并刷新',
      'cost.panelTitle': '预估会话费用',
      'cost.close': '关闭',
      'cost.refresh': '刷新',
      'cost.refreshing': '刷新中…',
      'cost.refreshFailed': '刷新失败，仍显示上次读数。',
      'cost.approxNote': '仅为估算，并非账单',
      'cost.note': '按整段会话已记录的 token 用量与最近记录的模型公开价格估算。缓存读取与写入按该模型自身的价格计算；高峰/非高峰价格仅适用于 DeepSeek 模型。未建模逐模型拆分与长上下文阶梯价格。',
      'cost.tokens': 'Token',
      'cost.cost': '费用',
      'cost.bucket.input': '未缓存输入',
      'cost.bucket.cacheRead': '缓存读取',
      'cost.bucket.cacheWrite': '缓存写入',
      'cost.bucket.output': '输出',
      'cost.model': '按 {model} 计价',
      'cost.peak': '高峰价格',
      'cost.offPeak': '非高峰价格',
      'cost.unknownModel': '{model} 没有公开价格，按 {fallback} 价格计算。',
      'cost.fallbackModel': '没有已记录的模型，按 {fallback} 价格计算。',
    };
    /** Fallback copy for a run without the locale service. */
    const FALLBACK = en;

    /** Component-local sheet; unmounting the pill removes it with the component. */
    const CSS = `
.tc-stat{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex;position:relative}
.tc-stat-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm,6px);max-width:100%;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer;transition:background-color .12s ease}
.tc-stat-pill:hover{background:var(--dsw-alias-bg-layer-2)}
.tc-stat-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tc-stat-pill svg{flex:none;width:14px;height:14px}
.tc-stat-amount{text-overflow:ellipsis;min-width:0;overflow:hidden}
.tc-stat-tag{flex:none;font-size:10px;line-height:14px;padding:0 3px;border:.5px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));border-radius:4px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.tc-panel{position:fixed;z-index:2147483000;box-sizing:border-box;width:min(300px,calc(100vw - 16px));max-height:min(70vh,420px);overflow:auto;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 30px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;text-align:left}
.tc-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tc-panel-title{font-weight:600;font-size:12px;line-height:18px}
.tc-tab-switch{display:flex;gap:4px;background:var(--dsw-alias-bg-layer-2);padding:2px;border-radius:6px}
.tc-tab-switch button{border:none;background:0 0;padding:2px 8px;border-radius:4px;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.tc-tab-switch button.active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.tc-panel-close{border:none;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:16px;line-height:1;padding:2px 4px;border-radius:4px}
.tc-panel-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.tc-panel-total{font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.01em;font-variant-numeric:tabular-nums;margin:2px 0 2px}
.tc-panel-model{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.tc-panel-warning{color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:15px;margin:2px 0 0;overflow-wrap:anywhere}
.tc-panel-rows{margin:8px 0 2px}
.tc-panel-row{display:flex;align-items:baseline;gap:8px;padding:1px 0}
.tc-panel-row-head{padding-bottom:3px}
.tc-panel-row-label{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tc-panel-row-head .tc-panel-row-label{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10px;line-height:14px}
.tc-panel-row-tokens{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11px}
.tc-panel-row-cost{min-width:62px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11px}
.tc-panel-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.tc-refresh{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font:inherit;line-height:16px;cursor:pointer}
.tc-refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.tc-refresh:disabled{opacity:.6;cursor:default}
.tc-refresh svg{width:12px;height:12px}
.tc-panel-note{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;margin-top:8px}
.tc-panel-error{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:15px;margin-top:8px}
`;

    /**
     * Resolve the display translator delivered by the slot's `locale` option.
     * @param t - translator, if the slot supplied one.
     * @returns a translation function that falls back to English copy.
     */
    function translator(t) {
      if (typeof t === 'function') return t;
      return (key, params) => {
        const value = FALLBACK[key] ?? key;
        return params === undefined
          ? value
          : value.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
      };
    }

    /**
     * Whether one recorded attempt billed at the peak rate.
     * @param time - event time in epoch milliseconds.
     * @returns true inside a published peak window on a weekday.
     */
    function isPeak(time) {
      const date = new Date(time);
      const day = date.getUTCDay();
      if (day === 0 || day === 6) return false;
      const hour = date.getUTCHours();
      return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end);
    }

    /**
     * Reduce a recorded model id to the catalog key it may extend.
     *
     * Provider routes are commonly written as `provider/model` or
     * `provider:model`; catalog entries gain date or build suffixes, and
     * gateways append variants such as `:free`. The returned id keeps any
     * suffix that is part of the model name and drops the routing parts.
     * @param model - model id from the session's recorded model selection.
     * @returns the lowercase id without a provider prefix or route variant.
     */
    function normalizeModelId(model) {
      const raw = typeof model === 'string' ? model.trim().toLowerCase() : '';
      if (raw === '') return '';
      const slash = raw.lastIndexOf('/');
      const id = slash >= 0 ? raw.slice(slash + 1) : raw;
      const colon = id.lastIndexOf(':');
      if (colon < 0) return id;
      const withoutVariant = id.slice(0, colon);
      const variant = id.slice(colon + 1);
      if (matchRateId(withoutVariant) !== undefined) return withoutVariant;
      if (matchRateId(variant) !== undefined) return variant;
      return id;
    }

    /**
     * Find the rate row for one normalized id, preferring an exact key and
     * then the longest key the id extends across a version separator.
     * @param id - normalized model id.
     * @returns the matching rate key, or undefined.
     */
    function matchRateId(id) {
      if (Object.prototype.hasOwnProperty.call(RATES, id)) return id;
      let best;
      for (const key of Object.keys(RATES)) {
        if (id.length <= key.length || !id.startsWith(key)) continue;
        const separator = id.charAt(key.length);
        if (separator !== '-' && separator !== '@' && separator !== '.') continue;
        if (best === undefined || key.length > best.length) best = key;
      }
      return best;
    }

    /**
     * Choose the rate row that approximates a model the table does not name.
     * The family name narrows the fallback before the provider default, so an
     * unlisted Opus does not inherit Sonnet rates.
     * @param model - normalized model id.
     * @param provider - recorded provider route.
     * @returns a key that exists in {@link RATES}.
     */
    function fallbackFor(model, provider) {
      const haystack = `${provider} ${model}`.toLowerCase();
      if (haystack.includes('anthropic') || haystack.includes('claude')) {
        if (haystack.includes('opus')) return 'claude-opus-5-5';
        if (haystack.includes('haiku')) return 'claude-haiku-5-5';
        return 'claude-sonnet-5-5';
      }
      if (haystack.includes('google') || haystack.includes('gemini') || haystack.includes('vertex')) {
        if (haystack.includes('lite')) return 'gemini-3.5-flash-lite';
        if (haystack.includes('flash')) return 'gemini-3.5-flash';
        return 'gemini-4-argon';
      }
      if (haystack.includes('openai') || haystack.includes('gpt') || /(^|\s)o[1-4]/.test(haystack)) {
        if (haystack.includes('luna')) return 'gpt-5.6-luna';
        if (haystack.includes('terra')) return 'gpt-6.1-terra';
        if (haystack.includes('nano')) return 'gpt-5.4-nano';
        if (haystack.includes('mini')) return 'gpt-5.4-mini';
        if (haystack.includes('pro')) return 'gpt-5.5-pro';
        return 'gpt-6.1-sol';
      }
      return DEFAULT_FALLBACK_MODEL;
    }

    /**
     * Resolve published rates for one recorded model and provider.
     * @param model - model id from the session's recorded model selection.
     * @param provider - provider route from the same selection.
     * @returns the rate row, whether the fallback priced it, and the fallback key.
     */
    function ratesFor(model, provider) {
      const id = normalizeModelId(model);
      const matched = matchRateId(id);
      if (matched !== undefined) return { rates: RATES[matched], fallback: false, fallbackId: matched };
      const fallbackId = fallbackFor(id, provider);
      return { rates: RATES[fallbackId], fallback: true, fallbackId };
    }

    /**
     * Read a non-negative token bucket.
     * @param value - projected bucket value.
     * @returns the count, or zero when the projection omits it.
     */
    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    /**
     * Aggregates token usage from the chat nodes.
     * @param nodes - nodes from the chat snapshot.
     * @returns A map of usage per model.
     */
    function estimateUsage(nodes) {
      const usage = {};
      for (const node of nodes) {
        if (node.kind !== 'turn-tail' || !node.data.tokenUsage) continue;
        const u = node.data.tokenUsage;
        const route = u.routes?.[0];
        const model = route ? route.model : 'unknown';
        const provider = route ? route.provider : 'unknown';
        const key = `${provider}/${model}`;
        if (!usage[key]) usage[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        usage[key].input += u.uncachedInputTokens || 0;
        usage[key].output += u.outputTokens || 0;
        usage[key].cacheRead += u.cacheReadTokens || 0;
        usage[key].cacheWrite += u.cacheWriteTokens || 0;
      }
      return usage;
    }

    /**
     * Price the four whole-session token buckets of the `tokenUsage` projection.
     *
     * Each bucket uses its own published rate: cache reads are not input and
     * cache writes are not always billed at the input rate. Only DeepSeek rows
     * carry the peak/off-peak factor. The projection aggregates the whole log
     * and carries no per-attempt timestamp, so the caller supplies one
     * peak/off-peak decision for every DeepSeek bucket.
     * @param usage - the session's `tokenUsage` projection value.
     * @param model - recorded model id, when the Client can read it.
     * @param provider - recorded provider route, when the Client can read it.
     * @param referenceTime - epoch milliseconds used for the peak decision.
     * @returns the priced estimate with per-bucket costs, or null when the
     * session recorded no usage.
     */
    function sessionCost(usage, model, provider, referenceTime) {
      if (usage === undefined || usage === null) return null;
      const cacheRead = count(usage.cacheReadTokens);
      const input = count(usage.uncachedInputTokens);
      const cacheWrite = count(usage.cacheWriteTokens);
      const output = count(usage.outputTokens);
      if (cacheRead + input + cacheWrite + output <= 0) return null;
      const { rates, fallback, fallbackId } = ratesFor(model, provider);
      const peakPriced = rates.peak === true;
      const peak = peakPriced && isPeak(referenceTime);
      const factor = peakPriced && !peak ? OFF_PEAK_FACTOR : 1;
      const raw = {
        input: input * rates.input / 1e6,
        cacheRead: cacheRead * rates.cacheRead / 1e6,
        cacheWrite: cacheWrite * rates.cacheWrite / 1e6,
        output: output * rates.output / 1e6,
      };
      const tokenCounts = { input, cacheRead, cacheWrite, output };
      const buckets = Object.keys(raw).map((key) => ({
        key,
        tokens: tokenCounts[key],
        usd: raw[key] * factor,
      }));
      const unknownModel = fallback && typeof model === 'string' && model.trim() !== '' ? model : undefined;
      return {
        usd: (raw.input + raw.cacheRead + raw.cacheWrite + raw.output) * factor,
        buckets,
        fallback,
        peak,
        peakPriced,
        unknownModel,
        fallbackId,
        modelId: fallbackId,
      };
    }

    /**
     * Resolve the model and provider that served the session's recorded usage.
     *
     * `lastUsed` is the route of the latest recorded request, so it prices the
     * tokens actually billed. `next` may name a model the user just selected
     * but has not called yet; it is used only before any request is recorded.
     * @param selection - `modelSelection` projection value, when loaded.
     * @returns the recorded route, or undefined when absent.
     */
    function resolveRoute(selection) {
      if (selection === undefined || selection === null) return undefined;
      const chosen = selection.lastUsed ?? selection.next;
      if (chosen === undefined || chosen === null) return undefined;
      const provider = typeof chosen.provider === 'string' ? chosen.provider : '';
      const model = typeof chosen.model === 'string' ? chosen.model : '';
      return provider === '' && model === '' ? undefined : { provider, model };
    }

    /**
     * Format USD keeping meaningful digits on small amounts instead of
     * rounding an estimate to $0.00.
     * @param usd - cost in USD.
     * @returns the display amount without a leading approximation sign.
     */
    function money(usd) {
      if (!(usd > 0)) return '$0.00';
      if (usd >= 1) return `$${usd.toFixed(2)}`;
      if (usd >= 0.01) return `$${usd.toFixed(3)}`;
      if (usd >= 0.00005) return `$${usd.toFixed(4)}`;
      return '<$0.0001';
    }

    /**
     * Format an exact token count for the breakdown.
     * @param value - token count.
     * @returns grouped decimal digits.
     */
    function tokenCount(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '0';
    }

    /** Small coin glyph; artwork only, painted with the current text color. */
    function CoinIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('circle', { key: 'ring', cx: '8', cy: '8', r: '6.25', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('path', {
          key: 'mark',
          d: 'M8 4.6v6.8M6.6 6.2h2.2a1.5 1.5 0 0 1 0 3H6.6m0 0h2.6',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    /** Small circular-arrow glyph for the refresh action. */
    function RefreshIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', {
          key: 'arrow',
          d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.7M13.2 2.6v3.1H10',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    /**
     * Anchored cost breakdown with an explicit refresh action.
     * @param props - translator, priced estimate, breakdown, anchor ref, and callbacks.
     * @returns the portaled panel.
     */
    function CostPanel(props) {
      const { t, estimate, breakdown, anchor, onClose, onRefresh, refreshing, error } = props;
      const [tab, setTab] = React.useState('total');
      const panelRef = React.useRef(null);
      const [position, setPosition] = React.useState(null);

      React.useLayoutEffect(() => {
        const button = anchor.current;
        if (button === null) return undefined;
        const place = () => {
          const rect = button.getBoundingClientRect();
          const margin = 8;
          const width = Math.min(300, window.innerWidth - margin * 2);
          const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
          const below = rect.top < 340;
          setPosition({
            left,
            top: below ? rect.bottom + margin : rect.top - margin,
            ...(below ? {} : { transform: 'translateY(-100%)' }),
          });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [anchor]);

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        const onPointerDown = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return;
          if (anchor.current !== null && anchor.current.contains(event.target)) return;
          onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [anchor, onClose]);

      if (position === null) return null;

      const warning = estimate.unknownModel !== undefined
        ? t('cost.unknownModel', { model: estimate.unknownModel, fallback: estimate.fallbackId })
        : estimate.fallback
          ? t('cost.fallbackModel', { fallback: estimate.fallbackId })
          : null;
      const rate = estimate.peakPriced
        ? ` · ${estimate.peak ? t('cost.peak') : t('cost.offPeak')}`
        : '';

      const breakdownRows = Object.entries(breakdown).map(([route, u]) => {
        const split = route.indexOf('/');
        const provider = split < 0 ? '' : route.slice(0, split);
        const model = split < 0 ? route : route.slice(split + 1);
        const { rates } = ratesFor(model, provider);
        const usd = (
          u.input * rates.input
          + u.cacheRead * rates.cacheRead
          + u.cacheWrite * rates.cacheWrite
          + u.output * rates.output
        ) / 1e6;
        return h('div', { className: 'tc-panel-row', key: route }, [
          h('span', { className: 'tc-panel-row-label', key: 'label' }, route),
          h('span', { className: 'tc-panel-row-tokens', key: 'tokens' }, tokenCount(u.input + u.output)),
          h('span', { className: 'tc-panel-row-cost', key: 'cost' }, money(usd)),
        ]);
      });

      return createPortal(h('div', {
        ref: panelRef,
        className: 'tc-panel',
        style: position,
        role: 'dialog',
        'aria-label': t('cost.panelTitle'),
      }, [
        h('div', { className: 'tc-panel-head', key: 'head' }, [
          h('span', { className: 'tc-panel-title', key: 'title' }, t('cost.panelTitle')),
          h('div', { className: 'tc-tab-switch', key: 'switch' }, [
            h('button', { onClick: () => setTab('total'), className: tab === 'total' ? 'active' : '' }, 'Total'),
            h('button', { onClick: () => setTab('breakdown'), className: tab === 'breakdown' ? 'active' : '' }, 'Models'),
          ]),
          h('button', {
            type: 'button',
            className: 'tc-panel-close',
            key: 'close',
            onClick: onClose,
            title: t('cost.close'),
            'aria-label': t('cost.close'),
          }, '×'),
        ]),
        tab === 'total' ? [
          h('div', { className: 'tc-panel-total', key: 'total' }, t('cost.amount', { amount: money(estimate.usd) })),
          h('div', { className: 'tc-panel-model', key: 'model' }, `${t('cost.model', { model: estimate.modelId })}${rate}`),
          warning === null ? null : h('div', { className: 'tc-panel-warning', key: 'warning' }, warning),
          h('div', { className: 'tc-panel-rows', key: 'rows' }, [
            h('div', { className: 'tc-panel-row tc-panel-row-head', key: 'head-row' }, [
              h('span', { className: 'tc-panel-row-label', key: 'label' }, ''),
              h('span', { className: 'tc-panel-row-tokens', key: 'tokens' }, t('cost.tokens')),
              h('span', { className: 'tc-panel-row-cost', key: 'cost' }, t('cost.cost')),
            ]),
            ...estimate.buckets.map((bucket) => h('div', { className: 'tc-panel-row', key: bucket.key }, [
              h('span', { className: 'tc-panel-row-label', key: 'label' }, t(`cost.bucket.${bucket.key}`)),
              h('span', { className: 'tc-panel-row-tokens', key: 'tokens' }, tokenCount(bucket.tokens)),
              h('span', { className: 'tc-panel-row-cost', key: 'cost' }, money(bucket.usd)),
            ])),
          ]),
        ] : [
           h('div', { className: 'tc-panel-rows', key: 'rows' }, [
            h('div', { className: 'tc-panel-row tc-panel-row-head', key: 'head-row' }, [
              h('span', { className: 'tc-panel-row-label', key: 'label' }, 'Model'),
              h('span', { className: 'tc-panel-row-tokens', key: 'tokens' }, 'Tokens'),
              h('span', { className: 'tc-panel-row-cost', key: 'cost' }, 'Est. Cost'),
            ]),
            ...breakdownRows,
          ]),
        ],
        h('div', { className: 'tc-panel-footer', key: 'footer' }, [
          h('button', {
            type: 'button',
            className: 'tc-refresh',
            key: 'refresh',
            onClick: onRefresh,
            disabled: refreshing,
          }, [
            h(RefreshIcon, { key: 'icon' }),
            h('span', { key: 'label' }, refreshing ? t('cost.refreshing') : t('cost.refresh')),
          ]),
        ]),
        error === null ? null : h('div', { className: 'tc-panel-error', key: 'error' }, error),
        h('div', { className: 'tc-panel-note', key: 'note' }, t('cost.note')),
      ]), document.body);
    }

    /**
     * Compact reading of the current session's estimated API cost. It renders
     * in the shipped composer statistics row between the activity and usage
     * controls; the shipped controls keep their own cells and dialogs.
     * @param props - session standard props (`useProjection`, `useSessions`,
     * `sessionId`), the locale translator, and the projection refresh callback.
     * @returns the statistics reading, or null while the session has no usage.
     */
    function SessionCostPill(props) {
      const t = translator(props.t);
      const [open, setOpen] = React.useState(false);
      const [refreshing, setRefreshing] = React.useState(false);
      const [refreshError, setRefreshError] = React.useState(null);
      const buttonRef = React.useRef(null);
      const usage = props.useProjection('tokenUsage');
      const selection = props.useProjection('modelSelection');
      const chat = props.useChat((snapshot) => snapshot);
      const updatedAt = props.useSessions((state) => {
        const summary = state.byId[props.sessionId];
        return summary === undefined ? undefined : summary.updatedAt;
      });
      const referenceTime = typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now();
      const route = resolveRoute(selection);
      const estimate = sessionCost(
        usage,
        route === undefined ? undefined : route.model,
        route === undefined ? undefined : route.provider,
        referenceTime,
      );
      const breakdown = React.useMemo(
        () => estimateUsage(Array.from(chat.nodes.values())),
        [chat],
      );
      const close = React.useCallback(() => setOpen(false), []);
      const refresh = React.useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        setRefreshError(null);
        try {
          if (typeof props.refreshProjections === 'function') {
            await props.refreshProjections(props.sessionId);
          }
        } catch {
          setRefreshError(t('cost.refreshFailed'));
        } finally {
          setRefreshing(false);
        }
      }, [props.refreshProjections, props.sessionId, refreshing, t]);
      if (estimate === null) return null;

      const amount = money(estimate.usd);
      const titleParts = [
        t('cost.title'),
        t('cost.open'),
        t('cost.approxNote'),
        estimate.unknownModel !== undefined
          ? t('cost.unknownModel', { model: estimate.unknownModel, fallback: estimate.fallbackId })
          : estimate.fallback
            ? t('cost.fallbackModel', { fallback: estimate.fallbackId })
            : null,
      ].filter((part) => part !== null);
      const title = titleParts.join(' — ');
      return h('span', {
        className: 'tc-stat',
        'data-composer-stat': 'session-cost',
      }, [
        h('style', { key: 'css' }, CSS),
        h('button', {
          type: 'button',
          className: 'tc-stat-pill',
          key: 'pill',
          ref: buttonRef,
          title,
          'aria-label': `${t('cost.title')}: ${t('cost.amount', { amount })}`,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        }, [
          h(CoinIcon, { key: 'icon' }),
          h('span', { className: 'tc-stat-amount', key: 'amount' }, t('cost.amount', { amount })),
          h('span', { className: 'tc-stat-tag', key: 'tag' }, t('cost.estimateTag')),
        ]),
        open ? h(CostPanel, {
          key: 'panel',
          t,
          estimate,
          breakdown,
          anchor: buttonRef,
          onClose: close,
          onRefresh: refresh,
          refreshing,
          error: refreshError,
        }) : null,
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'turn-cost: copy');
        const refreshProjections = (sessionId) => {
          const sessions = ctx.get('sessions');
          return sessions === undefined ? Promise.resolve() : sessions.refreshProjections(sessionId);
        };
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'session-cost',
          order: 0.5,
          locale: NS,
        }, (props) => h(SessionCostPill, { ...props, refreshProjections })));
      },
    };
  },
});
