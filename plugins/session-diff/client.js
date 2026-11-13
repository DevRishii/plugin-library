window.__ModuleLoader__.load({
  id: '@local/session-diff',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'session-diff';
    /** Stable implementation identity: the tab type, its body, and its title. */
    const TAB_ID = '@local/session-diff';
    /** Page kind this type renders; the opener requests it through ctx.sidebarRight. */
    const TAB_KIND = 'receipt';
    /** Same-origin Host routes owned by the session-diff plugin. */
    const RECEIPT_ROUTE = '/session-diff/receipt';
    const EXPORT_ROUTE = '/session-diff/export';

    /** English copy; the zh dictionary mirrors its key set. */
    const en = {
      "tab.title": "Receipt",
      "opener.label": "Receipt",
      "opener.title": "Open receipt",
      "opener.aria": "Open the receipt for this session",
      "loading": "Loading receipt…",
      "retry": "Retry",
      "error.load": "Could not load this session's receipt",
      "empty.none": "No receipt recorded for this session yet.",
      "empty.files": "No file changes recorded.",
      "empty.commands": "No commands recorded.",
      "empty.turns": "No turns recorded.",
      "empty.threads": "No open threads.",
      "summary.filesAdded": "Files added",
      "summary.filesModified": "Files modified",
      "summary.filesDeleted": "Files deleted",
      "summary.commands": "Commands",
      "summary.failed": "{count} failed",
      "summary.models": "Models",
      "summary.totalCost": "Total cost",
      "summary.openThreads": "Open threads",
      "files.title": "Files",
      "files.path": "Path",
      "files.status": "Status",
      "files.before": "Before",
      "files.after": "After",
      "commands.title": "Commands",
      "commands.exit": "Exit",
      "commands.tool": "Tool",
      "commands.command": "Command",
      "commands.failure": "First failure",
      "models.title": "Models and cost",
      "models.turn": "Turn",
      "models.model": "Model",
      "models.tokens": "Tokens",
      "models.cost": "Cost",
      "models.turnValue": "#{turn}",
      "threads.title": "Open threads",
      "thread.failingCommand": "Failing command",
      "thread.failedTests": "Failed tests",
      "thread.unfinishedTurn": "Unfinished turn",
      "thread.todo": "Open todo",
      "thread.todoMarker": "Todo marker",
      "thread.other": "Open item",
      "status.added": "Added",
      "status.modified": "Modified",
      "status.deleted": "Deleted",
      "status.other": "Changed",
      "snapshots.label": "Snapshots",
      "snapshots.stats": "{entries} entries · {bytes} bytes",
      "export.label": "Export",
      "export.markdown": "Markdown",
      "export.json": "JSON",
      "export.html": "HTML",
      "export.markdownTitle": "Download the receipt as Markdown",
      "export.jsonTitle": "Download the receipt as JSON",
      "export.htmlTitle": "Download the receipt as HTML",
      "export.failed": "Export failed",
      "cost.amount": "${amount}",
      "value.none": "—"
    };
    /** Simplified Chinese copy, key-identical to English. */
    const zh = {
      "tab.title": "回执",
      "opener.label": "回执",
      "opener.title": "打开回执",
      "opener.aria": "打开当前会话的回执",
      "loading": "正在加载回执…",
      "retry": "重试",
      "error.load": "无法加载该会话的回执",
      "empty.none": "该会话还没有记录回执。",
      "empty.files": "没有文件变更记录。",
      "empty.commands": "没有命令记录。",
      "empty.turns": "没有轮次记录。",
      "empty.threads": "没有未完成事项。",
      "summary.filesAdded": "新增文件",
      "summary.filesModified": "修改文件",
      "summary.filesDeleted": "删除文件",
      "summary.commands": "命令",
      "summary.failed": "{count} 个失败",
      "summary.models": "模型",
      "summary.totalCost": "总费用",
      "summary.openThreads": "未完成事项",
      "files.title": "文件",
      "files.path": "路径",
      "files.status": "状态",
      "files.before": "之前",
      "files.after": "之后",
      "commands.title": "命令",
      "commands.exit": "退出码",
      "commands.tool": "工具",
      "commands.command": "命令",
      "commands.failure": "首个失败行",
      "models.title": "模型与费用",
      "models.turn": "轮次",
      "models.model": "模型",
      "models.tokens": "Tokens",
      "models.cost": "费用",
      "models.turnValue": "#{turn}",
      "threads.title": "未完成事项",
      "thread.failingCommand": "失败命令",
      "thread.failedTests": "测试失败",
      "thread.unfinishedTurn": "未完成轮次",
      "thread.todo": "未完成待办",
      "thread.todoMarker": "待办标记",
      "thread.other": "待处理项",
      "status.added": "新增",
      "status.modified": "修改",
      "status.deleted": "删除",
      "status.other": "变更",
      "snapshots.label": "快照",
      "snapshots.stats": "{entries} 条 · {bytes} 字节",
      "export.label": "导出",
      "export.markdown": "Markdown",
      "export.json": "JSON",
      "export.html": "HTML",
      "export.markdownTitle": "以 Markdown 下载回执",
      "export.jsonTitle": "以 JSON 下载回执",
      "export.htmlTitle": "以 HTML 下载回执",
      "export.failed": "导出失败",
      "cost.amount": "${amount}",
      "value.none": "—"
    };
    /** Fallback copy for a run without the locale service. */
    const FALLBACK = en;

    /** Export formats the Host route renders; the client only hands bytes to the browser. */
    const EXPORTS = [
      {
        format: 'markdown',
        extension: 'md',
        type: 'text/markdown; charset=utf-8',
        accept: 'text/markdown',
        label: (t) => t('export.markdown'),
        title: (t) => t('export.markdownTitle'),
      },
      {
        format: 'json',
        extension: 'json',
        type: 'application/json; charset=utf-8',
        accept: 'application/json',
        label: (t) => t('export.json'),
        title: (t) => t('export.jsonTitle'),
      },
      {
        format: 'html',
        extension: 'html',
        type: 'text/html; charset=utf-8',
        accept: 'text/html',
        label: (t) => t('export.html'),
        title: (t) => t('export.htmlTitle'),
      },
    ];

    /**
     * Component-local sheet. Colors come only from --dsw-alias-* theme tokens.
     */
    const CSS = `
.sd-root{display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.sd-header{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.sd-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:600}
.sd-header-spacer{flex:1}
.sd-exports{display:flex;align-items:center;gap:6px;min-width:0}
.sd-export-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.sd-export{flex:none;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
@media (hover:hover){.sd-export:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.sd-export:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sd-export:disabled{opacity:.55;cursor:default}
.sd-export-failed{flex:none;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.sd-scroll{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 24px;display:flex;flex-direction:column;gap:16px}
.sd-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.sd-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.sd-stat-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-stat-value{color:var(--dsw-alias-label-primary);font-size:15px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-stat-note{color:var(--dsw-alias-state-error-primary);font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.sd-section-title{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}
.sd-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:18px}
.sd-table th{padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:left}
.sd-table td{padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:top;color:var(--dsw-alias-label-primary)}
.sd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px}
.sd-truncate{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-tertiary{color:var(--dsw-alias-label-tertiary)}
.sd-badge{display:inline-block;padding:0 4px;border:.5px solid currentColor;border-radius:4px;font-size:10px;line-height:14px;white-space:nowrap}
.sd-badge-added{color:var(--dsw-alias-state-success-primary)}
.sd-badge-modified{color:var(--dsw-alias-brand-primary)}
.sd-badge-deleted{color:var(--dsw-alias-state-error-primary)}
.sd-badge-other{color:var(--dsw-alias-label-tertiary)}
.sd-badge-kind{color:var(--dsw-alias-label-secondary)}
.sd-exit{font-variant-numeric:tabular-nums}
.sd-exit-failed{color:var(--dsw-alias-state-error-primary)}
.sd-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sd-threads{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.sd-thread{display:flex;flex-direction:column;gap:2px;min-width:0}
.sd-thread-head{display:flex;align-items:center;gap:6px;min-width:0}
.sd-thread-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.sd-thread-detail{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.sd-snapshots{display:flex;align-items:baseline;gap:6px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.sd-snapshots-label{color:var(--dsw-alias-label-secondary);font-weight:500}
.sd-state{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sd-state-error{color:var(--dsw-alias-state-error-primary)}
.sd-retry{padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer}
@media (hover:hover){.sd-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.sd-retry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sd-opener{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
@media (hover:hover){.sd-opener:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.sd-opener:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sd-opener svg{flex:none;width:16px;height:16px}
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
        if (params === undefined) return value;
        return value.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
      };
    }

    /**
     * A plain object, excluding null and arrays.
     * @param value - candidate.
     * @returns whether the value is a record.
     */
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /**
     * A record or an empty object, so property reads never throw.
     * @param value - candidate.
     * @returns the record.
     */
    function asRecord(value) {
      return isRecord(value) ? value : {};
    }

    /**
     * An array or an empty array.
     * @param value - candidate.
     * @returns the array.
     */
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    /**
     * A finite number, or null for a missing or malformed value.
     * @param value - candidate.
     * @returns the number, or null.
     */
    function numberOrNull(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    /**
     * A non-empty string, or null.
     * @param value - candidate.
     * @returns the string, or null.
     */
    function stringOrNull(value) {
      return typeof value === 'string' && value !== '' ? value : null;
    }

    /**
     * A recorded count, or a derived fallback for an older receipt.
     * @param value - summary field.
     * @param fallback - value computed from the receipt's array.
     * @returns the count.
     */
    function countOr(value, fallback) {
      const recorded = numberOrNull(value);
      return recorded === null ? fallback : recorded;
    }

    /**
     * Sum a turn's durable token buckets.
     * @param usage - turn usage, if recorded.
     * @returns the token total, or null while no bucket is present.
     */
    function tokenTotal(usage) {
      const record = asRecord(usage);
      const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
      let total = 0;
      let seen = false;
      for (const bucket of buckets) {
        const value = numberOrNull(record[bucket]);
        if (value === null) continue;
        seen = true;
        total += value;
      }
      return seen ? total : null;
    }

    /**
     * Map a receipt thread kind onto the four labels this panel knows.
     * @param value - recorded thread kind.
     * @returns the known kind, or `other`.
     */
    function threadKind(value) {
      if (value === 'failing-command' || value === 'failed-tests' || value === 'unfinished-turn' || value === 'todo' || value === 'todo-marker') return value;
      return 'other';
    }

    /**
     * Translate one thread kind.
     * @param kind - normalized thread kind.
     * @param t - translator.
     * @returns the kind label.
     */
    function threadLabel(kind, t) {
      if (kind === 'failing-command') return t('thread.failingCommand');
      if (kind === 'failed-tests') return t('thread.failedTests');
      if (kind === 'unfinished-turn') return t('thread.unfinishedTurn');
      if (kind === 'todo') return t('thread.todo');
      if (kind === 'todo-marker') return t('thread.todoMarker');
      return t('thread.other');
    }

    /**
     * Translate one file status.
     * @param status - normalized status.
     * @param t - translator.
     * @returns the status label.
     */
    function statusLabel(status, t) {
      if (status === 'added') return t('status.added');
      if (status === 'deleted') return t('status.deleted');
      if (status === 'modified') return t('status.modified');
      return t('status.other');
    }

    /**
     * A locale-safe download file name for one session's export.
     * @param sessionId - session id.
     * @param extension - file extension.
     * @returns the download name.
     */
    function exportFileName(sessionId, extension) {
      const clean = sessionId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      return clean === '' ? `receipt.${extension}` : `receipt-${clean}.${extension}`;
    }

    /**
     * Normalize a possibly older or partial receipt into render-safe data. Every
     * array defaults to an empty list, every hash to null, and every price to
     * null so a missing field renders as a dash instead of throwing.
     * @param raw - receipt from the Host route.
     * @returns the normalized receipt.
     */
    function normalizeReceipt(raw) {
      const receipt = asRecord(raw);
      const summary = asRecord(receipt.summary);

      const files = [];
      for (const entry of asArray(receipt.files)) {
        const file = asRecord(entry);
        const path = stringOrNull(file.path);
        if (path === null) continue;
        const status = file.status === 'added' || file.status === 'deleted' || file.status === 'modified' ? file.status : 'other';
        files.push({
          path,
          status,
          beforeSha256: stringOrNull(file.beforeSha256),
          afterSha256: stringOrNull(file.afterSha256),
        });
      }

      const commands = [];
      const rawCommands = asArray(receipt.commands);
      for (let index = 0; index < rawCommands.length; index += 1) {
        const command = asRecord(rawCommands[index]);
        const text = stringOrNull(command.command);
        const tool = stringOrNull(command.tool);
        if (text === null && tool === null) continue;
        commands.push({
          key: String(numberOrNull(command.seq) ?? index),
          tool: tool ?? '',
          command: text ?? '',
          exitCode: numberOrNull(command.exitCode),
          firstFailureLine: stringOrNull(command.firstFailureLine),
        });
      }

      const turns = [];
      const rawTurns = asArray(receipt.turns);
      for (let index = 0; index < rawTurns.length; index += 1) {
        const turn = asRecord(rawTurns[index]);
        turns.push({
          key: String(numberOrNull(turn.turn) ?? index),
          turn: numberOrNull(turn.turn),
          model: stringOrNull(turn.model),
          tokens: tokenTotal(turn.usage),
          costUsd: numberOrNull(turn.costUsd),
        });
      }

      const threads = [];
      const rawThreads = asArray(receipt.threads);
      for (let index = 0; index < rawThreads.length; index += 1) {
        const thread = asRecord(rawThreads[index]);
        threads.push({
          key: String(index),
          kind: threadKind(thread.kind),
          title: stringOrNull(thread.title),
          detail: stringOrNull(thread.detail),
        });
      }

      const snapshots = asRecord(receipt.snapshots);
      return {
        summary: {
          filesAdded: countOr(summary.filesAdded, files.filter((file) => file.status === 'added').length),
          filesModified: countOr(summary.filesModified, files.filter((file) => file.status === 'modified').length),
          filesDeleted: countOr(summary.filesDeleted, files.filter((file) => file.status === 'deleted').length),
          commands: countOr(summary.commands, commands.length),
          commandsFailed: countOr(summary.commandsFailed, commands.filter((command) => command.exitCode !== null && command.exitCode !== 0).length),
          models: countOr(summary.models, asArray(receipt.models).length),
          totalCostUsd: numberOrNull(summary.totalCostUsd),
          openThreads: countOr(summary.openThreads, threads.length),
        },
        files,
        commands,
        turns,
        threads,
        snapshots: isRecord(receipt.snapshots) ? { entries: countOr(snapshots.entries, 0), bytes: countOr(snapshots.bytes, 0) } : null,
      };
    }

    /**
     * Pull the receipt out of the Host envelope, tolerating a bare receipt.
     * @param payload - parsed JSON body.
     * @returns the receipt, or null when the body records none.
     */
    function receiptFromPayload(payload) {
      if (!isRecord(payload)) return null;
      if (Object.prototype.hasOwnProperty.call(payload, 'receipt')) return isRecord(payload.receipt) ? payload.receipt : null;
      if (payload.kind === 'session-receipt') return payload;
      if (Array.isArray(payload.files) || Array.isArray(payload.turns) || Array.isArray(payload.commands)) return payload;
      return null;
    }

    /** Document glyph shared by the header opener and the loading state. */
    function ReceiptIcon() {
      return h('svg', { viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', {
          key: 'outline',
          d: 'M5 2.5h6.5L15 6v11.5H5z',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'fold',
          d: 'M11.5 2.5V6H15',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'lines',
          d: 'M7.5 9.5h5M7.5 12h5M7.5 14.5h3',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
        }),
      ]);
    }

    /**
     * A before/after SHA-256 cell: seven visible characters, the full hash on
     * the title, and a dash when the receipt could not record that side.
     * @param hash - full hash or null.
     * @param t - translator.
     * @returns the cell content.
     */
    function hashCell(hash, t) {
      if (hash === null) return h('span', { className: 'sd-mono sd-tertiary' }, t('value.none'));
      return h('span', { className: 'sd-mono', title: hash }, hash.slice(0, 7));
    }

    /**
     * One summary statistic.
     * @param label - localized label.
     * @param value - display value.
     * @param note - optional failure note.
     * @param key - React key.
     * @returns the statistic element.
     */
    function statOf(label, value, note, key) {
      return h('div', { key, className: 'sd-stat' }, [
        h('span', { key: 'label', className: 'sd-stat-label' }, label),
        h('span', { key: 'value', className: 'sd-stat-value' }, value),
        note === null ? null : h('span', { key: 'note', className: 'sd-stat-note' }, note),
      ]);
    }

    /**
     * The summary strip above the tables.
     * @param data - normalized receipt.
     * @param t - translator.
     * @returns the summary element.
     */
    function summaryStrip(data, t) {
      const summary = data.summary;
      const cost = summary.totalCostUsd === null ? t('value.none') : t('cost.amount', { amount: summary.totalCostUsd.toFixed(4) });
      const failureNote = summary.commandsFailed > 0 ? t('summary.failed', { count: summary.commandsFailed }) : null;
      return h('div', { className: 'sd-summary' }, [
        statOf(t('summary.filesAdded'), String(summary.filesAdded), null, 'added'),
        statOf(t('summary.filesModified'), String(summary.filesModified), null, 'modified'),
        statOf(t('summary.filesDeleted'), String(summary.filesDeleted), null, 'deleted'),
        statOf(t('summary.commands'), String(summary.commands), failureNote, 'commands'),
        statOf(t('summary.models'), String(summary.models), null, 'models'),
        statOf(t('summary.totalCost'), cost, null, 'cost'),
        statOf(t('summary.openThreads'), String(summary.openThreads), null, 'threads'),
      ]);
    }

    /**
     * The Files section.
     * @param data - normalized receipt.
     * @param t - translator.
     * @returns the section element.
     */
    function filesSection(data, t) {
      const title = h('h3', { key: 'title', className: 'sd-section-title' }, t('files.title'));
      if (data.files.length === 0) {
        return h('section', { key: 'files', className: 'sd-section' }, [title, h('p', { key: 'empty', className: 'sd-empty' }, t('empty.files'))]);
      }
      const head = h('thead', { key: 'head' }, h('tr', null, [
        h('th', { key: 'path', style: { width: '46%' } }, t('files.path')),
        h('th', { key: 'status', style: { width: '18%' } }, t('files.status')),
        h('th', { key: 'before', style: { width: '18%' } }, t('files.before')),
        h('th', { key: 'after', style: { width: '18%' } }, t('files.after')),
      ]));
      const rows = data.files.map((file, index) => h('tr', { key: `${file.path}:${index}` }, [
        h('td', { key: 'path' }, h('span', { className: 'sd-truncate sd-mono', title: file.path }, file.path)),
        h('td', { key: 'status' }, h('span', { className: `sd-badge sd-badge-${file.status}` }, statusLabel(file.status, t))),
        h('td', { key: 'before' }, hashCell(file.beforeSha256, t)),
        h('td', { key: 'after' }, hashCell(file.afterSha256, t)),
      ]));
      return h('section', { key: 'files', className: 'sd-section' }, [
        title,
        h('table', { key: 'table', className: 'sd-table' }, [head, h('tbody', { key: 'body' }, rows)]),
      ]);
    }

    /**
     * The Commands section.
     * @param data - normalized receipt.
     * @param t - translator.
     * @returns the section element.
     */
    function commandsSection(data, t) {
      const title = h('h3', { key: 'title', className: 'sd-section-title' }, t('commands.title'));
      if (data.commands.length === 0) {
        return h('section', { key: 'commands', className: 'sd-section' }, [title, h('p', { key: 'empty', className: 'sd-empty' }, t('empty.commands'))]);
      }
      const head = h('thead', { key: 'head' }, h('tr', null, [
        h('th', { key: 'exit', style: { width: '12%' } }, t('commands.exit')),
        h('th', { key: 'tool', style: { width: '18%' } }, t('commands.tool')),
        h('th', { key: 'command', style: { width: '42%' } }, t('commands.command')),
        h('th', { key: 'failure', style: { width: '28%' } }, t('commands.failure')),
      ]));
      const rows = data.commands.map((command) => {
        const failed = command.exitCode !== null && command.exitCode !== 0;
        const exitText = command.exitCode === null ? t('value.none') : String(command.exitCode);
        const failureText = command.firstFailureLine === null ? t('value.none') : command.firstFailureLine;
        return h('tr', { key: command.key }, [
          h('td', { key: 'exit' }, h('span', { className: failed ? 'sd-exit sd-exit-failed' : 'sd-exit' }, exitText)),
          h('td', { key: 'tool' }, h('span', { className: 'sd-truncate' }, command.tool === '' ? t('value.none') : command.tool)),
          h('td', { key: 'command' }, h('span', { className: 'sd-truncate sd-mono', title: command.command === '' ? undefined : command.command }, command.command === '' ? t('value.none') : command.command)),
          h('td', { key: 'failure' }, h('span', { className: 'sd-truncate', title: command.firstFailureLine === null ? undefined : command.firstFailureLine }, failureText)),
        ]);
      });
      return h('section', { key: 'commands', className: 'sd-section' }, [
        title,
        h('table', { key: 'table', className: 'sd-table' }, [head, h('tbody', { key: 'body' }, rows)]),
      ]);
    }

    /**
     * The Models & cost section, one row per recorded turn.
     * @param data - normalized receipt.
     * @param t - translator.
     * @returns the section element.
     */
    function modelsSection(data, t) {
      const title = h('h3', { key: 'title', className: 'sd-section-title' }, t('models.title'));
      if (data.turns.length === 0) {
        return h('section', { key: 'models', className: 'sd-section' }, [title, h('p', { key: 'empty', className: 'sd-empty' }, t('empty.turns'))]);
      }
      const head = h('thead', { key: 'head' }, h('tr', null, [
        h('th', { key: 'turn', style: { width: '16%' } }, t('models.turn')),
        h('th', { key: 'model', style: { width: '36%' } }, t('models.model')),
        h('th', { key: 'tokens', style: { width: '24%' } }, t('models.tokens')),
        h('th', { key: 'cost', style: { width: '24%' } }, t('models.cost')),
      ]));
      const rows = data.turns.map((turn) => {
        const turnText = turn.turn === null ? t('value.none') : t('models.turnValue', { turn: turn.turn });
        const modelText = turn.model === null ? t('value.none') : turn.model;
        const tokenText = turn.tokens === null ? t('value.none') : String(turn.tokens);
        const costText = turn.costUsd === null ? t('value.none') : t('cost.amount', { amount: turn.costUsd.toFixed(4) });
        return h('tr', { key: turn.key }, [
          h('td', { key: 'turn' }, h('span', { className: 'sd-exit' }, turnText)),
          h('td', { key: 'model' }, h('span', { className: 'sd-truncate', title: turn.model === null ? undefined : turn.model }, modelText)),
          h('td', { key: 'tokens' }, h('span', { className: 'sd-exit' }, tokenText)),
          h('td', { key: 'cost' }, h('span', { className: 'sd-exit' }, costText)),
        ]);
      });
      return h('section', { key: 'models', className: 'sd-section' }, [
        title,
        h('table', { key: 'table', className: 'sd-table' }, [head, h('tbody', { key: 'body' }, rows)]),
      ]);
    }

    /**
     * The Open threads section.
     * @param data - normalized receipt.
     * @param t - translator.
     * @returns the section element.
     */
    function threadsSection(data, t) {
      const title = h('h3', { key: 'title', className: 'sd-section-title' }, t('threads.title'));
      if (data.threads.length === 0) {
        return h('section', { key: 'threads', className: 'sd-section' }, [title, h('p', { key: 'empty', className: 'sd-empty' }, t('empty.threads'))]);
      }
      const rows = data.threads.map((thread) => {
        const label = threadLabel(thread.kind, t);
        const heading = thread.title === null ? label : thread.title;
        return h('li', { key: thread.key, className: 'sd-thread' }, [
          h('div', { key: 'head', className: 'sd-thread-head' }, [
            h('span', { key: 'badge', className: 'sd-badge sd-badge-kind' }, label),
            h('span', { key: 'title', className: 'sd-thread-title', title: heading }, heading),
          ]),
          thread.detail === null ? null : h('span', { key: 'detail', className: 'sd-thread-detail' }, thread.detail),
        ]);
      });
      return h('section', { key: 'threads', className: 'sd-section' }, [
        title,
        h('ul', { key: 'list', className: 'sd-threads' }, rows),
      ]);
    }

    /**
     * The snapshots footer, shown only when the receipt carries snapshot stats.
     * @param snapshots - normalized snapshot stats.
     * @param t - translator.
     * @returns the footer element.
     */
    function snapshotsFooter(snapshots, t) {
      return h('div', { className: 'sd-snapshots' }, [
        h('span', { key: 'label', className: 'sd-snapshots-label' }, t('snapshots.label')),
        h('span', { key: 'stats' }, t('snapshots.stats', { entries: String(snapshots.entries), bytes: String(snapshots.bytes) })),
      ]);
    }

    /**
     * One export button.
     * @param spec - export format spec.
     * @param t - translator.
     * @param busy - format currently exporting, if any.
     * @param onExport - export callback.
     * @returns the button element.
     */
    function exportButton(spec, t, busy, onExport) {
      const label = spec.title(t);
      return h('button', {
        key: spec.format,
        type: 'button',
        className: 'sd-export',
        title: label,
        'aria-label': label,
        disabled: busy !== null,
        onClick: () => onExport(spec.format),
      }, spec.label(t));
    }

    /**
     * The ready receipt: summary strip, tables, threads, and snapshot footer.
     * Data is normalized inside a try/catch so a malformed receipt shows a
     * plain error line instead of unmounting the sidebar.
     * @param props - normalized render input and export callbacks.
     * @returns the receipt view.
     */
    function ReceiptView(props) {
      const t = translator(props.t);
      try {
        const data = normalizeReceipt(props.receipt);
        const busy = props.busy;
        return h('div', { className: 'sd-root', 'data-session-diff': 'receipt' }, [
          h('style', { key: 'css' }, CSS),
          h('div', { key: 'header', className: 'sd-header' }, [
            h('span', { key: 'title', className: 'sd-title' }, t('tab.title')),
            h('span', { key: 'spacer', className: 'sd-header-spacer' }),
            h('div', { key: 'exports', className: 'sd-exports' }, [
              h('span', { key: 'label', className: 'sd-export-label' }, t('export.label')),
              ...EXPORTS.map((spec) => exportButton(spec, t, busy, props.onExport)),
              props.exportFailed ? h('span', { key: 'failed', className: 'sd-export-failed', role: 'status' }, t('export.failed')) : null,
            ]),
          ]),
          h('div', { key: 'scroll', className: 'sd-scroll' }, [
            summaryStrip(data, t),
            filesSection(data, t),
            commandsSection(data, t),
            modelsSection(data, t),
            threadsSection(data, t),
            data.snapshots === null ? null : snapshotsFooter(data.snapshots, t),
          ]),
        ]);
      } catch (error) {
        return h('div', { className: 'sd-root', 'data-session-diff': 'receipt' }, [
          h('style', { key: 'css' }, CSS),
          h('div', { key: 'error', className: 'sd-state sd-state-error' }, t('error.load')),
        ]);
      }
    }

    /**
     * Loading, empty, and error states. The error state offers Retry; the
     * failure detail goes to the console so user-visible copy stays localized.
     * @param props - state, translator, retry callback.
     * @returns the state element.
     */
    function StateView(props) {
      const t = translator(props.t);
      if (props.state === 'loading') {
        return h('div', { className: 'sd-root', 'data-session-diff': 'receipt' }, [
          h('style', { key: 'css' }, CSS),
          h('div', { key: 'state', className: 'sd-state' }, [
            h(ReceiptIcon, { key: 'icon' }),
            h('span', { key: 'text' }, t('loading')),
          ]),
        ]);
      }
      if (props.state === 'empty') {
        return h('div', { className: 'sd-root', 'data-session-diff': 'receipt' }, [
          h('style', { key: 'css' }, CSS),
          h('div', { key: 'state', className: 'sd-state' }, [
            h(ReceiptIcon, { key: 'icon' }),
            h('span', { key: 'text' }, t('empty.none')),
          ]),
        ]);
      }
      return h('div', { className: 'sd-root', 'data-session-diff': 'receipt' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'state', className: 'sd-state sd-state-error' }, [
          h('span', { key: 'text' }, t('error.load')),
          h('button', { key: 'retry', type: 'button', className: 'sd-retry', onClick: props.onRetry }, t('retry')),
        ]),
      ]);
    }

    /**
     * The right-sidebar receipt tab body. Reads the Host receipt for the
     * Session on mount and whenever the Session changes; exports are fetched
     * as text and handed to the browser as a temporary download.
     * @param props - Session standard props plus the slot translator.
     * @returns the receipt panel.
     */
    function ReceiptTabBody(props) {
      const t = translator(props.t);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const [load, setLoad] = React.useState({ sessionId: null, status: 'loading', receipt: null });
      const [attempt, setAttempt] = React.useState(0);
      const [exportState, setExportState] = React.useState({ busy: null, failed: false });

      React.useEffect(() => {
        if (sessionId === '') {
          setLoad({ sessionId, status: 'empty', receipt: null });
          return undefined;
        }
        if (typeof fetch !== 'function') {
          setLoad({ sessionId, status: 'error', receipt: null });
          return undefined;
        }
        let cancelled = false;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const fail = (error) => {
          if (cancelled) return;
          if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn('session-diff: receipt read failed', error);
          setLoad({ sessionId, status: 'error', receipt: null });
        };
        setLoad({ sessionId, status: 'loading', receipt: null });
        const read = async () => {
          try {
            const response = await fetch(`${RECEIPT_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
              headers: { accept: 'application/json' },
              ...(controller === null ? {} : { signal: controller.signal }),
            });
            if (cancelled) return;
            if (response.status === 404 || response.status === 204) {
              setLoad({ sessionId, status: 'empty', receipt: null });
              return;
            }
            if (!response.ok) {
              fail(`HTTP ${response.status}`);
              return;
            }
            const text = await response.text();
            if (cancelled) return;
            if (text.trim() === '') {
              setLoad({ sessionId, status: 'empty', receipt: null });
              return;
            }
            let payload;
            try {
              payload = JSON.parse(text);
            } catch (error) {
              fail(error);
              return;
            }
            const receipt = receiptFromPayload(payload);
            if (receipt === null) {
              setLoad({ sessionId, status: 'empty', receipt: null });
              return;
            }
            setLoad({ sessionId, status: 'ready', receipt });
          } catch (error) {
            if (cancelled || (error !== null && typeof error === 'object' && error.name === 'AbortError')) return;
            fail(error);
          }
        };
        read();
        return () => {
          cancelled = true;
          if (controller !== null) controller.abort();
        };
      }, [sessionId, attempt]);

      const retry = () => setAttempt((value) => value + 1);

      /**
       * Fetch one exported rendering and download it without writing files on
       * the Host beyond the route's own read.
       * @param format - markdown, json, or html.
       */
      const runExport = async (format) => {
        if (exportState.busy !== null) return;
        const spec = EXPORTS.find((entry) => entry.format === format);
        if (spec === undefined) return;
        setExportState({ busy: format, failed: false });
        try {
          const response = await fetch(`${EXPORT_ROUTE}?session=${encodeURIComponent(sessionId)}&format=${encodeURIComponent(format)}`, {
            headers: { accept: spec.accept },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            throw new Error('downloads unavailable');
          }
          const href = URL.createObjectURL(new Blob([text], { type: spec.type }));
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.download = exportFileName(sessionId, spec.extension);
          anchor.rel = 'noopener';
          anchor.style.display = 'none';
          document.body.appendChild(anchor);
          try {
            anchor.click();
          } finally {
            anchor.remove();
          }
          setTimeout(() => URL.revokeObjectURL(href), 0);
          setExportState({ busy: null, failed: false });
        } catch (error) {
          setExportState({ busy: null, failed: true });
        }
      };

      const current = load.sessionId === sessionId ? load : { sessionId, status: 'loading', receipt: null };
      if (current.status === 'ready' && current.receipt !== null) {
        return h(ReceiptView, {
          t: props.t,
          receipt: current.receipt,
          busy: exportState.busy,
          exportFailed: exportState.failed,
          onExport: runExport,
        });
      }
      return h(StateView, {
        t: props.t,
        state: current.status,
        onRetry: retry,
      });
    }

    /**
     * Compact opener in the conversation header actions band. It only opens on
     * an explicit click; nothing is opened on mount, so the saved sidebar
     * layout is never claimed by this plugin.
     * @param props - locale translator plus the injected opener action.
     * @returns the header opener button.
     */
    function ReceiptOpener(props) {
      const t = translator(props.t);
      const button = h('button', {
        type: 'button',
        className: 'sd-opener',
        title: t('opener.title'),
        'aria-label': t('opener.aria'),
        onClick: () => {
          if (typeof props.openReceipt === 'function') props.openReceipt();
        },
      }, [
        h(ReceiptIcon, { key: 'icon' }),
        h('span', { key: 'label' }, t('opener.label')),
      ]);
      return h(React.Fragment, null, [h('style', { key: 'css' }, CSS), button]);
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-diff: copy');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('tab.title'),
        }), 'session-diff: tab type');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, ReceiptTabBody)), 'session-diff: tab body');

        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'session-diff',
          order: 16,
          locale: NS,
          inject: () => ({
            openReceipt: () => {
              try {
                ctx.sidebarRight.openTab(TAB_KIND);
              } catch (error) {
                console.warn('session-diff: cannot open the receipt tab', error);
              }
            },
          }),
        }, ReceiptOpener)), 'session-diff: header opener');
      },
    };
  },
});
