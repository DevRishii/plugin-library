window.__ModuleLoader__.load({
  id: '@local/fleet-view',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'fleet-view';
    /** Stable implementation identity: the tab type, its body, and its title. */
    const TAB_ID = '@local/fleet-view';
    /** Page kind this type renders; the opener requests it through ctx.sidebarRight. */
    const TAB_KIND = 'fleet';
    /** Projection reads are warmed with bounded concurrency, never all at once. */
    const MAX_CONCURRENT_LOADS = 3;
    /** Hard bound on one tree walk so a pathological lineage cannot freeze the view. */
    const MAX_NODES = 200;

    /**
     * Published DeepSeek API prices, USD per 1,000,000 tokens, at the peak
     * rate. Copied from @local/turn-cost/client.js so both surfaces use one
     * identical price table; keep them in sync. Source:
     * api-docs.deepseek.com/quick_start/pricing, read 2026-11-10.
     */
    const RATES = {
      'deepseek-flash': { hit: 0.006, miss: 0.3, output: 1.2 },
      'deepseek-v4-pro': { hit: 0.044, miss: 1.32, output: 3.96 },
    };
    /** Route whose rates price an id the table does not name. */
    const FALLBACK_MODEL = 'deepseek-flash';
    /** Off-peak multiplier published alongside the peak rates. */
    const OFF_PEAK_FACTOR = 0.5;
    /** Peak windows as [startHour, endHour) in UTC, Monday through Friday. */
    const PEAK_WINDOWS = [[1, 4], [6, 10]];

    /** English copy; the zh dictionary mirrors its key set. */
    const en = {
      'tab.title': 'Fleet view',
      'opener.label': 'Fleet',
      'opener.title': 'Open fleet view',
      'opener.aria': 'Open the fleet view for this session',
      'header.cost': 'Est. swarm cost',
      'header.loading': 'loading',
      'header.partial': 'partial',
      'header.note': 'Approximate, not a bill. The same price table as Session cost is used; the peak or off-peak factor comes from this session’s last recorded activity because usage buckets carry no per-attempt time.',
      'root.label': 'This session',
      'root.tag': 'session',
      'empty.none': 'No subagents yet',
      'node.loading': 'Loading…',
      'node.retry': 'Retry',
      'node.error': 'Could not read this session’s projections',
      'node.migration': 'Migration required',
      'node.cost.title': 'Estimated cost for this node',
      'node.expand': 'Expand {label}',
      'node.collapse': 'Collapse {label}',
      'model.chip': '{model} · think {effort}',
      'model.defaultEffort': 'default',
      'model.title': 'Model: {model} · Thinking reasoning: {effort}',
      'cost.unknownModel': 'No published price for {model}; priced at deepseek-flash rates.',
      'mode.continuable': 'continuable',
      'mode.oneShot': 'one-shot',
      'mode.external': 'external',
      'mode.unknown': 'unknown',
      'status.running': 'running',
      'status.completed': 'completed',
      'status.idle': 'idle',
      'tokens.thousand': '{value}K',
      'tokens.million': '{value}M',
      'tokens.total': '{value} tok',
      'duration.seconds': '{seconds}s',
      'duration.minutes': '{minutes}m {seconds}s',
      'duration.hours': '{hours}h {minutes}m',
      'aria.tree': 'Current session and its subagents',
    };
    /** Simplified Chinese copy, key-identical to English. */
    const zh = {
      'tab.title': '集群视图',
      'opener.label': '集群',
      'opener.title': '打开集群视图',
      'opener.aria': '打开当前会话的集群视图',
      'header.cost': '预估集群总费用',
      'header.loading': '加载中',
      'header.partial': '不完整',
      'header.note': '仅为估算，并非账单。价格表与会话费用一致；由于用量桶没有逐次调用时间，高峰/非高峰系数取自本会话最近一次记录的活动时间。',
      'root.label': '当前会话',
      'root.tag': '会话',
      'empty.none': '还没有子智能体',
      'node.loading': '加载中…',
      'node.retry': '重试',
      'node.error': '无法读取该会话的投影',
      'node.migration': '需要迁移',
      'node.cost.title': '该节点的预估费用',
      'node.expand': '展开 {label}',
      'node.collapse': '收起 {label}',
      'model.chip': '{model} · 思考 {effort}',
      'model.defaultEffort': '默认',
      'model.title': '模型：{model} · 思考强度：{effort}',
      'cost.unknownModel': '{model} 没有公开价格，按 deepseek-flash 价格计算。',
      'mode.continuable': '可继续',
      'mode.oneShot': '一次性',
      'mode.external': '外部任务',
      'mode.unknown': '模式未知',
      'status.running': '运行中',
      'status.completed': '已完成',
      'status.idle': '空闲',
      'tokens.thousand': '{value}K',
      'tokens.million': '{value}M',
      'tokens.total': '{value} tok',
      'duration.seconds': '{seconds}秒',
      'duration.minutes': '{minutes}分{seconds}秒',
      'duration.hours': '{hours}小时{minutes}分',
      'aria.tree': '当前会话及其子智能体',
    };
    /** Fallback copy for a run without the locale service. */
    const FALLBACK = en;

    /**
     * Component-local sheet. Colors come only from --dsw-alias-* theme tokens;
     * the spinner dot uses the brand accent and opacity, not a literal color.
     */
    const CSS = `
.fv-root{display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.fv-header{flex:none;display:flex;flex-direction:column;gap:4px;padding:14px 16px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.fv-header-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.fv-header-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.fv-total{display:flex;align-items:baseline;gap:8px;color:var(--dsw-alias-label-primary);font-size:18px;line-height:24px;font-weight:600;font-variant-numeric:tabular-nums}
.fv-chip{flex:none;font-size:10px;line-height:14px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.fv-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.fv-tree{flex:1;min-height:0;overflow-y:auto;padding:8px 8px 20px;display:flex;flex-direction:column;gap:2px}
.fv-node{box-sizing:border-box;display:flex;align-items:center;gap:6px;min-width:0;min-height:26px;padding:2px 8px 2px 2px;border-radius:var(--dsw-radius-sm,6px)}
@media (hover:hover){.fv-node:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.fv-node-root{font-weight:500}
.fv-disclosure{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:3px}
.fv-disclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fv-space{flex:none;width:14px;height:14px}
.fv-chevron{width:14px;height:14px;transition:transform .12s}
.fv-chevron-open{transform:rotate(90deg)}
.fv-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.fv-dot-running{background:var(--dsw-alias-brand-primary);animation:fv-pulse 1.4s ease-in-out infinite}
.fv-dot-completed{background:var(--dsw-alias-state-success-primary)}
.fv-dot-external{background:transparent;border:1px solid var(--dsw-alias-label-tertiary)}
@keyframes fv-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.fv-dot-running{animation:none}}
.fv-body{display:flex;flex-direction:column;min-width:0;flex:1}
.fv-label{color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fv-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.fv-cost{flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.fv-model{flex:none;display:inline-flex;align-items:center;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:14px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.fv-note-row{display:flex;align-items:center;gap:8px;padding:2px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.fv-error-row{color:var(--dsw-alias-state-error-primary)}
.fv-retry{flex:none;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.fv-retry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fv-empty{display:flex;flex-direction:column;align-items:center;gap:8px;margin:auto;padding:24px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.fv-empty svg{flex:none;width:22px;height:22px;color:var(--dsw-alias-label-tertiary)}
.fv-opener{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
@media (hover:hover){.fv-opener:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.fv-opener:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fv-opener svg{flex:none;width:16px;height:16px}
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
     * Whether a recorded time falls inside a published peak window on a weekday.
     * @param time - epoch milliseconds.
     * @returns true inside 01:00-04:00 or 06:00-10:00 UTC, Monday through Friday.
     */
    function isPeak(time) {
      const date = new Date(time);
      const day = date.getUTCDay();
      if (day === 0 || day === 6) return false;
      const hour = date.getUTCHours();
      return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end);
    }

    /**
     * Resolve published rates for one recorded model id.
     * @param model - model id from a session's model-selection projection.
     * @returns the rate row and whether the fallback priced it.
     */
    function ratesFor(model) {
      const id = typeof model === 'string' ? model.trim().toLowerCase() : '';
      return Object.prototype.hasOwnProperty.call(RATES, id)
        ? { rates: RATES[id], fallback: false }
        : { rates: RATES[FALLBACK_MODEL], fallback: true };
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
     * Price the four token buckets of one `tokenUsage` projection value.
     * @param usage - projected token usage.
     * @param model - recorded model id, when readable.
     * @param peak - whether the shared peak factor applies.
     * @returns USD cost, or null while the projection itself is unavailable.
     */
    function usageCost(usage, model, peak) {
      if (usage === undefined || usage === null) return null;
      const cacheRead = count(usage.cacheReadTokens);
      const input = count(usage.uncachedInputTokens);
      const cacheWrite = count(usage.cacheWriteTokens);
      const output = count(usage.outputTokens);
      const { rates, fallback } = ratesFor(model);
      const raw = (cacheRead * rates.hit + (input + cacheWrite) * rates.miss + output * rates.output) / 1e6;
      const unknownModel = fallback && typeof model === 'string' && model.trim() !== '' ? model : undefined;
      return { usd: raw * (peak ? 1 : OFF_PEAK_FACTOR), fallback, unknownModel };
    }

    /**
     * Sum the four disjoint durable provider-usage buckets.
     * @param usage - projected token usage, if loaded.
     * @returns the token total, or undefined while the projection is absent.
     */
    function tokenTotal(usage) {
      if (usage === undefined || usage === null) return undefined;
      return count(usage.uncachedInputTokens) + count(usage.outputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens);
    }

    /**
     * Resolve the model id and reasoning effort recorded by a session's
     * model-selection projection. `next` is the pending selection and already
     * falls back to `lastUsed` in the published wire value, so either arms are
     * safe to read.
     * @param selection - `modelSelection` projection value, when loaded.
     * @returns `{ model, effort }`; both undefined when nothing is recorded.
     */
    function describeSelection(selection) {
      if (selection === undefined || selection === null) return { model: undefined, effort: undefined };
      const chosen = selection.next ?? selection.lastUsed;
      if (chosen === undefined || chosen === null) return { model: undefined, effort: undefined };
      return {
        model: typeof chosen.model === 'string' && chosen.model.trim() !== '' ? chosen.model : undefined,
        effort: typeof chosen.reasoningEffort === 'string' && chosen.reasoningEffort.trim() !== '' ? chosen.reasoningEffort : undefined,
      };
    }

    /**
     * Short product label for one recorded model id. Recognizes the two
     * published DeepSeek routes and otherwise shows the raw id rather than
     * guessing.
     * @param model - recorded model id.
     * @returns Flash, Pro, or the model id itself.
     */
    function shortModel(model) {
      const id = typeof model === 'string' ? model.trim().toLowerCase() : '';
      if (id.includes('flash')) return 'Flash';
      if (id.includes('pro')) return 'Pro';
      return model;
    }

    /**
     * Whole seconds of active-turn duration for one catalog row.
     * @param timing - `subagentTiming` projection value, if loaded.
     * @param running - unified running state for that Session.
     * @param now - current epoch milliseconds.
     * @returns duration in milliseconds, or undefined while timing is absent.
     */
    function activityDuration(timing, running, now) {
      if (timing === undefined || timing === null) return undefined;
      const settled = typeof timing.settledMs === 'number' && Number.isFinite(timing.settledMs) ? timing.settledMs : 0;
      if (timing.active === undefined || timing.active === null) return settled;
      const end = running ? now : timing.active.through;
      return settled + Math.max(0, end - timing.active.since);
    }

    /**
     * Format USD keeping meaningful digits on small amounts instead of
     * rounding an estimate to $0.00. Identical to the Shared Session-cost
     * helper in @local/turn-cost/client.js.
     * @param usd - cost in USD.
     * @returns the display amount.
     */
    function money(usd) {
      if (!(usd > 0)) return '$0.00';
      if (usd >= 1) return `$${usd.toFixed(2)}`;
      if (usd >= 0.01) return `$${usd.toFixed(3)}`;
      if (usd >= 0.00005) return `$${usd.toFixed(4)}`;
      return '<$0.0001';
    }

    /**
     * Compact token count shared in shape with the shipped conversation stats.
     * @param value - token count.
     * @param t - translator.
     * @returns the display string.
     */
    function formatTokens(value, t) {
      const scaled = (next) => (next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10));
      if (value < 1e3) return String(value);
      if (value < 1e6) return t('tokens.thousand', { value: scaled(value / 1e3) });
      return t('tokens.million', { value: scaled(value / 1e6) });
    }

    /**
     * Format an active-turn duration with decreasing precision at larger scales.
     * @param ms - duration in milliseconds.
     * @param t - translator.
     * @returns the display string.
     */
    function formatDuration(ms, t) {
      const totalSeconds = Math.floor(Math.max(0, ms) / 1e3);
      if (totalSeconds < 60) return t('duration.seconds', { seconds: totalSeconds });
      const totalMinutes = Math.floor(totalSeconds / 60);
      if (totalMinutes < 60) {
        return t('duration.minutes', { minutes: totalMinutes, seconds: String(totalSeconds % 60).padStart(2, '0') });
      }
      const hours = Math.floor(totalMinutes / 60);
      return t('duration.hours', { hours, minutes: String(totalMinutes % 60).padStart(2, '0') });
    }

    /**
     * Short error text for a failed projection read.
     * @param error - caught value.
     * @returns a user-facing message.
     */
    function messageOf(error) {
      if (error !== undefined && error !== null && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    /**
     * First defined argument; projection values may legitimately be null (a
     * cleared identity), so undefined alone selects the fallback source.
     * @param values - candidate projection values.
     * @returns the first non-undefined value.
     */
    function firstDefined(...values) {
      for (const value of values) if (value !== undefined) return value;
      return undefined;
    }

    /** Network glyph used both in the header opener and the empty state. */
    function FleetIcon() {
      return h('svg', { viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' }, [
        h('circle', { key: 'root', cx: '10', cy: '4.5', r: '2.1', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('circle', { key: 'left', cx: '4.5', cy: '15.5', r: '2.1', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('circle', { key: 'right', cx: '15.5', cy: '15.5', r: '2.1', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('path', {
          key: 'edges',
          d: 'M8.7 6.3 5.8 13.3M11.3 6.3l2.9 7',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
        }),
      ]);
    }

    /** Disclosure chevron; rotates when its branch is expanded. */
    function Chevron({ open }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        className: open ? 'fv-chevron fv-chevron-open' : 'fv-chevron',
        fill: 'none',
        'aria-hidden': 'true',
      }, h('path', {
        d: 'M6 4l4 4-4 4',
        stroke: 'currentColor',
        strokeWidth: '1.5',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }));
    }

    /** One status dot; `state` is running, completed, idle, or external. */
    function StatusDot({ state }) {
      return h('span', { className: `fv-dot fv-dot-${state}`, 'aria-hidden': 'true' });
    }

    /**
     * Translate one catalog mode.
     * @param entry - catalog entry, if this row has one.
     * @param t - translator.
     * @returns the mode label.
     */
    function modeLabel(entry, t) {
      if (entry === undefined) return t('root.tag');
      if (entry.mode === 'external') return t('mode.external');
      if (entry.mode === 'one-shot') return t('mode.oneShot');
      if (entry.mode === 'continuable') return t('mode.continuable');
      return t('mode.unknown');
    }

    /**
     * Whether a catalog level is still being read, so a nested load notice is
     * shown only while that is genuinely the state.
     * @param projection - that Session's projection snapshot, if any.
     * @param catalog - catalog value already available from the projection or hints.
     * @param failed - ids whose warm read failed.
     * @param requested - ids already requested (cache).
     * @returns ready, loading, idle, error, migration, or leaf.
     */
    function catalogStateOf(projection, catalog, id, failed, requested) {
      if (catalog !== undefined) return 'ready';
      if (projection !== undefined) {
        if (projection.state === 'error') return 'error';
        if (projection.state === 'migration-required') return 'migration';
        if (projection.state === 'loading') return 'loading';
        return 'ready';
      }
      if (failed.has(id)) return 'error';
      if (requested.has(id)) return 'loading';
      return 'idle';
    }

    /**
     * The current session and its whole subagent tree as a live node tree.
     * Rows come from the parent-owned `subagentCatalog` projections; token,
     * duration, and cost readings come from each Session's projections and
     * update from live projection frames. Cold descendant projection reads are
     * warmed level by level with bounded concurrency.
     * @param props - Session standard props, the locale translator, the tab
     * hook context, and the injected projection refresher.
     * @returns the fleet tab body.
     */
    function FleetTabBody(props) {
      const t = translator(props.t);
      const rootId = props.sessionId;
      const useSessions = props.useSessions;
      const useSessionStatus = props.useSessionStatus;
      const useProjection = props.useProjection;
      const useTabInfo = props.useTabInfo;
      const refreshProjections = props.refreshProjections;

      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : undefined;
      const tab = tabInfo === undefined ? undefined : tabInfo.tab;

      const projections = useSessions((state) => state.projectionsBySession);
      const summaries = useSessions((state) => state.byId);
      const statuses = useSessionStatus((value) => value);
      const rootUsage = useProjection('tokenUsage');
      const rootSelection = useProjection('modelSelection');

      const [now, setNow] = React.useState(() => Date.now());
      const [collapsed, setCollapsed] = React.useState(() => new Set());
      const [revision, setRevision] = React.useState(0);
      const mountedRef = React.useRef(true);
      const requestedRef = React.useRef(new Set());
      const failedRef = React.useRef(new Map());
      const inFlightRef = React.useRef(new Set());

      React.useEffect(() => () => {
        mountedRef.current = false;
      }, []);

      /**
       * Collect every reachable local Session id from the catalogs currently
       * loaded, so the warm-up queue follows discovered membership rather than
       * a blind depth walk.
       * @returns ids in parent-before-child breadth order.
       */
      const discoverIds = () => {
        const ids = [];
        const seen = new Set();
        const visit = (id) => {
          if (id === undefined || id === null || seen.has(id) || ids.length >= MAX_NODES) return;
          seen.add(id);
          ids.push(id);
          const values = projections[id] === undefined ? undefined : projections[id].values;
          const hint = summaries[id] === undefined ? undefined : summaries[id].projectionValues;
          const catalog = values === undefined || values.subagentCatalog === undefined ? hint === undefined ? undefined : hint.subagentCatalog : values.subagentCatalog;
          if (catalog === undefined) return;
          for (const child of catalog) if (child.mode !== 'external') visit(child.id);
        };
        visit(rootId);
        return ids;
      };

      React.useEffect(() => {
        if (typeof refreshProjections !== 'function') return;
        if (tab !== undefined && tab.visible === false) return;
        const rootProjection = projections[rootId];
        for (const id of discoverIds()) {
          if (requestedRef.current.has(id)) continue;
          // The viewed Session's projection store is already live through its
          // own binding; do not re-seed it with a cold read. A failed read is
          // still retried, because the store keeps its error state.
          if (id === rootId && rootProjection !== undefined && rootProjection.state !== 'error') continue;
          if (inFlightRef.current.size >= MAX_CONCURRENT_LOADS) break;
          requestedRef.current.add(id);
          inFlightRef.current.add(id);
          Promise.resolve()
            .then(() => refreshProjections(id))
            .catch((error) => {
              failedRef.current.set(id, messageOf(error));
            })
            .finally(() => {
              inFlightRef.current.delete(id);
              if (mountedRef.current) setRevision((value) => value + 1);
            });
        }
      }, [projections, summaries, revision, refreshProjections, rootId, tab]);

      const rootSummary = summaries[rootId];
      const rootUpdatedAt = rootSummary === undefined ? undefined : rootSummary.updatedAt;
      const referenceTime = typeof rootUpdatedAt === 'number' && Number.isFinite(rootUpdatedAt) && rootUpdatedAt > 0 ? rootUpdatedAt : Date.now();
      const peak = isPeak(referenceTime);

      const retry = (id) => {
        failedRef.current.delete(id);
        requestedRef.current.delete(id);
        setRevision((value) => value + 1);
      };
      const toggle = (id) => {
        setCollapsed((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const tree = {
        rows: [],
        total: 0,
        unknown: 0,
        pending: 0,
        failed: 0,
        running: 0,
        nodes: 0,
      };

      /**
       * Walk one node, accumulate swarm totals for every discovered descendant
       * (including branches hidden by a collapsed parent), and push the visible
       * rows in document order.
       * @param id - Session id of this node.
       * @param depth - indentation depth (root is 0).
       * @param entry - catalog entry that discovered the node, if any.
       * @param isRoot - whether this is the viewed Session.
       * @param visible - whether ancestors are expanded.
       */
      const walk = (id, depth, entry, isRoot, visible) => {
        if (id === undefined || id === null || tree.nodes >= MAX_NODES) return;
        if (seenIds.has(id)) return;
        seenIds.add(id);
        tree.nodes += 1;

        const summary = summaries[id];
        const projection = projections[id];
        const values = projection === undefined ? undefined : projection.values;
        const hint = summary === undefined ? undefined : summary.projectionValues;
        const external = entry !== undefined && entry.mode === 'external';
        const usage = isRoot
          ? firstDefined(rootUsage, values === undefined ? undefined : values.tokenUsage, hint === undefined ? undefined : hint.tokenUsage)
          : firstDefined(values === undefined ? undefined : values.tokenUsage, hint === undefined ? undefined : hint.tokenUsage);
        const selection = isRoot
          ? firstDefined(rootSelection, values === undefined ? undefined : values.modelSelection)
          : values === undefined ? undefined : values.modelSelection;
        const timing = firstDefined(values === undefined ? undefined : values.subagentTiming, hint === undefined ? undefined : hint.subagentTiming);
        const unifiedRunning = statuses !== undefined && typeof statuses.get === 'function' ? statuses.get(id) : undefined;
        const running = Boolean(
          unifiedRunning === undefined || unifiedRunning === null
            ? summary === undefined ? undefined : summary.running
            : unifiedRunning.running,
        );
        const selectionInfo = describeSelection(selection);
        const cost = external ? null : usageCost(usage, selectionInfo.model, peak);
        const tokenCount = tokenTotal(usage);
        const duration = isRoot ? undefined : activityDuration(timing, running, now);
        const completed = !external && !running && timing !== undefined && timing !== null && timing.lastTurnCompleted === true;
        const status = external ? 'external' : running ? 'running' : completed ? 'completed' : 'idle';

        if (cost !== null) tree.total += cost.usd;
        else if (!external) tree.unknown += 1;
        if (running) tree.running += 1;

        const label = isRoot
          ? summary !== undefined && typeof summary.displayTitle === 'string' && summary.displayTitle !== '' ? summary.displayTitle : summary !== undefined && typeof summary.title === 'string' && summary.title !== '' ? summary.title : t('root.label')
          : summary !== undefined && typeof summary.title === 'string' && summary.title !== '' ? summary.title : entry !== undefined && typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry !== undefined ? entry.id : id;

        const catalogValue = external ? undefined : firstDefined(values === undefined ? undefined : values.subagentCatalog, hint === undefined ? undefined : hint.subagentCatalog);
        const branchState = external ? 'leaf' : catalogStateOf(projection, catalogValue, id, failedRef.current, requestedRef.current);
        if (branchState === 'error' || branchState === 'migration') tree.failed += 1;
        else if (branchState === 'loading' || branchState === 'idle') tree.pending += 1;
        const expanded = !collapsed.has(id);
        const canCollapse = branchState === 'ready' && catalogValue !== undefined && catalogValue.length > 0;

        if (visible) {
          const meta = [modeLabel(entry, t)];
          if (tokenCount !== undefined) meta.push(t('tokens.total', { value: formatTokens(tokenCount, t) }));
          if (duration !== undefined) meta.push(formatDuration(duration, t));
          const costText = cost === null ? '—' : `≈ ${money(cost.usd)}`;
          const costTitle = cost === null
            ? undefined
            : `${t('node.cost.title')}: ${costText}${cost.unknownModel === undefined ? '' : ` (${t('cost.unknownModel', { model: cost.unknownModel })})`}`;
          const effortLabel = selectionInfo.effort ?? t('model.defaultEffort');
          const modelChip = selectionInfo.model === undefined ? null : h('span', {
            key: 'model',
            className: 'fv-model',
            title: t('model.title', { model: selectionInfo.model, effort: effortLabel }),
          }, t('model.chip', { model: shortModel(selectionInfo.model), effort: effortLabel }));
          tree.rows.push(h('div', {
            key: `node:${id}`,
            className: isRoot ? 'fv-node fv-node-root' : 'fv-node',
            style: { paddingLeft: `${2 + depth * 14}px` },
            'data-fleet-node': id,
            role: 'treeitem',
            'aria-level': depth + 1,
            ...canCollapse ? { 'aria-expanded': expanded } : {},
          }, [
            canCollapse
              ? h('button', {
                key: 'disclosure',
                type: 'button',
                className: 'fv-disclosure',
                onClick: () => toggle(id),
                'aria-label': t(expanded ? 'node.collapse' : 'node.expand', { label }),
              }, h(Chevron, { open: expanded }))
              : h('span', { key: 'disclosure', className: 'fv-space' }),
            h(StatusDot, { key: 'dot', state: status }),
            h('span', { key: 'body', className: 'fv-body' }, [
              h('span', { key: 'label', className: 'fv-label', title: label }, label),
              h('span', { key: 'meta', className: 'fv-meta' }, meta.join(' · ')),
            ]),
            modelChip,
            h('span', { key: 'cost', className: 'fv-cost', title: costTitle }, costText),
          ]));

          if (!external && (branchState === 'loading' || branchState === 'idle')) {
            tree.rows.push(h('div', {
              key: `loading:${id}`,
              className: 'fv-note-row',
              style: { paddingLeft: `${2 + (depth + 1) * 14 + 16}px` },
            }, t('node.loading')));
          } else if (!external && (branchState === 'error' || branchState === 'migration')) {
            tree.rows.push(h('div', {
              key: `error:${id}`,
              className: 'fv-note-row fv-error-row',
              style: { paddingLeft: `${2 + (depth + 1) * 14 + 16}px` },
            }, [
              h('span', { key: 'message' }, branchState === 'migration' ? t('node.migration') : t('node.error')),
              h('button', {
                key: 'retry',
                type: 'button',
                className: 'fv-retry',
                onClick: () => retry(id),
              }, t('node.retry')),
            ]));
          }
        }

        if (external) return;
        if (branchState === 'ready' && catalogValue !== undefined) {
          for (const child of catalogValue) walk(child.id, depth + 1, child, false, visible && expanded);
        }
      };

      const seenIds = new Set();
      walk(rootId, 0, undefined, true, true);

      const rootValues = projections[rootId] === undefined ? undefined : projections[rootId].values;
      const rootCatalog = rootValues === undefined || rootValues.subagentCatalog === undefined ? undefined : rootValues.subagentCatalog;
      const emptyTree = rootCatalog !== undefined && rootCatalog.length === 0 && tree.unknown === 0;

      React.useEffect(() => {
        if (tree.running === 0) return;
        const timer = setInterval(() => setNow(Date.now()), 1e3);
        return () => clearInterval(timer);
      }, [tree.running]);

      const chip = tree.pending > 0 ? t('header.loading') : tree.failed > 0 || tree.unknown > 0 ? t('header.partial') : null;
      return h('div', { className: 'fv-root', 'data-fleet-view': 'tab' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'header', className: 'fv-header' }, [
          h('div', { key: 'row', className: 'fv-header-row' }, [
            h('span', { key: 'label', className: 'fv-header-label' }, t('header.cost')),
            h('span', { key: 'total', className: 'fv-total' }, [
              `≈ ${money(tree.total)}`,
              chip === null ? null : h('span', { key: 'chip', className: 'fv-chip' }, chip),
            ]),
          ]),
          h('div', { key: 'note', className: 'fv-note' }, t('header.note')),
        ]),
        h('div', {
          key: 'tree',
          className: 'fv-tree',
          role: 'tree',
          'aria-label': t('aria.tree'),
        }, emptyTree
          ? [tree.rows[0], h('div', { key: 'empty', className: 'fv-empty' }, [
            h(FleetIcon, { key: 'icon' }),
            h('div', { key: 'text' }, t('empty.none')),
          ])]
          : tree.rows),
      ]);
    }

    /**
     * Compact opener in the conversation header actions band. It only opens on
     * an explicit click; nothing is opened on mount, so the saved sidebar
     * layout is never claimed by this plugin.
     * @param props - locale translator plus the injected opener action.
     * @returns the header opener button.
     */
    function FleetOpener(props) {
      const t = translator(props.t);
      const button = h('button', {
        type: 'button',
        className: 'fv-opener',
        title: t('opener.title'),
        'aria-label': t('opener.aria'),
        onClick: () => {
          if (typeof props.openFleet === 'function') props.openFleet();
        },
      }, [
        h(FleetIcon, { key: 'icon' }),
        h('span', { key: 'label' }, t('opener.label')),
      ]);
      return h(React.Fragment, null, [h('style', { key: 'css' }, CSS), button]);
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'fleet-view: copy');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('tab.title'),
        }), 'fleet-view: tab type');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: () => ({
            refreshProjections: (sessionId) => ctx.sessions.refreshProjections(sessionId),
          }),
        }, FleetTabBody)), 'fleet-view: tab body');

        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'fleet-view',
          order: 15,
          locale: NS,
          inject: () => ({
            openFleet: () => {
              try {
                ctx.sidebarRight.openTab(TAB_KIND);
              } catch (error) {
                console.warn('fleet-view: cannot open the fleet tab', error);
              }
            },
          }),
        }, FleetOpener)), 'fleet-view: header opener');
      },
    };
  },
});
