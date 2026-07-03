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
  'app.context': { 'zh-CN': '上下文', en: 'Context' },
  'app.controlledTabs': { 'zh-CN': '受控标签页', en: 'Controlled tabs' },
  'app.queued': { 'zh-CN': '队列 {n} 条', en: '{n} queued' },
  'app.noUsage': { 'zh-CN': '本轮暂无用量数据', en: 'No usage data yet' },

  // Composer
  'input.placeholder': { 'zh-CN': '给 Panelot 发消息… (@ 引用 / 命令)', en: 'Message Panelot… (@ mention / command)' },
  'input.running': { 'zh-CN': '输入以插话，Esc 停止…', en: 'Type to steer, Esc to stop…' },
  'input.noProvider': { 'zh-CN': '先在设置中添加模型 →', en: 'Add a model in settings first →' },
  'input.send': { 'zh-CN': '发送', en: 'Send' },
  'input.stop': { 'zh-CN': '停止', en: 'Stop' },
  'input.hintIdle': { 'zh-CN': 'Enter 发送 · Shift+Enter 换行', en: 'Enter to send · Shift+Enter for newline' },
  'input.hintRunning': { 'zh-CN': 'Enter 插话 · Shift+Alt+Enter 排队 · Esc 停止', en: 'Enter to steer · Shift+Alt+Enter to queue · Esc to stop' },
  'input.steered': { 'zh-CN': '已插话，将在下次模型调用前生效', en: 'Steered — applies before the next model call' },
  'input.queuedInstead': { 'zh-CN': '当前轮不可插话，已加入队列', en: 'Turn not steerable — queued instead' },
  'input.queuedCount': { 'zh-CN': '队列中 {n} 条消息', en: '{n} messages queued' },
  'input.remove': { 'zh-CN': '移除 {label}', en: 'Remove {label}' },

  // Approval
  'approval.allow': { 'zh-CN': '允许', en: 'Allow' },
  'approval.allowOnce': { 'zh-CN': '允许一次', en: 'Allow once' },
  'approval.allowSite': { 'zh-CN': '本站始终', en: 'Always on this site' },
  'approval.decline': { 'zh-CN': '拒绝', en: 'Decline' },
  'approval.crossScope': { 'zh-CN': '越出任务作用域 — 该操作的目标不在本任务已触达的站点内', en: 'Outside task scope — target site was not touched by this task yet' },
  'approval.sensitive': { 'zh-CN': '检测到敏感内容外发 — 参数中含疑似凭据/卡号/邮箱', en: 'Sensitive payload — params contain what looks like credentials/card numbers/emails' },
  'approval.escalation': { 'zh-CN': '将升级为调试模式 — 页面顶部会出现「正在调试此浏览器」横幅', en: 'Escalates to debugger mode — Chrome will show its debugging banner' },
  'approval.request': { 'zh-CN': '审批请求：{label}', en: 'Approval request: {label}' },

  // Banners
  'reconnecting': { 'zh-CN': '重新连接引擎…', en: 'Reconnecting to engine…' },
  'recovery.interrupted': { 'zh-CN': '任务此前被中断（可能是浏览器休眠）。', en: 'The task was interrupted (browser may have slept).' },
  'recovery.continue': { 'zh-CN': '继续', en: 'Continue' },
  'error.retry': { 'zh-CN': '重试', en: 'Retry' },
  'error.openSettings': { 'zh-CN': '打开设置', en: 'Open settings' },

  // Provider error attribution (docs/03 §7)
  'error.auth': { 'zh-CN': 'API Key 无效或已过期 — 检查设置中的 Key', en: 'Invalid or expired API key — check it in settings' },
  'error.rate_limit': { 'zh-CN': '触发限流 — 稍后自动可重试，或添加备用 Key', en: 'Rate limited — retry shortly or add a backup key' },
  'error.overloaded': { 'zh-CN': '模型服务过载 — 稍后重试', en: 'Model service overloaded — retry later' },
  'error.context_too_long': { 'zh-CN': '上下文超长 — 已尝试压缩仍超限，试试新会话', en: 'Context too long even after compaction — try a new chat' },
  'error.content_filter': { 'zh-CN': '内容被模型服务拦截', en: 'Content blocked by the model service' },
  'error.network': { 'zh-CN': '网络异常 — 检查网络或代理设置', en: 'Network error — check connectivity or proxy' },
  'error.protocol': { 'zh-CN': '端点协议不符 — 检查连接的 API 风格配置', en: 'Protocol mismatch — check the connection API style' },

  // Empty state
  'empty.title': { 'zh-CN': '今天想做点什么？', en: 'What shall we do today?' },
  'empty.hint': { 'zh-CN': '直接提问，或用 @ 引用当前页面，让 Panelot 帮你在浏览器里动手。', en: 'Ask anything, or use @ to reference this page and let Panelot operate the browser for you.' },

  // Message stream
  'stream.backToBottom': { 'zh-CN': '↓ 回到底部', en: '↓ Back to bottom' },
  'stream.reasoning': { 'zh-CN': '思考过程', en: 'Reasoning' },
  'stream.reasoningLive': { 'zh-CN': '思考中…', en: 'Thinking…' },
  'stream.compacted': { 'zh-CN': '上下文已压缩（{before} → {after} tokens）', en: 'Context compacted ({before} → {after} tokens)' },
  'stream.branchSummary': { 'zh-CN': '已弃分支摘要', en: 'Abandoned branch summary' },
  'stream.steps': { 'zh-CN': '{n} 步浏览器操作', en: '{n} browser steps' },
};

let currentLang: Lang = detectLang();

function detectLang(): Lang {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) return 'zh-CN';
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('en') ? 'en' : 'zh-CN';
}

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: keyof typeof STRINGS | string, vars?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  let text = entry ? entry[currentLang] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}
