window.__ModuleLoader__.load({
  id: '@local/idea-board',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'idea-board'
    /** Same-origin Host routes that own the durable documents. */
    const ROUTE = '/idea-board/state'
    const DREAM_ROUTE = '/dream-board/state'
    const PURSUE_ROUTE = '/dream-board/pursue'
    const DISCARD_ROUTE = '/dream-board/discard'
    const SCHEDULE_ROUTE = '/dream-board/schedule'
    const NIGHTMARE_ROUTE = '/nightmare-board/state'
    const NIGHTMARE_DECIDE_ROUTE = '/nightmare-board/decide'
    const NIGHTMARE_SQUASH_ROUTE = '/nightmare-board/squash'
    const NIGHTMARE_RUN_ROUTE = '/nightmare-board/run'
    /** Bounds shared by the floating window and its resize handles. */
    const MIN_WIDTH = 280
    const MIN_HEIGHT = 180
    const MAX_DOCK_HEIGHT = 640
    /** Layout defaults for a document that has never been dragged or resized. */
    const EMPTY_UI = { collapsed: false, docked: false, x: null, y: null, width: null, height: null, tab: 'ideas', wide: false }

    /** English copy; the zh dictionary mirrors its key set. */
    const en = {
      'panel.title': 'Ideas',
      'panel.dreams': 'Dreams',
      'panel.openCount': '{count} open',
      'panel.collapse': 'Collapse ideas',
      'panel.expand': 'Expand ideas',
      'tab.ideas': 'Ideas',
      'tab.dreams': 'Dreams {count}',
      'input.placeholder': 'Capture an idea…',
      'input.add': 'Add idea',
      'list.empty': 'No ideas yet. Add one above.',
      'list.loading': 'Loading your ideas…',
      'item.markDone': 'Mark idea done',
      'item.markUndone': 'Mark idea not done',
      'item.edit': 'Edit idea',
      'item.save': 'Save idea',
      'item.delete': 'Delete idea',
      'foot.counts': '{open} open · {done} done',
      'foot.clear': 'Clear done',
      'foot.saving': 'Saving…',
      'foot.saveFailed': 'Not saved',
      'error.load': 'Saved ideas could not be loaded.',
      'error.retry': 'Retry',
      'notice.conflict': 'Reloaded newer changes from another window.',
      'dream.empty': 'No dreams yet. The dreamer adds them on its next run.',
      'dream.noRun': 'No dreamer run yet.',
      'dream.runSummary': 'Last run: +{added} new · {refined} refined · {promoted} ready',
      'dream.cap': '{count}/{cap} active',
      'dream.status.incubating': 'Incubating',
      'dream.status.ready': 'Ready for review',
      'dream.status.pursued': 'Pursued',
      'dream.status.discarded': 'Discarded',
      'dream.type.feature': 'Feature',
      'dream.type.application': 'App',
      'dream.type.service': 'Service',
      'dream.type.other': 'Other',
      'dream.group.feature': 'New features',
      'dream.group.application': 'New apps',
      'dream.group.service': 'New services',
      'dream.group.other': 'Other ideas',
      'panel.wideOn': 'Expand to a bigger window',
      'panel.wideOff': 'Restore the compact window',
      'panel.dock': 'Dock above Settings',
      'panel.undock': 'Pop out as a window',
      'panel.resize': 'Resize',
      'dream.selectHint': 'Select a dream to read its full spec.',
      'dream.mvpCount': '{count} MVP steps',
      'dream.competitorCount': '{count} competitors',
      'dream.webCount': '{count} web sources',
      'dream.updated': 'Updated {date}',
      'dream.created': 'Created {date}',
      'dream.tags': 'Tags',
      'dream.researched': 'Researched',
      'dream.noResearch': 'No web sources yet',
      'dream.readyShort': 'ready',
      'dream.score': '{total}/25',
      'dream.iterations': '{count} iterations',
      'dream.sources': '{count} sources',
      'dream.detail': 'Dream details',
      'dream.back': 'Back to dreams',
      'dream.problem': 'Problem',
      'dream.targetUser': 'Target user',
      'dream.value': 'Why it is valuable',
      'dream.monetization': 'Monetization',
      'dream.competitors': 'Competitors',
      'dream.competitorGap': 'Gap',
      'dream.architecture': 'Architecture',
      'dream.mvp': 'MVP scope',
      'dream.effort': 'Effort',
      'dream.sourcesTitle': 'Sources',
      'dream.revisions': 'Revision log',
      'dream.rubric': 'Scores',
      'dream.pursue': 'Pursue',
      'dream.discard': 'Discard',
      'dream.pursueConfirm': 'Render the build packet and launch a Fleet buildout from it? The packet is saved in briefs/.',
      'dream.pursueAction': 'Launch',
      'dream.cancel': 'Cancel',
      'dream.discardReason': 'Optional one-line reason',
      'dream.discardAction': 'Discard dream',
      'dream.pursued': 'Fleet buildout started{where}. Packet: {brief}.',
      'dream.discarded': 'Discarded. It will not come back in later runs.',
      'dream.actionFailed': 'Action failed: {error}',
      'dream.schedulePaused': 'Dreamer paused.',
      'dream.scheduleResumed': 'Dreamer resumed.',
      'dream.runStarted': 'Dreamer run started.',
      'dream.runNow': 'Run dreamer now',
      'dream.pause': 'Pause dreamer',
      'dream.resume': 'Resume dreamer',
      'dream.schedule': 'Dreamer {status}',
      'dream.loadFailed': 'Dream Board could not be loaded.',
      'dream.ready': '{count} ready',
      'dream.refresh': 'Refresh',
      'panel.nightmares': 'Nightmares',
      'tab.nightmares': 'Nightmares {count}',
      'nightmare.loading': 'Loading the nightmare backlog…',
      'nightmare.loadFailed': 'Nightmares could not be loaded.',
      'nightmare.empty': 'No open findings.',
      'nightmare.noScan': 'No scan yet.',
      'nightmare.lastScan': 'Last scan {date}',
      'nightmare.source': 'Source: {source}',
      'nightmare.openCount': '{count} open',
      'nightmare.counts': '{open} open · {accepted} accepted · {fixed} fixed',
      'nightmare.groupOpen': 'Needs a decision',
      'nightmare.groupDecided': 'Decided',
      'nightmare.severity.error': 'Error',
      'nightmare.severity.warn': 'Warning',
      'nightmare.severity.info': 'Info',
      'nightmare.status.open': 'Open',
      'nightmare.status.accepted': 'Accepted',
      'nightmare.status.fixed': 'Fixed',
      'nightmare.status.ignored': 'Ignored',
      'nightmare.status.removed': 'Removed',
      'nightmare.occurrences': '{count} occurrences',
      'nightmare.seen': 'First seen {first} · last seen {last}',
      'nightmare.back': 'Back to nightmares',
      'nightmare.selectHint': 'Select a finding to read its evidence.',
      'nightmare.summary': 'Summary',
      'nightmare.evidence': 'Evidence',
      'nightmare.fixTitle': 'Suggested fix',
      'nightmare.fixType': 'Fix type: {type}',
      'nightmare.decision': 'Decision',
      'nightmare.history': 'History',
      'nightmare.comment': 'Reason',
      'nightmare.commentPlaceholder': 'Why are you keeping this finding?',
      'nightmare.keepHint': 'Say why you are keeping it before you confirm.',
      'nightmare.squashAction': 'Squash',
      'nightmare.squashStarted': 'Repair session started. The finding clears when the check passes.',
      'nightmare.squashStartedNamed': 'Repair session {session} started. The finding clears when the check passes.',
      'nightmare.squashUnavailable': 'A repair session cannot start: {error}',
      'nightmare.keepAction': 'Keep',
      'nightmare.ignoreAction': 'Keep it',
      'nightmare.removeAction': 'Remove',
      'nightmare.reopenAction': 'Reopen',
      'nightmare.decided': 'Decision saved: {status}.',
      'nightmare.actionFailed': 'Action failed: {error}',
      'nightmare.runDoctor': 'Run doctor now',
      'nightmare.running': 'Running the doctor…',
      'nightmare.runDone': 'Doctor: +{added} new · {updated} updated · {cleared} cleared.',
      'nightmare.runClean': 'Doctor: every check passed.',
      'nightmare.runFailed': 'Doctor run failed: {error}',
    };
    /** Simplified Chinese copy, key-identical to English. */
    const zh = {
      'panel.title': '想法',
      'panel.dreams': '梦想',
      'panel.openCount': '{count} 条待办',
      'panel.collapse': '收起想法',
      'panel.expand': '展开想法',
      'tab.ideas': '想法',
      'tab.dreams': '梦想 {count}',
      'input.placeholder': '记下一个想法…',
      'input.add': '添加想法',
      'list.empty': '还没有想法，在上方添加一条。',
      'list.loading': '正在加载你的想法…',
      'item.markDone': '标记为完成',
      'item.markUndone': '标记为未完成',
      'item.edit': '编辑想法',
      'item.save': '保存想法',
      'item.delete': '删除想法',
      'foot.counts': '{open} 条待办 · {done} 条完成',
      'foot.clear': '清除已完成',
      'foot.saving': '正在保存…',
      'foot.saveFailed': '未保存',
      'error.load': '无法加载已保存的想法。',
      'error.retry': '重试',
      'notice.conflict': '已载入另一个窗口中更新的内容。',
      'dream.empty': '还没有梦想。下一次运行时会生成。',
      'dream.noRun': '还没有运行记录。',
      'dream.runSummary': '上次运行：新增 {added} · 细化 {refined} · 就绪 {promoted}',
      'dream.cap': '{count}/{cap} 个进行中',
      'dream.status.incubating': '孵化中',
      'dream.status.ready': '待评审',
      'dream.status.pursued': '已推进',
      'dream.status.discarded': '已丢弃',
      'dream.type.feature': '功能',
      'dream.type.application': '独立应用',
      'dream.type.service': '服务',
      'dream.type.other': '其他',
      'dream.group.feature': '新功能',
      'dream.group.application': '新应用',
      'dream.group.service': '新服务',
      'dream.group.other': '其他想法',
      'panel.wideOn': '展开为大窗口',
      'panel.wideOff': '恢复紧凑窗口',
      'panel.dock': '停靠到设置上方',
      'panel.undock': '弹出为独立窗口',
      'panel.resize': '调整大小',
      'dream.selectHint': '选择一个梦想查看完整规格。',
      'dream.mvpCount': '{count} 个 MVP 步骤',
      'dream.competitorCount': '{count} 个竞品',
      'dream.webCount': '{count} 个网页来源',
      'dream.updated': '更新于 {date}',
      'dream.created': '创建于 {date}',
      'dream.tags': '标签',
      'dream.researched': '已研究',
      'dream.noResearch': '暂无网页来源',
      'dream.readyShort': '待评审',
      'dream.score': '{total}/25',
      'dream.iterations': '{count} 次迭代',
      'dream.sources': '{count} 个来源',
      'dream.detail': '梦想详情',
      'dream.back': '返回梦想列表',
      'dream.problem': '问题',
      'dream.targetUser': '目标用户',
      'dream.value': '价值',
      'dream.monetization': '变现模式',
      'dream.competitors': '竞品',
      'dream.competitorGap': '差距',
      'dream.architecture': '技术架构',
      'dream.mvp': 'MVP 范围',
      'dream.effort': '工作量',
      'dream.sourcesTitle': '来源',
      'dream.revisions': '修订记录',
      'dream.rubric': '评分',
      'dream.pursue': '推进',
      'dream.discard': '丢弃',
      'dream.pursueConfirm': '生成构建包并用它启动 Fleet 构建吗？构建包会保存到 briefs/。',
      'dream.pursueAction': '启动',
      'dream.cancel': '取消',
      'dream.discardReason': '可选的一句话原因',
      'dream.discardAction': '丢弃梦想',
      'dream.pursued': 'Fleet 构建已启动{where}。构建包：{brief}。',
      'dream.discarded': '已丢弃，之后的运行不会再提出。',
      'dream.actionFailed': '操作失败：{error}',
      'dream.schedulePaused': 'Dreamer 已暂停。',
      'dream.scheduleResumed': 'Dreamer 已恢复。',
      'dream.runStarted': 'Dreamer 已开始运行。',
      'dream.runNow': '立即运行 Dreamer',
      'dream.pause': '暂停 Dreamer',
      'dream.resume': '恢复 Dreamer',
      'dream.schedule': 'Dreamer {status}',
      'dream.loadFailed': '无法加载梦想面板。',
      'dream.ready': '{count} 个待评审',
      'dream.refresh': '刷新',
      'panel.nightmares': '问题',
      'tab.nightmares': '问题 {count}',
      'nightmare.loading': '正在加载问题清单…',
      'nightmare.loadFailed': '无法加载问题清单。',
      'nightmare.empty': '没有未处理的问题。',
      'nightmare.noScan': '还没有检查记录。',
      'nightmare.lastScan': '上次检查 {date}',
      'nightmare.source': '来源：{source}',
      'nightmare.openCount': '{count} 个未处理',
      'nightmare.counts': '{open} 个未处理 · {accepted} 个已接受 · {fixed} 个已修复',
      'nightmare.groupOpen': '待决定',
      'nightmare.groupDecided': '已决定',
      'nightmare.severity.error': '错误',
      'nightmare.severity.warn': '警告',
      'nightmare.severity.info': '提示',
      'nightmare.status.open': '未处理',
      'nightmare.status.accepted': '已接受',
      'nightmare.status.fixed': '已修复',
      'nightmare.status.ignored': '已忽略',
      'nightmare.status.removed': '已移除',
      'nightmare.occurrences': '出现 {count} 次',
      'nightmare.seen': '首次 {first} · 最近 {last}',
      'nightmare.back': '返回问题列表',
      'nightmare.selectHint': '选择一条问题查看证据。',
      'nightmare.summary': '概要',
      'nightmare.evidence': '证据',
      'nightmare.fixTitle': '建议修复',
      'nightmare.fixType': '修复类型：{type}',
      'nightmare.decision': '决定',
      'nightmare.history': '变更记录',
      'nightmare.comment': '理由',
      'nightmare.commentPlaceholder': '保留这条问题的原因',
      'nightmare.keepHint': '确认保留前请填写原因。',
      'nightmare.squashAction': '修复',
      'nightmare.squashStarted': '修复会话已启动，检查通过后该问题自动清除。',
      'nightmare.squashStartedNamed': '修复会话 {session} 已启动，检查通过后该问题自动清除。',
      'nightmare.squashUnavailable': '无法启动修复会话：{error}',
      'nightmare.keepAction': '保留',
      'nightmare.ignoreAction': '保留',
      'nightmare.removeAction': '移除',
      'nightmare.reopenAction': '重新打开',
      'nightmare.decided': '已保存决定：{status}。',
      'nightmare.actionFailed': '操作失败：{error}',
      'nightmare.runDoctor': '立即运行医生',
      'nightmare.running': '正在运行医生…',
      'nightmare.runDone': '医生：新增 {added} · 更新 {updated} · 清除 {cleared}。',
      'nightmare.runClean': '医生：所有检查均已通过。',
      'nightmare.runFailed': '医生运行失败：{error}',
    };
    /** Fallback copy for a run without the locale service. */
    const FALLBACK = en

    /** Component-local sheet; unmounting the widget removes it. */
    const CSS = `
.ib-card{display:flex;flex-direction:column;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 12px 32px -10px rgba(0,0,0,.3),0 2px 8px rgba(0,0,0,.12);overflow:hidden;font-size:13px;line-height:1.4}
.ib-float{position:absolute;z-index:1;width:min(380px,calc(100vw - 32px));max-height:min(480px,74vh)}
.ib-dock{position:relative;width:100%;border-radius:10px;box-shadow:0 2px 10px -6px rgba(0,0,0,.28)}
.ib-dock .ib-tabs{gap:2px;padding:0 6px 6px}
.ib-dock .ib-tab{font-size:11px;padding:3px 6px;gap:3px}
.ib-dock .ib-title{font-size:12.5px}
.ib-dock-seat{display:flex;flex:1 1 100%;min-width:0;max-width:100%;box-sizing:border-box;padding:4px 6px 6px}
.ib-dock .ib-header{cursor:default}
.ib-resize{position:absolute;z-index:3;touch-action:none}
.ib-resize:hover{background:var(--dsw-alias-brand-primary,#247bbf);opacity:.16}
.ib-resize-n{top:0;left:12px;right:12px;height:6px;cursor:ns-resize}
.ib-resize-s{bottom:0;left:12px;right:12px;height:6px;cursor:ns-resize}
.ib-resize-e{right:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
.ib-resize-w{left:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
.ib-resize-ne{top:0;right:0;width:12px;height:12px;cursor:nesw-resize}
.ib-resize-nw{top:0;left:0;width:12px;height:12px;cursor:nwse-resize}
.ib-resize-se{right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize}
.ib-resize-sw{bottom:0;left:0;width:12px;height:12px;cursor:nesw-resize}
.ib-resize-se::after{content:"";position:absolute;right:4px;bottom:4px;width:6px;height:6px;border-right:1.5px solid var(--dsw-alias-label-secondary,#57606a);border-bottom:1.5px solid var(--dsw-alias-label-secondary,#57606a);opacity:.5}
.ib-card:hover .ib-resize-se::after{opacity:.9}
.ib-dock .ib-resize-se{display:none}
.ib-dockbar{display:flex;align-items:center;gap:7px;flex:1 1 auto;min-width:0;width:auto;box-sizing:border-box;margin:4px 6px 6px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:9px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;cursor:pointer;box-shadow:0 2px 10px -6px rgba(0,0,0,.28)}
.ib-dockbar:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.ib-dockbar:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.ib-railbtn{position:relative;width:36px;height:36px;flex:none;display:grid;place-items:center;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}
.ib-railbtn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2328)}
.ib-railbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.ib-railbtn-badge{position:absolute;top:1px;right:1px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff);font-size:9px;font-weight:600;display:grid;place-items:center;box-sizing:border-box}
.ib-header{display:flex;align-items:center;gap:7px;padding:9px 8px 4px 12px;cursor:grab;user-select:none;touch-action:none;flex:none}
.ib-header[data-dragging=true]{cursor:grabbing}
.ib-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);white-space:nowrap}
.ib-count{flex:none;font-size:10px;line-height:15px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap}
.ib-spacer{flex:1}
.ib-iconbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);width:24px;height:24px;flex:none;border-radius:6px;display:grid;place-items:center;cursor:pointer;padding:0}
.ib-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2328)}
.ib-iconbtn:disabled{opacity:.45;cursor:default}
.ib-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.ib-tabs{display:flex;gap:4px;padding:0 10px 6px;flex:none}
.ib-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12px;font-weight:500;padding:3px 9px;border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.ib-tab:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.ib-tab[data-active=true]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#1f2328)}
.ib-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.ib-tab-badge{font-size:10px;line-height:14px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff)}
.ib-body{display:flex;flex-direction:column;min-height:0;flex:1}
.ib-compose{display:flex;gap:6px;padding:0 10px 8px;flex:none}
.ib-input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit;border-radius:8px;padding:6px 9px;font:inherit;font-size:13px}
.ib-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#247bbf)}
.ib-input::placeholder{color:var(--dsw-alias-label-secondary,#57606a);opacity:.75}
.ib-add{appearance:none;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff);width:30px;flex:none;display:grid;place-items:center;cursor:pointer;padding:0}
.ib-add:disabled{opacity:.4;cursor:default}
.ib-add:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.ib-banner{flex:none;display:flex;align-items:center;gap:8px;margin:0 10px 8px;padding:6px 8px;border-radius:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.ib-banner .ib-link{flex:none}
.ib-banner[data-error=true]{color:var(--dsw-alias-state-error-primary,#c62828)}
.ib-list{list-style:none;margin:0;padding:0 6px 6px;overflow-y:auto;flex:1;min-height:0}
.ib-row{display:flex;align-items:flex-start;gap:7px;padding:5px 6px;border-radius:8px}
.ib-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.ib-check{width:16px;height:16px;margin-top:1px;flex:none;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.5));background:transparent;cursor:pointer;padding:0;display:grid;place-items:center;color:transparent}
.ib-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.ib-row[data-done=true] .ib-check{background:var(--dsw-alias-brand-primary,#247bbf);border-color:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff)}
.ib-text{flex:1;min-width:0;text-align:left;background:none;border:0;padding:0;color:inherit;font:inherit;cursor:text;overflow-wrap:anywhere}
.ib-text:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px;border-radius:3px}
.ib-row[data-done=true] .ib-text{color:var(--dsw-alias-label-secondary,#57606a);text-decoration:line-through}
.ib-edit{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary,#247bbf);background:var(--dsw-alias-bg-base,#fff);color:inherit;border-radius:6px;padding:2px 6px;font:inherit;font-size:13px}
.ib-edit:focus{outline:none}
.ib-del{opacity:0;width:22px;height:22px;margin-top:-3px}
.ib-row:hover .ib-del,.ib-row:focus-within .ib-del,.ib-del:focus-visible{opacity:1}
.ib-empty{padding:14px 12px 18px;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;text-align:center}
.ib-foot{display:flex;align-items:center;gap:8px;padding:6px 10px 7px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);flex:none}
.ib-link{background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.ib-link:hover{color:var(--dsw-alias-label-primary,#1f2328)}
.ib-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px;border-radius:3px}
.ib-save-error{color:var(--dsw-alias-state-error-primary,#c62828);white-space:nowrap}
.ib-pill{position:absolute;z-index:1;display:inline-flex;align-items:center;gap:7px;padding:6px 11px 6px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 6px 20px -6px rgba(0,0,0,.28);cursor:pointer;font:inherit;font-size:12px}
.ib-pill:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.ib-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.ib-pill-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff);font-size:10px;font-weight:600;display:grid;place-items:center;box-sizing:border-box}
.ib-dreams{overflow-y:auto;flex:1;min-height:0;padding:0 8px 8px}
.ib-dream-toolbar{display:flex;align-items:center;gap:6px;padding:0 2px 6px}
.ib-dream-schedule{font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ib-dream-item{display:block;width:100%;text-align:left;appearance:none;border:1px solid transparent;background:transparent;color:inherit;font:inherit;padding:7px 8px;border-radius:9px;cursor:pointer}
.ib-dream-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.ib-dream-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.ib-dream-item[data-ready=true]{border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.ib-dream-top{display:flex;align-items:center;gap:6px;min-width:0}
.ib-dream-title{font-weight:600;font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ib-dream-score{flex:none;font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#57606a)}
.ib-dream-pitch{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ib-dream-meta{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a);flex-wrap:wrap}
.ib-chip{display:inline-flex;align-items:center;gap:3px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));font-size:10px;line-height:15px}
.ib-chip[data-ready=true]{background:var(--dsw-alias-state-success-primary,#2e7d32);color:var(--dsw-alias-bg-base,#fff)}
.ib-dream-detail{overflow-y:auto;flex:1;min-height:0;padding:0 12px 10px}
.ib-detail-head{display:flex;align-items:flex-start;gap:6px;margin-bottom:6px}
.ib-detail-title{font-size:14px;font-weight:600;line-height:1.3;flex:1;min-width:0}
.ib-detail-pitch{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);margin:2px 0 8px}
.ib-section{margin:0 0 9px}
.ib-section-label{font-size:10px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#57606a);margin-bottom:2px}
.ib-section-text{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.ib-section-list{margin:0;padding-left:15px;font-size:12px}
.ib-section-list li{margin:1px 0}
.ib-competitor{font-size:11.5px;padding:3px 0;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.25))}
.ib-competitor:first-child{border-top:0}
.ib-competitor-name{font-weight:600}
.ib-sources{display:flex;flex-direction:column;gap:2px;font-size:11px}
.ib-source{color:var(--dsw-alias-brand-primary,#247bbf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ib-revisions{font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a)}
.ib-revision{padding:2px 0;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.25))}
.ib-revision:first-child{border-top:0}
.ib-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.ib-button{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer}
.ib-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18))}
.ib-button:disabled{opacity:.5;cursor:default}
.ib-button[data-primary=true]{background:var(--dsw-alias-brand-primary,#247bbf);border-color:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff)}
.ib-button[data-danger=true]{color:var(--dsw-alias-state-error-primary,#c62828);border-color:var(--dsw-alias-state-error-primary,#c62828)}
.ib-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.ib-confirm{margin-top:8px;padding:8px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.ib-confirm-text{font-size:12px;margin-bottom:6px}
.ib-confirm-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ib-reason{flex:1;min-width:160px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit;border-radius:7px;padding:4px 7px;font:inherit;font-size:12px}
.ib-reason:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#247bbf)}
.ib-card[data-wide=true]{width:min(880px,calc(100vw - 40px));max-height:min(88vh,960px)}
.ib-card[data-wide=true] .ib-dream-pitch{-webkit-line-clamp:3}
.ib-card[data-wide=true] .ib-dream-item{padding:8px 9px}
.ib-card[data-wide=true] .ib-detail-title{font-size:16px}
.ib-card[data-wide=true] .ib-dream-detail{padding-left:18px;padding-right:18px}
.ib-group{margin:0 0 6px}
.ib-group-head{display:flex;align-items:center;gap:6px;padding:6px 6px 3px;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#57606a)}
.ib-group-count{font-size:9px;line-height:14px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.ib-dream-labels{display:flex;align-items:center;gap:5px;margin-top:3px;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a);flex-wrap:wrap}
.ib-dream-split{display:flex;flex:1;min-height:0}
.ib-dream-left{width:330px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22))}
.ib-dream-left .ib-dreams{flex:1;min-height:0}
.ib-dream-right{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.ib-dream-right .ib-dream-detail{flex:1;min-height:0}
.ib-dream-hint{display:grid;place-items:center;flex:1;padding:24px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}
.ib-meta-line{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a)}
.ib-tag{display:inline-flex;align-items:center;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));font-size:10px;line-height:15px}
.ib-nightmares{overflow-y:auto;flex:1;min-height:0;padding:0 8px 8px}
.ib-nightmare-toolbar{display:flex;align-items:center;gap:6px;padding:0 2px 6px;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);min-height:15px}
.ib-nightmare-scan{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ib-nightmare-item{display:block;width:100%;text-align:left;appearance:none;border:1px solid transparent;background:transparent;color:inherit;font:inherit;padding:7px 8px;border-radius:9px;cursor:pointer}
.ib-nightmare-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.ib-nightmare-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.ib-nightmare-item[data-open=true]{border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.ib-nightmare-item[data-decided=true] .ib-nightmare-title{font-weight:500;color:var(--dsw-alias-label-secondary,#57606a)}
.ib-nightmare-squash{margin-left:auto;flex:none;font-size:11px}
.ib-nightmare-keep{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28))}
.ib-nightmare-top{display:flex;align-items:center;gap:6px;min-width:0}
.ib-severity{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary,#57606a)}
.ib-severity[data-severity=error]{background:var(--dsw-alias-state-error-primary,#c62828)}
.ib-severity[data-severity=warn]{background:var(--dsw-alias-state-warning-primary,#b26a00)}
.ib-severity[data-severity=info]{background:var(--dsw-alias-brand-primary,#247bbf)}
.ib-nightmare-check{flex:none;max-width:132px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ib-nightmare-title{flex:1;min-width:0;font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ib-nightmare-meta{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a);flex-wrap:wrap}
.ib-chip[data-status=open]{background:var(--dsw-alias-state-error-primary,#c62828);color:var(--dsw-alias-bg-base,#fff)}
.ib-chip[data-status=accepted]{background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff)}
.ib-nightmare-detail{overflow-y:auto;flex:1;min-height:0;padding:0 12px 10px}
.ib-nightmare-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;overflow-wrap:anywhere}
.ib-nightmare-evidence{padding:3px 0;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.25))}
.ib-nightmare-evidence:first-child{border-top:0}
.ib-nightmare-history-line{padding:2px 0;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.25));font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a)}
.ib-nightmare-history-line:first-child{border-top:0}
.ib-nightmare-comment{width:100%;box-sizing:border-box;min-height:54px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit;border-radius:8px;padding:5px 7px;font:inherit;font-size:12px}
.ib-nightmare-comment:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#247bbf)}
.ib-nightmare-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a);margin-top:4px}
`;

    /**
     * Resolve the display translator delivered by the slot's `locale` option.
     * @param t - translator, if the slot supplied one.
     * @returns a translation function that falls back to English copy.
     */
    function translator(t) {
      if (typeof t === 'function') return t
      return (key, params) => {
        const value = FALLBACK[key] ?? key
        return params === undefined
          ? value
          : value.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
      }
    }

    /**
     * Mint an item id without depending on a secure-context crypto API.
     * @returns a page-unique id.
     */
    function newId() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    /**
     * Clamp a coordinate into the overlay's finite range.
     * @param value - requested coordinate.
     * @param min - lowest accepted value.
     * @param max - highest accepted value.
     * @returns the clamped coordinate.
     */
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max))
    }

    /** Artwork-only bulb glyph, painted with the current text color. */
    function BulbIcon(props) {
      const size = props && props.size ? props.size : 15
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' }, [
        h('path', {
          key: 'bulb',
          d: 'M8 1.9a4.05 4.05 0 0 0-2.35 7.35c.36.27.57.62.66 1.02l.09.63h3.2l.09-.63c.09-.4.3-.75.66-1.02A4.05 4.05 0 0 0 8 1.9Z',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinejoin: 'round',
        }),
        h('path', { key: 'base', d: 'M6.5 13h3M7 14.4h2', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
      ])
    }

    /** Artwork-only check glyph. */
    function CheckIcon(props) {
      const size = props && props.size ? props.size : 12
      return h('svg', { viewBox: '0 0 12 12', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'm2.5 6.2 2.3 2.3 4.7-4.9', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /** Artwork-only close glyph. */
    function XIcon(props) {
      const size = props && props.size ? props.size : 12
      return h('svg', { viewBox: '0 0 12 12', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 3l6 6M9 3l-6 6', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }))
    }

    /** Artwork-only plus glyph. */
    function PlusIcon() {
      return h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M7 2.8v8.4M2.8 7h8.4', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' }))
    }

    /** Artwork-only chevron glyph. */
    function ChevronIcon(props) {
      const down = props && props.dir === 'down'
      const left = props && props.dir === 'left'
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: left ? 'M7.3 3 4.3 6l3 3' : down ? 'M3 4.7 6 7.7l3-3' : 'M3 7.3 6 4.3l3 3',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    /** Artwork-only play glyph. */
    function PlayIcon() {
      return h('svg', { viewBox: '0 0 12 12', width: 11, height: 11, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3.4 2.2 9.6 6l-6.2 3.8Z', fill: 'currentColor' }))
    }

    /** Artwork-only pause glyph. */
    function PauseIcon() {
      return h('svg', { viewBox: '0 0 12 12', width: 11, height: 11, fill: 'none', 'aria-hidden': 'true' }, [
        h('rect', { key: 'l', x: '3', y: '2.2', width: '2', height: '7.6', rx: '1', fill: 'currentColor' }),
        h('rect', { key: 'r', x: '7', y: '2.2', width: '2', height: '7.6', rx: '1', fill: 'currentColor' }),
      ])
    }

    /** Artwork-only expand glyph. */
    function ExpandIcon() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 'a', d: 'M7 2h3v3M5 10H2V7', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M10 2 6.6 5.4M2 10l3.4-3.4', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
      ])
    }

    /** Artwork-only restore glyph. */
    function RestoreIcon() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 'a', d: 'M10 7v3H7M2 5V2h3', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M10 10 6.6 6.6M2 2l3.4 3.4', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
      ])
    }

    /** Artwork-only dock glyph: a panel with a sidebar seam. */
    function DockIcon() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', 'aria-hidden': 'true' }, [
        h('rect', { key: 'frame', x: '1.4', y: '2', width: '9.2', height: '8', rx: '1.3', stroke: 'currentColor', strokeWidth: '1.2' }),
        h('path', { key: 'seam', d: 'M4.5 2v8', stroke: 'currentColor', strokeWidth: '1.2' }),
      ])
    }

    /** Read a dream's big total score safely. */
    function dreamScore(dream) {
      return typeof dream.totalScore === 'number' ? dream.totalScore : 0
    }

    /** Category order for the Dreams tab groups. */
    const TYPE_GROUPS = [
      { type: 'feature', labelKey: 'dream.group.feature' },
      { type: 'application', labelKey: 'dream.group.application' },
      { type: 'service', labelKey: 'dream.group.service' },
    ]

    /** Human status label for one dream. */
    function statusLabel(t, dream) {
      if (dream.status === 'ready_for_review') return t('dream.status.ready')
      if (dream.status === 'pursued') return t('dream.status.pursued')
      if (dream.status === 'discarded') return t('dream.status.discarded')
      return t('dream.status.incubating')
    }

    /** Human category label for one dream. */
    function typeLabel(t, type) {
      if (type === 'application') return t('dream.type.application')
      if (type === 'service') return t('dream.type.service')
      if (type === 'feature') return t('dream.type.feature')
      return t('dream.type.other')
    }

    /** Short display date for a timestamp. */
    function shortDate(value) {
      return new Date(typeof value === 'number' ? value : Date.now()).toLocaleDateString()
    }

    /** Map a decision action onto the status it produces. */
    const ACTION_STATUS = { accept: 'accepted', fix: 'fixed', ignore: 'ignored', remove: 'removed', reopen: 'open' }

    /** Human status label for one nightmare. */
    function nightmareStatusLabel(t, status) {
      if (status === 'accepted') return t('nightmare.status.accepted')
      if (status === 'fixed') return t('nightmare.status.fixed')
      if (status === 'ignored') return t('nightmare.status.ignored')
      if (status === 'removed') return t('nightmare.status.removed')
      return t('nightmare.status.open')
    }

    /** Human label for one nightmare severity marker. */
    function severityLabel(t, severity) {
      if (severity === 'error') return t('nightmare.severity.error')
      if (severity === 'warn') return t('nightmare.severity.warn')
      return t('nightmare.severity.info')
    }

    /** Whether a nightmare entry still needs an operator decision. */
    function isUndecided(nightmare) {
      return nightmare.status === 'open' || nightmare.status === 'accepted'
    }

    /**
     * Shared handoff between the floating card and the sidebar footer seat.
     * The seat publishes the element it owns and the sidebar's column state;
     * the card publishes whether it is docked so the seat reserves no height
     * while the card floats.
     * @returns the seat store.
     */
    function createDockSeat() {
      let snapshot = { el: null, wide: true, docked: false, collapsed: false, count: 0 }
      const listeners = new Set()
      const publish = (patch) => {
        const next = { ...snapshot, ...patch }
        if (next.el === snapshot.el && next.wide === snapshot.wide && next.docked === snapshot.docked
          && next.collapsed === snapshot.collapsed && next.count === snapshot.count) return
        snapshot = next
        for (const listener of listeners) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snapshot
        },
        setEl(el) {
          publish({ el })
        },
        setWide(wide) {
          publish({ wide })
        },
        setMode(docked, collapsed, count) {
          publish({ docked, collapsed, count })
        },
        /** Filled in by the mounted card so footer controls can drive it. */
        actions: { float: null, expand: null },
      }
    }

    /**
     * The sidebar footer seat: an in-flow anchor for the docked card, a compact
     * bar while it is collapsed, or a rail button when the sidebar is collapsed.
     * @param props - the footer action's owner props plus the shared seat.
     * @returns the seat content, or null while the card floats.
     */
    function DockSeat(props) {
      const seat = props.seat
      const t = translator(props.t)
      const wide = props.wide !== false
      const anchorRef = React.useRef(null)
      const state = React.useSyncExternalStore(seat.subscribe, seat.getSnapshot)

      React.useEffect(() => {
        seat.setWide(wide)
        seat.setEl(wide && state.docked && !state.collapsed ? anchorRef.current : null)
      }, [wide, state.docked, state.collapsed])
      React.useEffect(() => () => {
        seat.setEl(null)
        seat.setWide(true)
      }, [])

      if (!state.docked) return null
      if (!wide) {
        return h('button', {
          type: 'button',
          className: 'ib-railbtn',
          title: t('panel.undock'),
          'aria-label': t('panel.undock'),
          onClick: () => { if (seat.actions.float !== null) seat.actions.float() },
        }, [
          h(BulbIcon, { key: 'icon' }),
          state.count > 0 ? h('span', { key: 'badge', className: 'ib-railbtn-badge' }, state.count) : null,
        ])
      }
      if (state.collapsed) {
        return h('button', {
          type: 'button',
          className: 'ib-dockbar',
          title: t('panel.expand'),
          'aria-label': `${t('panel.title')}, ${t('panel.openCount', { count: state.count })}`,
          onClick: () => { if (seat.actions.expand !== null) seat.actions.expand() },
        }, [
          h(BulbIcon, { key: 'icon' }),
          h('span', { key: 'label' }, t('panel.title')),
          h('span', { key: 'count', className: 'ib-count' }, t('panel.openCount', { count: state.count })),
        ])
      }
      return h('div', { ref: anchorRef, className: 'ib-dock-seat' })
    }

    /**
     * The idea board and Dream Board widget: a frame-wide floating card with an
     * Ideas tab (capture and tick off), a Dreams tab (review AI-generated
     * dreams, pursue or discard them), and a schedule control for the dreamer.
     * @param props - the `shell.overlay` standard props plus the locale translator.
     * @returns the expanded card, the collapsed pill, or a loading card.
     */
    function IdeaBoard(props) {
      const t = translator(props.t)
      const seat = props.seat
      const [doc, setDoc] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [draft, setDraft] = React.useState('')
      const [editing, setEditing] = React.useState(null)
      const [editText, setEditText] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saveError, setSaveError] = React.useState(false)
      const [drag, setDrag] = React.useState(null)
      const [resize, setResize] = React.useState(null)
      const [viewport, setViewport] = React.useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
      const [notice, setNotice] = React.useState(null)
      const [board, setBoard] = React.useState(null)
      const [boardError, setBoardError] = React.useState(false)
      const [selectedId, setSelectedId] = React.useState(null)
      const [action, setAction] = React.useState(null)
      const [discardReason, setDiscardReason] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [boardNotice, setBoardNotice] = React.useState(null)
      const [nightmareBoard, setNightmareBoard] = React.useState(null)
      const [nightmareError, setNightmareError] = React.useState(false)
      const [nightmareNotice, setNightmareNotice] = React.useState(null)
      const [nightmareId, setNightmareId] = React.useState(null)
      const [nightmareComment, setNightmareComment] = React.useState('')
      const [nightmareKeep, setNightmareKeep] = React.useState(false)
      const [nightmareBusy, setNightmareBusy] = React.useState(false)
      const [doctorRunning, setDoctorRunning] = React.useState(false)
      const seatState = React.useSyncExternalStore(seat.subscribe, seat.getSnapshot)

      const docRef = React.useRef(null)
      const revisionRef = React.useRef(0)
      const dirtyRef = React.useRef(false)
      const pumpingRef = React.useRef(false)
      const dragRef = React.useRef(null)
      const resizeRef = React.useRef(null)
      const doctorRef = React.useRef(false)
      const cardRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const aliveRef = React.useRef(true)

      React.useEffect(() => {
        seat.actions.float = () => setUi({ docked: false, collapsed: false })
        seat.actions.expand = () => setUi({ collapsed: false })
      })
      React.useEffect(() => () => {
        seat.actions.float = null
        seat.actions.expand = null
      }, [])
      React.useEffect(() => {
        const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      /**
       * Replace the rendered document with one the Host accepted.
       * @param state - the document returned by the Host.
       */
      const adopt = (state) => {
        const ui = state !== null && state !== undefined && state.ui !== null && typeof state.ui === 'object' ? state.ui : EMPTY_UI
        const next = {
          revision: typeof state.revision === 'number' ? state.revision : 0,
          items: Array.isArray(state.items) ? state.items : [],
          ui: {
            collapsed: ui.collapsed === true,
            docked: ui.docked === true,
            x: typeof ui.x === 'number' ? ui.x : null,
            y: typeof ui.y === 'number' ? ui.y : null,
            width: typeof ui.width === 'number' ? ui.width : null,
            height: typeof ui.height === 'number' ? ui.height : null,
            tab: ui.tab === 'dreams' ? 'dreams' : ui.tab === 'nightmares' ? 'nightmares' : 'ideas',
            wide: ui.wide === true,
          },
        }
        revisionRef.current = next.revision
        docRef.current = next
        setDoc(next)
      }

      /**
       * Flush the latest document to the Host until no newer change is pending.
       * @returns a promise settled when the queue drains.
       */
      const pump = async () => {
        if (pumpingRef.current) {
          dirtyRef.current = true
          return
        }
        pumpingRef.current = true
        setSaving(true)
        try {
          do {
            dirtyRef.current = false
            const snapshot = docRef.current
            if (snapshot === null) break
            const response = await fetch(ROUTE, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                baseRevision: revisionRef.current,
                state: { items: snapshot.items, ui: snapshot.ui },
              }),
            })
            const body = await response.json()
            if (response.status === 409 && body && body.state) {
              adopt(body.state)
              setNotice(t('notice.conflict'))
              dirtyRef.current = false
              break
            }
            if (!response.ok || !body || body.ok !== true) {
              throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
            }
            revisionRef.current = body.state.revision
          } while (dirtyRef.current)
          setSaveError(false)
        } catch (error) {
          setSaveError(true)
          console.warn('idea-board: save failed', error)
        } finally {
          pumpingRef.current = false
          if (aliveRef.current) setSaving(false)
        }
      }

      /**
       * Apply a local change immediately and schedule its save.
       * @param change - fields to merge into the current document.
       */
      const update = (change) => {
        const current = docRef.current
        if (current === null) return
        const next = { ...current, ...change }
        docRef.current = next
        setDoc(next)
        dirtyRef.current = true
        void pump()
      }

      /**
       * Merge a layout change into the document.
       * @param patch - layout fields to change.
       */
      const setUi = (patch) => {
        const current = docRef.current
        if (current === null) return
        update({ ui: { ...current.ui, ...patch } })
      }

      /**
       * Read the saved idea document from the Host.
       * @returns a promise settled after the first read finishes.
       */
      const load = async () => {
        setPhase('loading')
        try {
          const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!response.ok || !body || body.ok !== true) {
            throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
          }
          if (!aliveRef.current) return
          adopt(body.state)
          setPhase('ready')
        } catch (error) {
          if (!aliveRef.current) return
          console.warn('idea-board: load failed', error)
          adopt({ revision: 0, items: [], ui: EMPTY_UI })
          setPhase('offline')
          setSaveError(true)
        }
      }

      /**
       * Read the Dream Board state from the Host.
       * @param quiet - suppress the error banner for background polling.
       * @returns a promise settled after the read.
       */
      const loadBoard = async (quiet) => {
        try {
          const response = await fetch(DREAM_ROUTE, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!response.ok || !body || body.ok !== true) {
            throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
          }
          if (!aliveRef.current) return
          setBoard(body.board)
          setBoardError(false)
        } catch (error) {
          if (!aliveRef.current) return
          if (!quiet) setBoardError(true)
          console.warn('idea-board: dream board load failed', error)
        }
      }

      /**
       * Read the nightmare backlog from the Host.
       * @param quiet - suppress the error banner for background refreshes.
       * @returns a promise settled after the read.
       */
      const loadNightmares = async (quiet) => {
        try {
          const response = await fetch(NIGHTMARE_ROUTE, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!response.ok || !body || body.ok !== true) {
            throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
          }
          if (!aliveRef.current) return
          setNightmareBoard(body.board)
          setNightmareError(false)
        } catch (error) {
          if (!aliveRef.current) return
          if (!quiet) setNightmareError(true)
          console.warn('idea-board: nightmare board load failed', error)
        }
      }

      React.useEffect(() => {
        aliveRef.current = true
        void load()
        void loadBoard(true)
        return () => {
          aliveRef.current = false
        }
      }, [])

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 4500)
        return () => clearTimeout(timer)
      }, [notice])

      React.useEffect(() => {
        if (boardNotice === null) return undefined
        const timer = setTimeout(() => setBoardNotice(null), 6000)
        return () => clearTimeout(timer)
      }, [boardNotice])

      React.useEffect(() => {
        if (nightmareNotice === null) return undefined
        const timer = setTimeout(() => setNightmareNotice(null), 6000)
        return () => clearTimeout(timer)
      }, [nightmareNotice])

      const tab = doc === null ? 'ideas' : doc.ui.tab

      React.useEffect(() => {
        if (tab !== 'dreams') return undefined
        void loadBoard(true)
        const timer = setInterval(() => { void loadBoard(true) }, 30000)
        return () => clearInterval(timer)
      }, [tab])

      React.useEffect(() => {
        if (tab !== 'nightmares') return undefined
        void loadNightmares(false)
        return undefined
      }, [tab])

      /**
       * Append the composer's text as a new idea.
       * @param event - the submitted form event.
       */
      const addItem = (event) => {
        if (event) event.preventDefault()
        const text = draft.trim()
        if (text === '') return
        const current = docRef.current
        if (current === null) return
        update({ items: [...current.items, { id: newId(), text, done: false, createdAt: Date.now() }] })
        setDraft('')
        if (inputRef.current !== null) inputRef.current.focus()
      }

      /**
       * Flip one idea's done state.
       * @param id - the idea to update.
       */
      const toggle = (id) => {
        const current = docRef.current
        if (current === null) return
        update({ items: current.items.map(item => (item.id === id ? { ...item, done: !item.done } : item)) })
      }

      /**
       * Remove one idea.
       * @param id - the idea to delete.
       */
      const remove = (id) => {
        const current = docRef.current
        if (current === null) return
        update({ items: current.items.filter(item => item.id !== id) })
      }

      /**
       * Remove every finished idea.
       */
      const clearDone = () => {
        const current = docRef.current
        if (current === null) return
        update({ items: current.items.filter(item => !item.done) })
      }

      /**
       * Start editing one idea's text.
       * @param item - the idea to edit.
       */
      const beginEdit = (item) => {
        setEditing(item.id)
        setEditText(item.text)
      }

      /**
       * Commit the edited text, dropping an empty edit.
       */
      const commitEdit = () => {
        const current = docRef.current
        const text = editText.trim()
        if (current === null || editing === null) {
          setEditing(null)
          return
        }
        if (text === '') {
          setEditing(null)
          return
        }
        update({ items: current.items.map(item => (item.id === editing ? { ...item, text } : item)) })
        setEditing(null)
      }

      /**
       * Drag the card inside the overlay layer, persisting the final position.
       * @param event - the header's pointerdown event.
       */
      const startDrag = (event) => {
        if (event.button !== 0) return
        const current = docRef.current
        if (current !== null && current.ui.docked) return
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('button, .ib-resize')) return
        const card = cardRef.current
        const layer = card === null ? null : card.closest('[data-shell-overlay]')
        if (card === null || layer === null) return
        const cardRect = card.getBoundingClientRect()
        const layerRect = layer.getBoundingClientRect()
        const origin = {
          pointerX: event.clientX,
          pointerY: event.clientY,
          left: cardRect.left - layerRect.left,
          top: cardRect.top - layerRect.top,
          maxX: layerRect.width - cardRect.width,
          maxY: layerRect.height - cardRect.height,
        }
        dragRef.current = { x: origin.left, y: origin.top }
        setDrag({ x: origin.left, y: origin.top })
        const move = (moveEvent) => {
          const next = {
            x: clamp(origin.left + moveEvent.clientX - origin.pointerX, 8, origin.maxX - 8),
            y: clamp(origin.top + moveEvent.clientY - origin.pointerY, 8, origin.maxY - 8),
          }
          dragRef.current = next
          setDrag(next)
        }
        const finish = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          const final = dragRef.current
          dragRef.current = null
          setDrag(null)
          if (final !== null) setUi({ x: final.x, y: final.y })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        event.preventDefault()
      }

      /**
       * Resize the card from one edge or corner and persist the final size.
       * A docked card has no position to change, so only its top edge resizes
       * the height that the sidebar footer reserves.
       * @param direction - one of n, s, e, w, ne, nw, se, sw.
       * @returns the pointerdown handler for that handle.
       */
      const startResize = (direction) => (event) => {
        if (event.button !== 0) return
        const card = cardRef.current
        if (card === null) return
        const docked = docRef.current !== null && docRef.current.ui.docked === true
        const cardRect = card.getBoundingClientRect()
        let x = cardRect.left
        let y = cardRect.top
        let maxW = window.innerWidth
        let maxH = window.innerHeight
        if (!docked) {
          const layer = card.closest('[data-shell-overlay]')
          if (layer === null) return
          const layerRect = layer.getBoundingClientRect()
          x = cardRect.left - layerRect.left
          y = cardRect.top - layerRect.top
          maxW = layerRect.width
          maxH = layerRect.height
        }
        const start = {
          pointerX: event.clientX,
          pointerY: event.clientY,
          x,
          y,
          w: cardRect.width,
          h: cardRect.height,
          maxW,
          maxH,
        }
        const first = { x: Math.round(x), y: Math.round(y), width: Math.round(cardRect.width), height: Math.round(cardRect.height) }
        resizeRef.current = first
        setResize(first)
        const move = (moveEvent) => {
          const deltaX = moveEvent.clientX - start.pointerX
          const deltaY = moveEvent.clientY - start.pointerY
          let nextX = start.x
          let nextY = start.y
          let width = start.w
          let height = start.h
          if (docked) {
            const maxDockHeight = Math.min(Math.max(MIN_HEIGHT, window.innerHeight * 0.7), MAX_DOCK_HEIGHT)
            height = clamp(start.h - deltaY, MIN_HEIGHT, maxDockHeight)
          } else {
            if (direction.includes('e')) width = clamp(start.w + deltaX, MIN_WIDTH, start.maxW - start.x - 8)
            if (direction.includes('w')) {
              const nextLeft = clamp(start.x + deltaX, 8, start.x + start.w - MIN_WIDTH)
              width = start.w - (nextLeft - start.x)
              nextX = nextLeft
            }
            if (direction.includes('s')) height = clamp(start.h + deltaY, MIN_HEIGHT, start.maxH - start.y - 8)
            if (direction.includes('n')) {
              const nextTop = clamp(start.y + deltaY, 8, start.y + start.h - MIN_HEIGHT)
              height = start.h - (nextTop - start.y)
              nextY = nextTop
            }
          }
          const next = { x: Math.round(nextX), y: Math.round(nextY), width: Math.round(width), height: Math.round(height) }
          resizeRef.current = next
          setResize(next)
        }
        const finish = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          const final = resizeRef.current
          resizeRef.current = null
          setResize(null)
          if (final !== null) {
            setUi(docked
              ? { height: final.height }
              : { x: final.x, y: final.y, width: final.width, height: final.height })
          }
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        event.preventDefault()
        event.stopPropagation()
      }

      /** POST one Dream Board action and refresh the board. */
      const act = async (route, body, successKey, extra) => {
        setBusy(true)
        try {
          const response = await fetch(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await response.json()
          if (!response.ok || !data.ok) {
            throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          }
          const params = route === PURSUE_ROUTE
            ? {
              where: typeof data.sessionId === 'string' && data.sessionId !== '' ? ` (${data.sessionId})` : '',
              brief: typeof data.briefPath === 'string' ? data.briefPath : 'briefs/',
            }
            : extra ?? {}
          setBoardNotice(t(successKey, params))
          setAction(null)
          setDiscardReason('')
          setSelectedId(null)
          await loadBoard(true)
          return data
        } catch (error) {
          setBoardNotice(t('dream.actionFailed', { error: error instanceof Error ? error.message : String(error) }))
          return null
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }

      /**
       * POST one nightmare decision, then refresh the backlog.
       * Keep and remove never leave the browser without a non-empty reason.
       * @param action - ignore, remove, or reopen.
       */
      const decideNightmare = async (action) => {
        const entries = nightmareBoard === null || !Array.isArray(nightmareBoard.nightmares) ? [] : nightmareBoard.nightmares
        const entry = nightmareId === null ? null : entries.find((row) => row.id === nightmareId) ?? null
        if (entry === null) return
        const comment = nightmareComment.trim()
        if ((action === 'ignore' || action === 'remove') && comment === '') {
          setNightmareKeep(true)
          setNightmareNotice(t('nightmare.keepHint'))
          return
        }
        setNightmareBusy(true)
        try {
          const response = await fetch(NIGHTMARE_DECIDE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: entry.id, action, comment }),
          })
          const data = await response.json()
          if (!response.ok || !data || data.ok !== true) {
            throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          }
          if (!aliveRef.current) return null
          const status = data.nightmare && typeof data.nightmare.status === 'string' ? data.nightmare.status : ACTION_STATUS[action] ?? 'open'
          setNightmareNotice(t('nightmare.decided', { status: nightmareStatusLabel(t, status) }))
          setNightmareComment('')
          setNightmareKeep(false)
          await loadNightmares(true)
          return data
        } catch (error) {
          if (!aliveRef.current) return null
          setNightmareNotice(t('nightmare.actionFailed', { error: error instanceof Error ? error.message : String(error) }))
          return null
        } finally {
          if (aliveRef.current) setNightmareBusy(false)
        }
      }

      /**
       * Squash one nightmare: start a Fleet repair session with no prompt.
       * The entry moves to `accepted`; the doctor closes it when the check passes.
       * @param id - nightmare id.
       */
      const squashNightmare = async (id) => {
        if (typeof id !== 'string' || id === '') return null
        setNightmareBusy(true)
        try {
          const response = await fetch(NIGHTMARE_SQUASH_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          const data = await response.json()
          if (!response.ok || !data || data.ok !== true) {
            throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          }
          if (!aliveRef.current) return null
          const session = data.sessionId
          setNightmareNotice(typeof session === 'string' && session !== ''
            ? t('nightmare.squashStartedNamed', { session })
            : t('nightmare.squashStarted'))
          setNightmareKeep(false)
          setNightmareComment('')
          await loadNightmares(true)
          return data
        } catch (error) {
          if (!aliveRef.current) return null
          setNightmareNotice(t('nightmare.squashUnavailable', { error: error instanceof Error ? error.message : String(error) }))
          return null
        } finally {
          if (aliveRef.current) setNightmareBusy(false)
        }
      }

      /**
       * Run the deterministic workspace doctor once and fold its feed into the
       * backlog, mirroring the Dreams tab's run-now control.
       */
      const runDoctorNow = async () => {
        if (doctorRef.current) return
        doctorRef.current = true
        setDoctorRunning(true)
        setNightmareBusy(true)
        setNightmareNotice(null)
        try {
          const response = await fetch(NIGHTMARE_RUN_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const data = await response.json()
          if (!response.ok || !data || data.ok !== true) {
            throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
          }
          if (!aliveRef.current) return
          if (data.board !== undefined && data.board !== null) setNightmareBoard(data.board)
          const run = data.run === undefined || data.run === null ? null : data.run
          setNightmareNotice(run === null || run.skipped === true
            ? t('nightmare.runClean')
            : t('nightmare.runDone', { added: run.added, updated: run.updated, cleared: run.cleared }))
          await loadNightmares(true)
        } catch (error) {
          if (!aliveRef.current) return
          setNightmareNotice(t('nightmare.runFailed', { error: error instanceof Error ? error.message : String(error) }))
        } finally {
          doctorRef.current = false
          if (aliveRef.current) {
            setDoctorRunning(false)
            setNightmareBusy(false)
          }
        }
      }


      const items = doc === null ? [] : doc.items
      const ui = doc === null ? EMPTY_UI : doc.ui
      const docked = ui.docked
      const wideLayout = ui.wide && !docked
      const openCount = items.filter(item => !item.done).length
      const doneCount = items.length - openCount
      const dreams = board === null ? [] : board.dreams
      const selected = selectedId === null ? null : dreams.find((dream) => dream.id === selectedId) ?? null
      const nightmares = nightmareBoard === null || !Array.isArray(nightmareBoard.nightmares) ? [] : nightmareBoard.nightmares
      const nightmareCounts = nightmareBoard === null || nightmareBoard.counts === undefined || nightmareBoard.counts === null
        ? { open: 0, accepted: 0, fixed: 0, ignored: 0, removed: 0, total: 0 }
        : nightmareBoard.counts
      const openNightmares = nightmares.filter(isUndecided)
      const decidedNightmares = nightmares.filter((entry) => !isUndecided(entry))
      const selectedNightmare = nightmareId === null ? null : nightmares.find((entry) => entry.id === nightmareId) ?? null
      const panelTitle = tab === 'nightmares' ? t('panel.nightmares') : tab === 'dreams' ? t('panel.dreams') : t('panel.title')
      const headerCount = tab === 'nightmares'
        ? t('nightmare.openCount', { count: nightmareCounts.open })
        : tab === 'dreams'
          ? t('dream.ready', { count: board === null ? 0 : board.counts.ready })
          : t('panel.openCount', { count: openCount })
      const scheduleStatus = board !== null && board.schedule.available && board.schedule.task !== null
        ? board.schedule.task.status
        : null
      const live = resize
      const position = docked
        ? null
        : live !== null
          ? { x: live.x, y: live.y }
          : drag !== null
            ? drag
            : typeof ui.x === 'number' && typeof ui.y === 'number' ? { x: ui.x, y: ui.y } : null
      const anchor = docked
        ? {}
        : position === null
          ? { right: '24px', bottom: '24px' }
          : {
            left: `${clamp(position.x, 8, Math.max(8, viewport.w - 80))}px`,
            top: `${clamp(position.y, 8, Math.max(8, viewport.h - 60))}px`,
          }
      const sizeStyle = {}
      if (docked) {
        const height = live !== null ? live.height : ui.height
        const maxDockHeight = Math.min(Math.max(MIN_HEIGHT, viewport.h * 0.7), MAX_DOCK_HEIGHT)
        sizeStyle.height = `${clamp(height === null ? Math.min(320, Math.round(viewport.h * 0.42)) : height, MIN_HEIGHT, maxDockHeight)}px`
      } else {
        const width = live !== null ? live.width : ui.width
        const height = live !== null ? live.height : ui.height
        if (width !== null) {
          const maxWidth = position === null ? viewport.w - 16 : Math.max(MIN_WIDTH, viewport.w - position.x - 8)
          sizeStyle.width = `${clamp(width, MIN_WIDTH, maxWidth)}px`
        }
        if (height !== null) {
          const maxHeight = position === null ? viewport.h - 16 : Math.max(MIN_HEIGHT, viewport.h - position.y - 8)
          sizeStyle.height = `${clamp(height, MIN_HEIGHT, maxHeight)}px`
          sizeStyle.maxHeight = 'calc(100vh - 16px)'
        }
      }

      React.useEffect(() => {
        seat.setMode(ui.docked, ui.collapsed, openCount)
      }, [ui.docked, ui.collapsed, openCount])

      if (ui.collapsed) {
        if (ui.docked) return h('style', { key: 'css' }, CSS)
        return h(React.Fragment, null, [
          h('style', { key: 'css' }, CSS),
          h('button', {
            key: 'pill',
            type: 'button',
            className: 'ib-pill',
            style: anchor,
            title: t('panel.expand'),
            'aria-label': `${t('panel.title')}, ${t('panel.openCount', { count: openCount })}`,
            onClick: () => setUi({ collapsed: false }),
          }, [
            h(BulbIcon, { key: 'icon' }),
            h('span', { key: 'label' }, t('panel.title')),
            openCount > 0 ? h('span', { key: 'badge', className: 'ib-pill-badge' }, openCount) : null,
          ]),
        ])
      }

      const rows = items.length === 0
        ? h('li', { key: 'empty', className: 'ib-empty' }, t('list.empty'))
        : items.map((item) => {
          const isEditing = editing === item.id
          return h('li', { key: item.id, className: 'ib-row', 'data-done': item.done || undefined }, [
            h('button', {
              key: 'check',
              type: 'button',
              className: 'ib-check',
              role: 'checkbox',
              'aria-checked': item.done,
              'aria-label': item.done ? t('item.markUndone') : t('item.markDone'),
              onClick: () => toggle(item.id),
            }, item.done ? h(CheckIcon, { key: 'mark', size: 11 }) : null),
            isEditing
              ? h('input', {
                key: 'edit',
                className: 'ib-edit',
                value: editText,
                autoFocus: true,
                maxLength: 500,
                'aria-label': t('item.edit'),
                onChange: (event) => setEditText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitEdit()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditing(null)
                  }
                },
              })
              : h('button', {
                key: 'text',
                type: 'button',
                className: 'ib-text',
                title: t('item.edit'),
                onClick: () => beginEdit(item),
              }, item.text),
            isEditing
              ? h('button', {
                key: 'save',
                type: 'button',
                className: 'ib-iconbtn',
                title: t('item.save'),
                'aria-label': t('item.save'),
                onClick: commitEdit,
              }, h(CheckIcon, { key: 'mark' }))
              : h('button', {
                key: 'delete',
                type: 'button',
                className: 'ib-iconbtn ib-del',
                title: t('item.delete'),
                'aria-label': t('item.delete'),
                onClick: () => remove(item.id),
              }, h(XIcon, { key: 'mark' })),
          ])
        })

      /** One field block in the dream detail. */
      const field = (label, value, options) => (value === '' || value === undefined || value === null)
        ? null
        : h('div', { key: options?.key ?? label, className: 'ib-section' }, [
          h('div', { key: 'label', className: 'ib-section-label' }, label),
          h('div', { key: 'text', className: 'ib-section-text' }, value),
        ])

      const tabButton = (id, label, badge) => h('button', {
        key: id,
        type: 'button',
        className: 'ib-tab',
        role: 'tab',
        'aria-selected': tab === id,
        'data-active': tab === id || undefined,
        onClick: () => {
          setUi({ tab: id })
          if (id === 'dreams') void loadBoard(true)
        },
      }, [h('span', { key: 'label' }, label), badge === undefined ? null : h('span', { key: 'badge', className: 'ib-tab-badge' }, badge)])

      const dreamRow = (dream) => {
        const web = dream.sources === undefined ? 0 : dream.sources.web.length
        const ideaSources = dream.sources === undefined ? 0 : dream.sources.ideas.length
        const sessionSources = dream.sources === undefined ? 0 : dream.sources.sessions.length
        const sourceCount = web + ideaSources + sessionSources
        return h('button', {
          key: dream.id,
          type: 'button',
          className: 'ib-dream-item',
          'data-ready': dream.status === 'ready_for_review' || undefined,
          onClick: () => { setSelectedId(dream.id); setAction(null) },
        }, [
          h('div', { key: 'top', className: 'ib-dream-top' }, [
            h('span', { key: 'title', className: 'ib-dream-title' }, dream.title),
            h('span', { key: 'score', className: 'ib-dream-score' }, t('dream.score', { total: dreamScore(dream) })),
          ]),
          h('div', { key: 'pitch', className: 'ib-dream-pitch' }, dream.pitch),
          h('div', { key: 'meta', className: 'ib-dream-meta' }, [
            h('span', { key: 'status', className: 'ib-chip', 'data-ready': dream.status === 'ready_for_review' || undefined }, statusLabel(t, dream)),
            h('span', { key: 'type', className: 'ib-chip' }, typeLabel(t, dream.type)),
            h('span', { key: 'iter', className: 'ib-chip' }, t('dream.iterations', { count: dream.iterationCount })),
            sourceCount > 0 ? h('span', { key: 'src', className: 'ib-chip' }, t('dream.sources', { count: sourceCount })) : null,
          ]),
          h('div', { key: 'labels', className: 'ib-dream-labels' }, [
            h('span', { key: 'updated' }, t('dream.updated', { date: shortDate(dream.lastRefinedAt) })),
            dream.mvpScope.length > 0 ? h('span', { key: 'mvp' }, t('dream.mvpCount', { count: dream.mvpScope.length })) : null,
            dream.competitive.competitors.length > 0
              ? h('span', { key: 'comp' }, t('dream.competitorCount', { count: dream.competitive.competitors.length }))
              : null,
            h('span', { key: 'research', className: 'ib-chip' }, web > 0 ? t('dream.webCount', { count: web }) : t('dream.noResearch')),
          ]),
        ])
      }

      /** Group the active dreams by category, preserving the server's review order. */
      const dreamGroupNodes = () => {
        const nodes = []
        for (const group of TYPE_GROUPS) {
          const rows = dreams.filter((dream) => dream.type === group.type)
          if (rows.length === 0) continue
          nodes.push(h('div', { key: group.type, className: 'ib-group' }, [
            h('div', { key: 'head', className: 'ib-group-head' }, [
              h('span', { key: 'label' }, t(group.labelKey)),
              h('span', { key: 'count', className: 'ib-group-count' }, rows.length),
            ]),
            ...rows.map(dreamRow),
          ]))
        }
        const other = dreams.filter((dream) => !TYPE_GROUPS.some((group) => group.type === dream.type))
        if (other.length > 0) {
          nodes.push(h('div', { key: 'other', className: 'ib-group' }, [
            h('div', { key: 'head', className: 'ib-group-head' }, [
              h('span', { key: 'label' }, t('dream.group.other')),
              h('span', { key: 'count', className: 'ib-group-count' }, other.length),
            ]),
            ...other.map(dreamRow),
          ]))
        }
        return nodes
      }

      /** The Dreams tab list view. */
      const dreamList = () => h('div', { key: 'dreams', className: 'ib-dreams', role: 'tabpanel' }, [
        h('div', { key: 'toolbar', className: 'ib-dream-toolbar' }, [
          h('span', { key: 'schedule', className: 'ib-dream-schedule' }, board === null
            ? t('dream.empty')
            : scheduleStatus === null
              ? t('dream.cap', { count: board.counts.active, cap: board.caps.maxActiveDreams })
              : t('dream.schedule', { status: scheduleStatus })),
          h('span', { key: 'spacer', className: 'ib-spacer' }),
          scheduleStatus === 'active'
            ? h('button', {
              key: 'pause',
              type: 'button',
              className: 'ib-iconbtn',
              title: t('dream.pause'),
              'aria-label': t('dream.pause'),
              disabled: busy,
              onClick: () => { void act(SCHEDULE_ROUTE, { action: 'pause' }, 'dream.schedulePaused') },
            }, h(PauseIcon, { key: 'icon' }))
            : scheduleStatus === 'paused'
              ? h('button', {
                key: 'resume',
                type: 'button',
                className: 'ib-iconbtn',
                title: t('dream.resume'),
                'aria-label': t('dream.resume'),
                disabled: busy,
                onClick: () => { void act(SCHEDULE_ROUTE, { action: 'resume' }, 'dream.scheduleResumed') },
              }, h(PlayIcon, { key: 'icon' }))
              : null,
          h('button', {
            key: 'run',
            type: 'button',
            className: 'ib-iconbtn',
            title: t('dream.runNow'),
            'aria-label': t('dream.runNow'),
            disabled: busy,
            onClick: () => { void act(SCHEDULE_ROUTE, { action: 'run' }, 'dream.runStarted') },
          }, h(PlayIcon, { key: 'icon' })),
        ]),
        board !== null && board.lastRun !== null
          ? h('div', { key: 'run', className: 'ib-dream-meta' }, t('dream.runSummary', {
            added: board.lastRun.added.length,
            refined: board.lastRun.refined.length,
            promoted: board.lastRun.promoted.length,
          }))
          : null,
        boardError
          ? h('div', { key: 'err', className: 'ib-banner', 'data-error': true }, [
            h('span', { key: 'text' }, t('dream.loadFailed')),
            h('button', { key: 'retry', type: 'button', className: 'ib-link', onClick: () => { void loadBoard(false) } }, t('error.retry')),
          ])
          : null,
        boardNotice !== null
          ? h('div', { key: 'notice', className: 'ib-banner' }, boardNotice)
          : null,
        board === null
          ? h('div', { key: 'loading', className: 'ib-empty' }, t('list.loading'))
          : dreams.length === 0
            ? h('div', { key: 'empty', className: 'ib-empty' }, t('dream.empty'))
            : dreamGroupNodes(),
      ])

      /** The Dreams tab detail view for one selected dream. */
      const dreamDetail = (dream) => {
        const sources = []
        for (const entry of dream.sources.web) {
          sources.push(h('a', {
            key: `w:${entry.url}`,
            className: 'ib-source',
            href: entry.url,
            target: '_blank',
            rel: 'noreferrer',
            title: entry.url,
          }, entry.title === '' ? entry.url : entry.title))
        }
        for (const entry of dream.sources.ideas) sources.push(h('span', { key: `i:${entry.title}`, className: 'ib-source' }, `Idea: ${entry.title}`))
        for (const entry of dream.sources.sessions) sources.push(h('span', { key: `s:${entry.title}`, className: 'ib-source' }, `Session: ${entry.title}`))
        const revisions = dream.revisionLog.slice(-4).reverse()
        return h('div', { key: 'detail', className: 'ib-dream-detail', role: 'tabpanel' }, [
          h('div', { key: 'head', className: 'ib-detail-head' }, [
            h('button', {
              key: 'back',
              type: 'button',
              className: 'ib-iconbtn',
              title: t('dream.back'),
              'aria-label': t('dream.back'),
              onClick: () => { setSelectedId(null); setAction(null) },
            }, h(ChevronIcon, { key: 'icon', dir: 'left' })),
            h('div', { key: 'title', className: 'ib-detail-title' }, dream.title),
            h('span', { key: 'score', className: 'ib-dream-score' }, t('dream.score', { total: dreamScore(dream) })),
          ]),
          h('div', { key: 'pitch', className: 'ib-detail-pitch' }, dream.pitch),
          h('div', { key: 'meta', className: 'ib-dream-meta' }, [
            h('span', { key: 'status', className: 'ib-chip', 'data-ready': dream.status === 'ready_for_review' || undefined }, statusLabel(t, dream)),
            h('span', { key: 'type', className: 'ib-chip' }, typeLabel(t, dream.type)),
            h('span', { key: 'iter', className: 'ib-chip' }, t('dream.iterations', { count: dream.iterationCount })),
            dream.sources.web.length > 0
              ? h('span', { key: 'researched', className: 'ib-chip', 'data-ready': true }, t('dream.researched'))
              : h('span', { key: 'researched', className: 'ib-chip' }, t('dream.noResearch')),
          ]),
          h('div', { key: 'labels', className: 'ib-meta-line' }, [
            dream.mvpScope.length > 0 ? h('span', { key: 'mvp' }, t('dream.mvpCount', { count: dream.mvpScope.length })) : null,
            dream.competitive.competitors.length > 0
              ? h('span', { key: 'comp' }, t('dream.competitorCount', { count: dream.competitive.competitors.length }))
              : null,
            h('span', { key: 'web' }, t('dream.webCount', { count: dream.sources.web.length })),
            h('span', { key: 'updated' }, t('dream.updated', { date: shortDate(dream.lastRefinedAt) })),
            h('span', { key: 'created' }, t('dream.created', { date: shortDate(dream.createdAt) })),
          ]),
          h('div', { key: 'rubric', className: 'ib-dream-meta' }, (board === null ? [] : board.rubric).map((entry) => h('span', {
            key: entry.key,
            className: 'ib-chip',
            title: entry.hint,
          }, `${entry.label} ${dream.scores[entry.key] ?? 1}`))),
          dream.tags.length > 0
            ? h('div', { key: 'tags', className: 'ib-meta-line' }, dream.tags.map((tag) => h('span', { key: tag, className: 'ib-tag' }, tag)))
            : null,
          field(t('dream.problem'), dream.problem),
          field(t('dream.targetUser'), dream.targetUser),
          field(t('dream.value'), dream.value),
          field(t('dream.monetization'), dream.monetization),
          dream.competitive.summary === '' && dream.competitive.competitors.length === 0 ? null : h('div', { key: 'comp', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('dream.competitors')),
            dream.competitive.summary === '' ? null : h('div', { key: 'summary', className: 'ib-section-text' }, dream.competitive.summary),
            ...dream.competitive.competitors.map((entry) => h('div', { key: entry.name, className: 'ib-competitor' }, [
              h('div', { key: 'name', className: 'ib-competitor-name' }, entry.name),
              h('div', { key: 'pricing' }, entry.pricing),
              entry.gap === '' ? null : h('div', { key: 'gap', className: 'ib-revisions' }, `${t('dream.competitorGap')}: ${entry.gap}`),
            ])),
          ]),
          field(t('dream.architecture'), dream.architecture),
          dream.mvpScope.length === 0 ? null : h('div', { key: 'mvp', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('dream.mvp')),
            h('ul', { key: 'list', className: 'ib-section-list' }, dream.mvpScope.map((entry, index) => h('li', { key: index }, entry))),
          ]),
          field(t('dream.effort'), dream.effort),
          sources.length === 0 ? null : h('div', { key: 'sources', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('dream.sourcesTitle')),
            h('div', { key: 'list', className: 'ib-sources' }, sources),
          ]),
          revisions.length === 0 ? null : h('div', { key: 'rev', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('dream.revisions')),
            h('div', { key: 'list', className: 'ib-revisions' }, revisions.map((entry, index) => h('div', {
              key: index,
              className: 'ib-revision',
            }, `${new Date(entry.at).toLocaleDateString()} — ${entry.change}`))),
          ]),
          action === 'pursue'
            ? h('div', { key: 'confirm', className: 'ib-confirm' }, [
              h('div', { key: 'text', className: 'ib-confirm-text' }, t('dream.pursueConfirm')),
              h('div', { key: 'row', className: 'ib-confirm-row' }, [
                h('button', {
                  key: 'go',
                  type: 'button',
                  className: 'ib-button',
                  'data-primary': true,
                  disabled: busy,
                  onClick: () => { void act(PURSUE_ROUTE, { id: dream.id }, 'dream.pursued') },
                }, t('dream.pursueAction')),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'ib-button',
                  disabled: busy,
                  onClick: () => setAction(null),
                }, t('dream.cancel')),
              ]),
            ])
            : action === 'discard'
              ? h('div', { key: 'discard', className: 'ib-confirm' }, [
                h('div', { key: 'row', className: 'ib-confirm-row' }, [
                  h('input', {
                    key: 'reason',
                    className: 'ib-reason',
                    value: discardReason,
                    maxLength: 300,
                    placeholder: t('dream.discardReason'),
                    'aria-label': t('dream.discardReason'),
                    onChange: (event) => setDiscardReason(event.target.value),
                  }),
                  h('button', {
                    key: 'go',
                    type: 'button',
                    className: 'ib-button',
                    'data-danger': true,
                    disabled: busy,
                    onClick: () => { void act(DISCARD_ROUTE, { id: dream.id, reason: discardReason }, 'dream.discarded') },
                  }, t('dream.discardAction')),
                  h('button', {
                    key: 'cancel',
                    type: 'button',
                    className: 'ib-button',
                    disabled: busy,
                    onClick: () => setAction(null),
                  }, t('dream.cancel')),
                ]),
              ])
              : h('div', { key: 'actions', className: 'ib-actions' }, [
                h('button', {
                  key: 'pursue',
                  type: 'button',
                  className: 'ib-button',
                  'data-primary': true,
                  disabled: busy,
                  onClick: () => setAction('pursue'),
                }, t('dream.pursue')),
                h('button', {
                  key: 'discard',
                  type: 'button',
                  className: 'ib-button',
                  'data-danger': true,
                  disabled: busy,
                  onClick: () => setAction('discard'),
                }, t('dream.discard')),
              ]),
          boardNotice !== null ? h('div', { key: 'notice', className: 'ib-banner' }, boardNotice) : null,
        ])
      }

      /** The Nightmares tab list view. */
      const nightmareList = () => {
        const scan = nightmareScan(t, nightmareBoard)
        /** Open one entry and clear any pending keep decision. */
        const select = (entry) => {
          setNightmareId(entry.id)
          setNightmareComment('')
          setNightmareKeep(false)
          setNightmareNotice(null)
        }
        const row = (entry) => h('div', {
          key: entry.id,
          role: 'button',
          tabIndex: 0,
          className: 'ib-nightmare-item',
          'data-open': isUndecided(entry) || undefined,
          'data-decided': isUndecided(entry) ? undefined : true,
          onClick: () => select(entry),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            select(entry)
          },
        }, [
          h('div', { key: 'top', className: 'ib-nightmare-top' }, [
            h('span', {
              key: 'sev',
              className: 'ib-severity',
              'data-severity': entry.severity,
              title: severityLabel(t, entry.severity),
            }),
            h('span', { key: 'check', className: 'ib-nightmare-check', title: entry.checkId }, entry.checkId),
            h('span', { key: 'summary', className: 'ib-nightmare-title', title: entry.summary }, entry.summary),
            h('span', { key: 'status', className: 'ib-chip', 'data-status': entry.status }, nightmareStatusLabel(t, entry.status)),
          ]),
          h('div', { key: 'meta', className: 'ib-nightmare-meta' }, [
            typeof entry.group === 'string' && entry.group !== '' ? h('span', { key: 'group' }, entry.group) : null,
            h('span', { key: 'occ' }, t('nightmare.occurrences', { count: entry.occurrences })),
            h('span', { key: 'seen' }, shortDate(entry.lastSeen)),
            isUndecided(entry) ? h('button', {
              key: 'squash',
              type: 'button',
              className: 'ib-link ib-nightmare-squash',
              disabled: nightmareBusy,
              title: entry.status === 'accepted' ? t('nightmare.squashStarted') : undefined,
              onClick: (event) => {
                event.stopPropagation()
                void squashNightmare(entry.id)
              },
            }, t('nightmare.squashAction')) : null,
          ]),
        ])
        const section = (key, label, entries) => entries.length === 0 ? null : h('div', { key, className: 'ib-group' }, [
          h('div', { key: 'head', className: 'ib-group-head' }, [
            h('span', { key: 'label' }, label),
            h('span', { key: 'count', className: 'ib-group-count' }, entries.length),
          ]),
          ...entries.map(row),
        ])
        const empty = h('div', { key: 'empty', className: 'ib-empty' }, [
          h('div', { key: 'line' }, t('nightmare.empty')),
          scan === null ? null : h('div', { key: 'scan' }, scan),
        ])
        const toolbarText = doctorRunning
          ? t('nightmare.running')
          : scan === null ? t('nightmare.noScan') : scan
        return h('div', { key: 'nightmares', className: 'ib-nightmares', role: 'tabpanel' }, [
          h('div', { key: 'toolbar', className: 'ib-nightmare-toolbar' }, [
            h('span', { key: 'scan', className: 'ib-nightmare-scan' }, toolbarText),
            h('span', { key: 'spacer', className: 'ib-spacer' }),
            h('button', {
              key: 'run',
              type: 'button',
              className: 'ib-iconbtn',
              title: t('nightmare.runDoctor'),
              'aria-label': t('nightmare.runDoctor'),
              disabled: nightmareBusy || doctorRunning,
              onClick: () => { void runDoctorNow() },
            }, h(PlayIcon, { key: 'icon' })),
          ]),
          nightmareError
            ? h('div', { key: 'err', className: 'ib-banner', 'data-error': true }, [
              h('span', { key: 'text' }, t('nightmare.loadFailed')),
              h('button', { key: 'retry', type: 'button', className: 'ib-link', onClick: () => { void loadNightmares(false) } }, t('error.retry')),
            ])
            : null,
          nightmareNotice !== null ? h('div', { key: 'notice', className: 'ib-banner' }, nightmareNotice) : null,
          nightmareBoard === null
            ? h('div', { key: 'loading', className: 'ib-empty' }, t('nightmare.loading'))
            : nightmares.length === 0
              ? empty
              : [
                openNightmares.length === 0 ? empty : null,
                section('open', t('nightmare.groupOpen'), openNightmares),
                section('decided', t('nightmare.groupDecided'), decidedNightmares),
              ],
        ])
      }

      /** The Nightmares tab detail view for one selected finding. */
      const nightmareDetail = (entry) => {
        const evidence = Array.isArray(entry.evidence) ? entry.evidence : []
        const history = Array.isArray(entry.history) ? entry.history : []
        const fix = entry.fix === undefined ? null : entry.fix
        const decision = entry.decision === undefined ? null : entry.decision
        const decided = !isUndecided(entry)
        const commentMissing = nightmareComment.trim() === ''
        const decisionButton = (action, label, options) => h('button', {
          key: action,
          type: 'button',
          className: 'ib-button',
          'data-primary': options && options.primary ? true : undefined,
          'data-danger': options && options.danger ? true : undefined,
          disabled: nightmareBusy || (options && options.needsComment ? commentMissing : false),
          onClick: () => { void decideNightmare(action) },
        }, label)
        return h('div', { key: 'detail', className: 'ib-nightmare-detail', role: 'tabpanel' }, [
          h('div', { key: 'head', className: 'ib-detail-head' }, [
            h('button', {
              key: 'back',
              type: 'button',
              className: 'ib-iconbtn',
              title: t('nightmare.back'),
              'aria-label': t('nightmare.back'),
              onClick: () => setNightmareId(null),
            }, h(ChevronIcon, { key: 'icon', dir: 'left' })),
            h('div', { key: 'title', className: 'ib-detail-title' }, typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.summary),
            h('span', {
              key: 'sev',
              className: 'ib-severity',
              'data-severity': entry.severity,
              title: severityLabel(t, entry.severity),
            }),
          ]),
          h('div', { key: 'meta', className: 'ib-nightmare-meta' }, [
            h('span', { key: 'status', className: 'ib-chip', 'data-status': entry.status }, nightmareStatusLabel(t, entry.status)),
            h('span', { key: 'sev', className: 'ib-chip' }, severityLabel(t, entry.severity)),
            h('span', { key: 'check', className: 'ib-chip ib-nightmare-check' }, entry.checkId),
            typeof entry.group === 'string' && entry.group !== '' ? h('span', { key: 'group', className: 'ib-chip' }, entry.group) : null,
            h('span', { key: 'occ', className: 'ib-chip' }, t('nightmare.occurrences', { count: entry.occurrences })),
          ]),
          h('div', { key: 'seen', className: 'ib-meta-line' }, [
            h('span', { key: 'seen' }, t('nightmare.seen', { first: shortDate(entry.firstSeen), last: shortDate(entry.lastSeen) })),
          ]),
          field(t('nightmare.summary'), entry.summary, { key: 'summary' }),
          evidence.length === 0 ? null : h('div', { key: 'evidence', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('nightmare.evidence')),
            ...evidence.map((item, index) => h('div', { key: `e${index}`, className: 'ib-nightmare-evidence' }, [
              h('div', { key: 'path', className: 'ib-nightmare-path' }, item.path),
              typeof item.detail === 'string' && item.detail !== ''
                ? h('div', { key: 'detail', className: 'ib-section-text' }, item.detail)
                : null,
            ])),
          ]),
          fix === null ? null : h('div', { key: 'fix', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('nightmare.fixTitle')),
            h('div', { key: 'type', className: 'ib-section-text ib-nightmare-path' }, t('nightmare.fixType', { type: fix.type })),
            typeof fix.summary === 'string' && fix.summary !== ''
              ? h('div', { key: 'summary', className: 'ib-section-text' }, fix.summary)
              : null,
            Array.isArray(fix.steps) && fix.steps.length > 0
              ? h('ol', { key: 'steps', className: 'ib-section-list' }, fix.steps.map((step, index) => h('li', { key: index }, step)))
              : null,
          ]),
          decision === null ? null : h('div', { key: 'decision', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('nightmare.decision')),
            h('div', { key: 'meta', className: 'ib-nightmare-history-line' }, [
              nightmareStatusLabel(t, ACTION_STATUS[decision.action] ?? 'open'),
              ` · ${shortDate(decision.at)}`,
              typeof decision.by === 'string' && decision.by !== '' ? ` · ${decision.by}` : '',
            ].join('')),
            typeof decision.comment === 'string' && decision.comment !== ''
              ? h('div', { key: 'comment', className: 'ib-section-text' }, decision.comment)
              : null,
          ]),
          history.length === 0 ? null : h('div', { key: 'history', className: 'ib-section' }, [
            h('div', { key: 'label', className: 'ib-section-label' }, t('nightmare.history')),
            ...history.map((item, index) => h('div', { key: index, className: 'ib-nightmare-history-line' }, [
              h('div', { key: 'move' }, item.from === null || item.from === undefined
                ? `${shortDate(item.at)} — ${nightmareStatusLabel(t, item.to)}`
                : `${shortDate(item.at)} — ${nightmareStatusLabel(t, item.from)} → ${nightmareStatusLabel(t, item.to)}`),
              typeof item.comment === 'string' && item.comment !== ''
                ? h('div', { key: 'comment', className: 'ib-nightmare-hint' }, item.comment)
                : null,
            ])),
          ]),
          h('div', { key: 'decide', className: 'ib-confirm' }, [
            h('div', { key: 'row', className: 'ib-actions' }, [
              decided
                ? decisionButton('reopen', t('nightmare.reopenAction'))
                : h('button', {
                  key: 'squash',
                  type: 'button',
                  className: 'ib-button',
                  'data-primary': true,
                  disabled: nightmareBusy,
                  onClick: () => { void squashNightmare(entry.id) },
                }, t('nightmare.squashAction')),
              nightmareKeep ? null : h('button', {
                key: 'keep',
                type: 'button',
                className: 'ib-button',
                disabled: nightmareBusy,
                onClick: () => {
                  setNightmareKeep(true)
                  setNightmareNotice(null)
                },
              }, t('nightmare.keepAction')),
            ]),
            nightmareKeep
              ? h('div', { key: 'keepPanel', className: 'ib-nightmare-keep' }, [
                h('div', { key: 'label', className: 'ib-section-label' }, t('nightmare.comment')),
                h('textarea', {
                  key: 'comment',
                  className: 'ib-nightmare-comment',
                  value: nightmareComment,
                  maxLength: 500,
                  placeholder: t('nightmare.commentPlaceholder'),
                  'aria-label': t('nightmare.comment'),
                  disabled: nightmareBusy,
                  autoFocus: true,
                  onChange: (event) => setNightmareComment(event.target.value),
                }),
                commentMissing ? h('div', { key: 'hint', className: 'ib-nightmare-hint' }, t('nightmare.keepHint')) : null,
                h('div', { key: 'row', className: 'ib-actions' }, [
                  h('button', {
                    key: 'cancel',
                    type: 'button',
                    className: 'ib-button',
                    disabled: nightmareBusy,
                    onClick: () => { setNightmareKeep(false); setNightmareComment(''); setNightmareNotice(null) },
                  }, t('nightmare.back')),
                  decisionButton('ignore', t('nightmare.ignoreAction'), { needsComment: true, primary: true }),
                  decisionButton('remove', t('nightmare.removeAction'), { needsComment: true, danger: true }),
                ]),
              ])
              : null,
          ]),
          nightmareNotice !== null ? h('div', { key: 'notice', className: 'ib-banner' }, nightmareNotice) : null,
        ])
      }

      const body = tab === 'nightmares'
        ? wideLayout
          ? h('div', { key: 'split', className: 'ib-dream-split' }, [
            h('div', { key: 'left', className: 'ib-dream-left' }, nightmareList()),
            h('div', { key: 'right', className: 'ib-dream-right' }, selectedNightmare === null
              ? h('div', { key: 'hint', className: 'ib-dream-hint' }, t('nightmare.selectHint'))
              : nightmareDetail(selectedNightmare)),
          ])
          : selectedNightmare === null ? nightmareList() : nightmareDetail(selectedNightmare)
        : tab === 'dreams'
        ? wideLayout
          ? h('div', { key: 'split', className: 'ib-dream-split' }, [
            h('div', { key: 'left', className: 'ib-dream-left' }, dreamList()),
            h('div', { key: 'right', className: 'ib-dream-right' }, selected === null
              ? h('div', { key: 'hint', className: 'ib-dream-hint' }, t('dream.selectHint'))
              : dreamDetail(selected)),
          ])
          : selected === null ? dreamList() : dreamDetail(selected)
        : h(React.Fragment, null, [
          h('form', { key: 'compose', className: 'ib-compose', onSubmit: addItem }, [
            h('input', {
              key: 'input',
              ref: inputRef,
              className: 'ib-input',
              value: draft,
              placeholder: t('input.placeholder'),
              'aria-label': t('input.placeholder'),
              maxLength: 500,
              spellCheck: false,
              onChange: (event) => setDraft(event.target.value),
            }),
            h('button', {
              key: 'add',
              type: 'submit',
              className: 'ib-add',
              disabled: draft.trim() === '',
              title: t('input.add'),
              'aria-label': t('input.add'),
            }, h(PlusIcon, { key: 'mark' })),
          ]),
          phase === 'offline'
            ? h('div', { key: 'offline', className: 'ib-banner' }, [
              h('span', { key: 'text' }, t('error.load')),
              h('button', {
                key: 'retry',
                type: 'button',
                className: 'ib-link',
                onClick: () => { void load() },
              }, t('error.retry')),
            ])
            : null,
          notice !== null ? h('div', { key: 'notice', className: 'ib-banner' }, notice) : null,
          phase === 'loading'
            ? h('div', { key: 'loading', className: 'ib-empty' }, t('list.loading'))
            : h('ul', { key: 'list', className: 'ib-list', role: 'list' }, rows),
        ])

      const footer = tab === 'nightmares'
        ? h('div', { key: 'foot', className: 'ib-foot' }, [
          h('span', { key: 'counts' }, t('nightmare.counts', {
            open: nightmareCounts.open,
            accepted: nightmareCounts.accepted,
            fixed: nightmareCounts.fixed,
          })),
          h('span', { key: 'spacer', className: 'ib-spacer' }),
          nightmareScan(t, nightmareBoard),
        ])
        : tab === 'dreams'
        ? h('div', { key: 'foot', className: 'ib-foot' }, [
          h('span', { key: 'counts' }, board === null
            ? t('dream.empty')
            : t('dream.cap', { count: board.counts.active, cap: board.caps.maxActiveDreams })),
          h('span', { key: 'spacer', className: 'ib-spacer' }),
          boardNote(t, board),
        ])
        : h('div', { key: 'foot', className: 'ib-foot' }, [
          h('span', { key: 'counts' }, t('foot.counts', { open: openCount, done: doneCount })),
          doneCount > 0
            ? h('button', { key: 'clear', type: 'button', className: 'ib-link', onClick: clearDone }, t('foot.clear'))
            : null,
          h('span', { key: 'spacer', className: 'ib-spacer' }),
          saveError
            ? h('span', { key: 'error', className: 'ib-save-error' }, t('foot.saveFailed'))
            : saving ? h('span', { key: 'saving' }, t('foot.saving')) : null,
        ])

      const handles = (docked ? ['n'] : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']).map((direction) => h('div', {
        key: direction,
        className: `ib-resize ib-resize-${direction}`,
        title: t('panel.resize'),
        'aria-hidden': 'true',
        onPointerDown: startResize(direction),
      }))

      const card = h('div', {
        key: 'card',
        ref: cardRef,
        className: docked ? 'ib-card ib-dock' : 'ib-card ib-float',
        style: { ...anchor, ...sizeStyle },
        'data-wide': wideLayout || undefined,
        'data-dock': docked || undefined,
        role: 'region',
        'aria-label': panelTitle,
      }, [
        h('div', {
          key: 'header',
          className: 'ib-header',
          'data-dragging': drag !== null && !docked || undefined,
          onPointerDown: startDrag,
        }, [
          h(BulbIcon, { key: 'icon' }),
          h('span', { key: 'title', className: 'ib-title' }, panelTitle),
          h('span', { key: 'count', className: 'ib-count' }, headerCount),
          h('span', { key: 'spacer', className: 'ib-spacer' }),
          docked ? null : h('button', {
            key: 'wide',
            type: 'button',
            className: 'ib-iconbtn',
            title: ui.wide ? t('panel.wideOff') : t('panel.wideOn'),
            'aria-label': ui.wide ? t('panel.wideOff') : t('panel.wideOn'),
            onClick: () => setUi({ wide: !ui.wide, width: null, height: null }),
          }, ui.wide ? h(RestoreIcon, { key: 'mark' }) : h(ExpandIcon, { key: 'mark' })),
          h('button', {
            key: 'dock',
            type: 'button',
            className: 'ib-iconbtn',
            title: ui.docked ? t('panel.undock') : t('panel.dock'),
            'aria-label': ui.docked ? t('panel.undock') : t('panel.dock'),
            onClick: () => setUi(ui.docked
              ? { docked: false }
              : { docked: true, collapsed: false, height: null }),
          }, ui.docked ? h(RestoreIcon, { key: 'mark' }) : h(DockIcon, { key: 'mark' })),
          h('button', {
            key: 'collapse',
            type: 'button',
            className: 'ib-iconbtn',
            title: t('panel.collapse'),
            'aria-label': t('panel.collapse'),
            onClick: () => setUi({ collapsed: true }),
          }, h(ChevronIcon, { key: 'mark', dir: 'down' })),
        ]),
        h('div', { key: 'tabs', className: 'ib-tabs', role: 'tablist' }, [
          tabButton('ideas', t('tab.ideas')),
          tabButton('dreams', t('tab.dreams', { count: board === null ? 0 : board.counts.active }), board !== null && board.counts.ready > 0 ? board.counts.ready : undefined),
          tabButton('nightmares', t('tab.nightmares', { count: nightmareCounts.open }), nightmareCounts.open > 0 ? nightmareCounts.open : undefined),
        ]),
        h('div', { key: 'body', className: 'ib-body' }, body),
        footer,
        ...handles,
      ])

      const style = h('style', { key: 'css' }, CSS)
      if (docked) {
        if (seatState.el !== null && seatState.wide) {
          return h(React.Fragment, null, style, createPortal(card, seatState.el))
        }
        return style
      }
      return h(React.Fragment, null, style, card)
    }

    /** Small right-side footer note for the Dreams tab. */
    function boardNote(t, board) {
      if (board === null) return null
      if (board.schedule.available === false) return h('span', { key: 'sched', className: 'ib-save-error' }, t('dream.schedule', { status: 'unavailable' }))
      if (board.lastRun !== null) {
        return h('span', { key: 'run' }, new Date(board.lastRun.at).toLocaleDateString())
      }
      return h('span', { key: 'none' }, t('dream.noRun'))
    }

    /** Last ingest line for the Nightmares tab, or null before the first scan. */
    function nightmareScan(t, board) {
      if (board === null || board.lastIngestAt === null || board.lastIngestAt === undefined) return null
      const parts = [t('nightmare.lastScan', { date: shortDate(board.lastIngestAt) })]
      if (typeof board.lastSource === 'string' && board.lastSource !== '') parts.push(t('nightmare.source', { source: board.lastSource }))
      return h('span', { key: 'scan', className: 'ib-nightmare-scan' }, parts.join(' · '))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'idea-board: copy')
        const seat = createDockSeat()
        const Board = (props) => h(IdeaBoard, { ...props, seat })
        const Seat = (props) => h(DockSeat, { ...props, seat })
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'idea-board',
          order: 20,
          locale: NS,
        }, Board))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'idea-board',
          order: 10,
          locale: NS,
        }, Seat))
      },
    }
  },
})
