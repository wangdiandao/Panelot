/**
 * Minimal i18n (docs/09 §8): zh-CN / en string tables, browser-language
 * default. Kept dependency-free — the UI is small enough that a keyed lookup
 * with interpolation covers it.
 */

type Lang = 'zh-CN' | 'en';

const STRINGS: Record<string, { 'zh-CN': string; en: string }> = {
  // App chrome
  'app.newChat': { 'zh-CN': '新会话', en: 'New chat' },
  'app.settings': { 'zh-CN': '设置', en: 'Settings' },
  'app.expand': { 'zh-CN': '展开全屏', en: 'Expand to full page' },
  'app.searchThreads': { 'zh-CN': '搜索会话', en: 'Search chats' },
  'app.recentThreads': { 'zh-CN': '最近会话', en: 'Recent chats' },
  'app.noThreads': { 'zh-CN': '暂无历史会话', en: 'No chats yet' },
  'app.untitled': { 'zh-CN': '未命名会话', en: 'Untitled chat' },
  'app.attachPage': { 'zh-CN': '＋ 附着到对话', en: '+ Attach to chat' },
  'app.taskPanel': { 'zh-CN': '任务面板', en: 'Task panel' },
  'app.hideTaskPanel': { 'zh-CN': '隐藏任务面板', en: 'Hide task panel' },
  'app.pin': { 'zh-CN': '置顶', en: 'Pin' },
  'app.unpin': { 'zh-CN': '取消置顶', en: 'Unpin' },
  'app.rename': { 'zh-CN': '重命名', en: 'Rename' },
  'app.delete': { 'zh-CN': '删除', en: 'Delete' },
  'app.cancel': { 'zh-CN': '取消', en: 'Cancel' },
  'app.save': { 'zh-CN': '保存', en: 'Save' },
  'app.agentTabs': { 'zh-CN': 'Agent 操作过的标签页', en: 'Tabs the agent worked on' },
  'app.queued': { 'zh-CN': '队列 {n} 条', en: '{n} queued' },
  'app.noTasks': { 'zh-CN': '暂无规划任务', en: 'No tasks planned yet' },
  'app.taskPanelHint': {
    'zh-CN': '输入 /plan 让 AI 制定执行计划',
    en: 'Type /plan for the AI to outline a plan',
  },
  // Plan confirm card
  'plan.ready': {
    'zh-CN': '计划已就绪，请确认后开始执行',
    en: 'Plan ready — confirm to start execution',
  },
  'plan.confirm': { 'zh-CN': '确认并执行', en: 'Confirm & execute' },
  'plan.edit': { 'zh-CN': '调整后执行', en: 'Edit first' },
  'plan.cancel': { 'zh-CN': '放弃计划', en: 'Discard plan' },
  'plan.collapse': { 'zh-CN': '收起步骤', en: 'Collapse steps' },
  'plan.expand': { 'zh-CN': '展开步骤', en: 'Expand steps' },
  'plan.confirmMsg': {
    'zh-CN': '计划已确认，请按步骤执行。',
    en: 'Plan confirmed, please proceed step by step.',
  },
  'cmd.planHint': {
    'zh-CN': '让 AI 先制定分步计划，再逐步执行',
    en: 'Ask the AI to outline a step-by-step plan before acting',
  },
  'cmd.planPrompt': {
    'zh-CN':
      '请先用中文制定一份分步执行计划，每步用 todo_write 工具写入任务列表，计划确认后再开始执行。',
    en: 'Please outline a step-by-step plan first. Write each step into the task list using todo_write, then begin execution once the plan is confirmed.',
  },
  'app.noMatchingThreads': { 'zh-CN': '没有匹配的会话', en: 'No matching chats' },
  'app.collapseSidebar': { 'zh-CN': '收起侧边栏', en: 'Collapse sidebar' },
  'app.expandSidebar': { 'zh-CN': '展开侧边栏', en: 'Expand sidebar' },
  'app.resizeSidebar': { 'zh-CN': '调整侧边栏宽度（←/→）', en: 'Resize sidebar (←/→)' },
  'app.threadMenu': { 'zh-CN': '会话「{title}」操作', en: 'Actions for "{title}"' },
  'app.unread': { 'zh-CN': '有新内容', en: 'Unread' },
  'app.running': { 'zh-CN': '任务运行中', en: 'Task running' },
  'app.needsApproval': { 'zh-CN': '等待审批', en: 'Awaiting approval' },
  'app.deleteConfirmTitle': { 'zh-CN': '删除会话？', en: 'Delete this chat?' },
  'app.deleteConfirmBody': { 'zh-CN': '删除后不可恢复。', en: 'This cannot be undone.' },

  // Time-ago labels (compact, OpenWebUI-style)
  'time.now': { 'zh-CN': '刚刚', en: 'now' },
  'time.m': { 'zh-CN': '{n}分钟', en: '{n}m' },
  'time.h': { 'zh-CN': '{n}小时', en: '{n}h' },
  'time.d': { 'zh-CN': '{n}天', en: '{n}d' },
  'time.w': { 'zh-CN': '{n}周', en: '{n}w' },

  // Sidebar time groups
  'group.pinned': { 'zh-CN': '置顶', en: 'Pinned' },
  'group.today': { 'zh-CN': '今天', en: 'Today' },
  'group.yesterday': { 'zh-CN': '昨天', en: 'Yesterday' },
  'group.week': { 'zh-CN': '本周', en: 'This week' },
  'group.older': { 'zh-CN': '更早', en: 'Older' },

  // Composer
  'input.placeholder': {
    'zh-CN': '给 Panelot 发消息… (@ 引用 / 命令)',
    en: 'Message Panelot… (@ mention / command)',
  },
  'input.running': { 'zh-CN': '输入以插话，Esc 停止…', en: 'Type to steer, Esc to stop…' },
  'input.noProvider': { 'zh-CN': '先在设置中添加模型 →', en: 'Add a model in settings first →' },
  'input.send': { 'zh-CN': '发送', en: 'Send' },
  'input.stop': { 'zh-CN': '停止', en: 'Stop' },
  'input.hintIdle': {
    'zh-CN': 'Enter 发送 · Shift+Enter 换行',
    en: 'Enter to send · Shift+Enter for newline',
  },
  'input.hintRunning': {
    'zh-CN': 'Enter 插话 · Shift+Alt+Enter 排队 · Esc 停止',
    en: 'Enter to steer · Shift+Alt+Enter to queue · Esc to stop',
  },
  'input.steered': {
    'zh-CN': '已插话，将在下次模型调用前生效',
    en: 'Steered — applies before the next model call',
  },
  'input.queuedInstead': {
    'zh-CN': '当前轮不可插话，已加入队列',
    en: 'Turn not steerable — queued instead',
  },
  'input.queuedCount': { 'zh-CN': '队列中 {n} 条消息', en: '{n} messages queued' },
  'input.remove': { 'zh-CN': '移除 {label}', en: 'Remove {label}' },
  'input.attach': { 'zh-CN': '添加', en: 'Add' },
  'input.attachPage': { 'zh-CN': '引用页面', en: 'Attach page' },
  'input.noTabs': { 'zh-CN': '没有可引用的标签页', en: 'No tabs available' },
  'input.noSkills': { 'zh-CN': '暂无已启用的 Skill', en: 'No enabled skills' },
  'input.pastedText': { 'zh-CN': '粘贴文本（{n} 字符）', en: 'Pasted text ({n} chars)' },

  // Approval
  'approval.allow': { 'zh-CN': '允许', en: 'Allow' },
  'approval.allowOnce': { 'zh-CN': '允许一次', en: 'Allow once' },
  'approval.allowSession': { 'zh-CN': '本轮会话', en: 'This session' },
  'approval.allowSite': { 'zh-CN': '本站始终', en: 'Always on this site' },
  'approval.decline': { 'zh-CN': '拒绝', en: 'Decline' },
  'approval.crossScope': {
    'zh-CN': '越出任务作用域 — 该操作的目标不在本任务已触达的站点内',
    en: 'Outside task scope — target site was not touched by this task yet',
  },
  'approval.sensitive': {
    'zh-CN': '检测到敏感内容外发 — 参数中含疑似凭据/卡号/邮箱',
    en: 'Sensitive payload — params contain what looks like credentials/card numbers/emails',
  },
  'approval.escalation': {
    'zh-CN': '将升级为调试模式 — 页面顶部会出现「正在调试此浏览器」横幅',
    en: 'Escalates to debugger mode — Chrome will show its debugging banner',
  },
  'approval.request': { 'zh-CN': '审批请求：{label}', en: 'Approval request: {label}' },

  // Banners
  reconnecting: { 'zh-CN': '重新连接引擎…', en: 'Reconnecting to engine…' },
  'recovery.interrupted': {
    'zh-CN': '任务此前被中断（可能是浏览器休眠）。',
    en: 'The task was interrupted (browser may have slept).',
  },
  'recovery.continue': { 'zh-CN': '继续', en: 'Continue' },
  'recovery.budget': {
    'zh-CN': '任务已在预算边界暂停。',
    en: 'The task paused at its budget boundary.',
  },
  'recovery.uncertain': {
    'zh-CN': '浏览器重启前写操作已开始，结果状态未知。请确认后继续。',
    en: 'A write started before restart and its outcome is unknown. Confirm before continuing.',
  },
  'recovery.retry': { 'zh-CN': '重新执行', en: 'Run again' },
  'recovery.completed': { 'zh-CN': '已完成', en: 'It completed' },
  'recovery.failed': { 'zh-CN': '标记失败', en: 'Mark failed' },
  'error.retry': { 'zh-CN': '重试', en: 'Retry' },
  'error.openSettings': { 'zh-CN': '打开设置', en: 'Open settings' },

  // Provider error attribution (docs/03 §7)
  'error.auth': {
    'zh-CN': 'API Key 无效或已过期 — 检查设置中的 Key',
    en: 'Invalid or expired API key — check it in settings',
  },
  'error.rate_limit': {
    'zh-CN': '触发限流 — 稍后自动可重试，或添加备用 Key',
    en: 'Rate limited — retry shortly or add a backup key',
  },
  'error.overloaded': {
    'zh-CN': '模型服务过载 — 稍后重试',
    en: 'Model service overloaded — retry later',
  },
  'error.context_too_long': {
    'zh-CN': '上下文超长 — 试试新会话',
    en: 'Context too long — try a new chat',
  },
  'error.content_filter': {
    'zh-CN': '内容被模型服务拦截',
    en: 'Content blocked by the model service',
  },
  'error.network': {
    'zh-CN': '网络异常 — 检查网络或代理设置',
    en: 'Network error — check connectivity or proxy',
  },
  'error.protocol': {
    'zh-CN': '端点协议不符 — 检查连接的 API 风格配置',
    en: 'Protocol mismatch — check the connection API style',
  },

  // Shortcut labels (registry-driven help sheet)
  'keys.togglePanel': { 'zh-CN': '开/关侧边栏', en: 'Toggle side panel' },
  'keys.palette': { 'zh-CN': '命令面板（搜会话/命令）', en: 'Command palette' },
  'keys.newChat': { 'zh-CN': '新会话', en: 'New chat' },
  'keys.settings': { 'zh-CN': '打开设置', en: 'Open settings' },
  'keys.expand': { 'zh-CN': '侧边栏 ⇄ 全屏页切换', en: 'Side panel ⇄ full page' },
  'keys.toggleSidebar': { 'zh-CN': '收起/展开会话列表', en: 'Collapse/expand thread list' },
  'keys.help': { 'zh-CN': '本快捷键表', en: 'This shortcut sheet' },
  'keys.send': { 'zh-CN': '发送', en: 'Send' },
  'keys.newline': { 'zh-CN': '换行', en: 'Newline' },
  'keys.steer': { 'zh-CN': '插话（运行中）', en: 'Steer (while running)' },
  'keys.enqueue': { 'zh-CN': '显式排队', en: 'Queue explicitly' },
  'keys.stop': { 'zh-CN': '停止本轮', en: 'Stop the turn' },
  'keys.recallLast': {
    'zh-CN': '召回上一条消息（空输入框）',
    en: 'Recall last message (empty composer)',
  },
  'keys.triggers': { 'zh-CN': '引用 / 命令 / 变量菜单', en: 'Mention / command / variable menus' },
  'keys.branch': { 'zh-CN': '分支切换', en: 'Switch branch' },
  'keys.copyLast': { 'zh-CN': '复制最后一条回复', en: 'Copy last response' },
  'keys.focusComposer': { 'zh-CN': '聚焦输入框', en: 'Focus composer' },
  'keys.approveOnce': { 'zh-CN': '审批：允许一次', en: 'Approval: allow once' },
  'keys.approveSession': { 'zh-CN': '审批：本轮会话', en: 'Approval: this session' },
  'keys.approveSite': { 'zh-CN': '审批：本站始终', en: 'Approval: always on site' },
  'keys.decline': { 'zh-CN': '审批：拒绝', en: 'Approval: decline' },
  'keys.declineStop': { 'zh-CN': '审批：拒绝并停止', en: 'Approval: decline & stop' },
  'keys.scope.global': { 'zh-CN': '全局', en: 'Global' },
  'keys.scope.page': { 'zh-CN': '扩展页', en: 'Extension pages' },
  'keys.scope.composer': { 'zh-CN': '输入框', en: 'Composer' },
  'keys.scope.stream': { 'zh-CN': '消息流', en: 'Message stream' },
  'keys.scope.approval': { 'zh-CN': '审批卡片', en: 'Approval card' },
  'keys.title': { 'zh-CN': '键盘快捷键', en: 'Keyboard shortcuts' },

  // Citations pill
  'citations.count': { 'zh-CN': '读取了 {n} 个页面', en: 'Read {n} pages' },

  // Queue dock
  'queue.title': { 'zh-CN': '队列中 {n} 条', en: '{n} queued' },
  'queue.paused': { 'zh-CN': '等待审批，队列暂停', en: 'Paused for approval' },
  'queue.placeholder': { 'zh-CN': '（排队消息）', en: '(queued message)' },
  'queue.edit': { 'zh-CN': '编辑排队消息', en: 'Edit queued message' },
  'queue.remove': { 'zh-CN': '移除排队消息', en: 'Remove queued message' },

  // Command palette
  'palette.title': { 'zh-CN': '命令面板', en: 'Command palette' },
  'palette.desc': { 'zh-CN': '切换会话、执行命令', en: 'Switch chats, run commands' },
  'palette.placeholder': { 'zh-CN': '搜索会话内容或命令…', en: 'Search chats or commands…' },
  'palette.noResults': { 'zh-CN': '无匹配结果', en: 'No results' },
  'palette.actions': { 'zh-CN': '操作', en: 'Actions' },
  'palette.threads': { 'zh-CN': '会话', en: 'Chats' },

  // Settings
  'settings.search': { 'zh-CN': '搜索设置…', en: 'Search settings…' },
  'settings.noMatch': { 'zh-CN': '无匹配的设置项', en: 'No matching settings' },

  // Permission switch (composer autonomy tiers)
  'perm.switch': { 'zh-CN': '权限模式', en: 'Permission mode' },
  'perm.plan': { 'zh-CN': '计划模式', en: 'Plan mode' },
  'perm.planHint': {
    'zh-CN': 'AI 先制定计划并等待确认，确认后再执行操作',
    en: 'AI plans first and waits for your approval before acting',
  },
  'perm.always': { 'zh-CN': '全程询问', en: 'Ask for everything' },
  'perm.alwaysHint': {
    'zh-CN': '每一步都先征求同意，包括读取页面',
    en: 'Every step asks first, reading included',
  },
  'perm.balanced': { 'zh-CN': '操作询问', en: 'Ask before acting' },
  'perm.balancedHint': {
    'zh-CN': '自由读取；点击/输入等写操作先询问（默认）',
    en: 'Reads freely; clicks/typing ask first (default)',
  },
  'perm.auto': { 'zh-CN': '无需审批', en: 'Act without asking' },
  'perm.autoHint': {
    'zh-CN': '自动执行操作；敏感站点与敏感信息仍会拦截',
    en: 'Acts autonomously; sensitive sites & payloads still guarded',
  },

  // Model selector
  'model.select': { 'zh-CN': '选择模型', en: 'Select model' },
  'model.default': { 'zh-CN': '默认模型', en: 'Default model' },
  'model.defaultHint': { 'zh-CN': '跟随全局默认 / 预设', en: 'Follow global default / preset' },
  'model.search': { 'zh-CN': '搜索模型…', en: 'Search models…' },
  'model.loading': { 'zh-CN': '加载模型…', en: 'Loading models…' },
  'model.noMatch': { 'zh-CN': '没有匹配的模型', en: 'No matching models' },
  'model.none': { 'zh-CN': '暂无可用模型', en: 'No models available' },
  'model.noneHint': {
    'zh-CN': '先添加一个模型连接，即可开始对话',
    en: 'Connect a provider to start chatting',
  },
  'model.manage': { 'zh-CN': '管理连接', en: 'Manage connections' },
  'model.all': { 'zh-CN': '全部', en: 'All' },

  // Empty state
  'empty.title': { 'zh-CN': '今天想做点什么？', en: 'What shall we do today?' },
  'empty.hint': {
    'zh-CN': '直接提问，或用 @ 引用当前页面，让 Panelot 帮你在浏览器里动手。',
    en: 'Ask anything, or use @ to reference this page and let Panelot operate the browser for you.',
  },
  'empty.morning': { 'zh-CN': '早上好', en: 'Good morning' },
  'empty.afternoon': { 'zh-CN': '下午好', en: 'Good afternoon' },
  'empty.evening': { 'zh-CN': '晚上好', en: 'Good evening' },
  'empty.suggested': { 'zh-CN': '试试', en: 'Suggested' },
  // Built-in suggestions (full page)
  'empty.sugSummarize': { 'zh-CN': '总结当前页面', en: 'Summarize the current page' },
  'empty.sugSummarizeHint': {
    'zh-CN': '@ 引用页面后提炼要点',
    en: 'Attach the page and distill key points',
  },
  'empty.sugCompare': { 'zh-CN': '跨标签页比价/比参数', en: 'Compare across open tabs' },
  'empty.sugCompareHint': {
    'zh-CN': '让 Panelot 逐个读取打开的标签页',
    en: 'Panelot reads each open tab for you',
  },
  'empty.sugForm': { 'zh-CN': '帮我填这个表单', en: 'Fill this form for me' },
  'empty.sugFormHint': {
    'zh-CN': '每步写操作都会先征求批准',
    en: 'Every write action asks for approval first',
  },
  'empty.sugExtract': { 'zh-CN': '提取页面数据为表格', en: 'Extract page data as a table' },
  'empty.sugExtractHint': {
    'zh-CN': '结构化抽取正文/列表/表格',
    en: 'Structured extraction of content/lists/tables',
  },
  // Page-type-aware suggestions (side panel)
  'empty.sugVideo': { 'zh-CN': '总结这个视频', en: 'Summarize this video' },
  'empty.sugPdf': { 'zh-CN': '提取这份 PDF 的要点', en: 'Extract key points from this PDF' },
  'empty.sugRepo': { 'zh-CN': '解释这个仓库是做什么的', en: 'Explain what this repository does' },
  'empty.sugPage': { 'zh-CN': '总结此页', en: 'Summarize this page' },

  // Message actions
  'actions.copy': { 'zh-CN': '复制', en: 'Copy' },
  'actions.copied': { 'zh-CN': '已复制', en: 'Copied' },
  'actions.regenerate': { 'zh-CN': '重新生成', en: 'Regenerate' },
  'actions.edit': { 'zh-CN': '编辑', en: 'Edit' },
  'actions.usage': { 'zh-CN': '用量信息', en: 'Usage info' },
  'actions.editHint': {
    'zh-CN': 'Esc 取消 · Ctrl+Enter 重新发送',
    en: 'Esc to cancel · Ctrl+Enter to resend',
  },
  'actions.resend': { 'zh-CN': '重新发送', en: 'Resend' },

  // Message stream
  'stream.backToBottom': { 'zh-CN': '↓ 回到底部', en: '↓ Back to bottom' },
  'stream.reasoning': { 'zh-CN': '思考过程', en: 'Reasoning' },
  'stream.reasoningLive': { 'zh-CN': '思考中…', en: 'Thinking…' },
  'stream.thoughtFor': { 'zh-CN': '思考了 {s} 秒', en: 'Thought for {s}s' },
  'stream.steps': { 'zh-CN': '{n} 步浏览器操作', en: '{n} browser steps' },
  'tool.params': { 'zh-CN': '参数', en: 'Parameters' },
  'tool.result': { 'zh-CN': '结果', en: 'Result' },
  'tool.error': { 'zh-CN': '错误', en: 'Error' },
};

let currentLang: Lang = detectLang();

function detectLang(): Lang {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh'))
    return 'zh-CN';
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('en') ? 'en' : 'zh-CN';
}

export function setLang(lang: Lang): void {
  currentLang = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(
  key: keyof typeof STRINGS | string,
  vars?: Record<string, string | number>,
): string {
  const entry = STRINGS[key];
  let text = entry ? entry[currentLang] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}
