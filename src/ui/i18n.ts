/**
 * Minimal i18n (docs/development/ui.md §8): zh-CN / en string tables with a
 * browser-language default. A dependency-free keyed lookup with interpolation
 * is enough for this UI.
 */

import { useSyncExternalStore } from 'react';
import { onStorageChange, SettingsStore, type GlobalSettings } from '../settings/store';

export type Lang = 'zh-CN' | 'en';

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
  'app.pin': { 'zh-CN': '置顶', en: 'Pin' },
  'app.unpin': { 'zh-CN': '取消置顶', en: 'Unpin' },
  'app.rename': { 'zh-CN': '重命名', en: 'Rename' },
  'app.delete': { 'zh-CN': '删除', en: 'Delete' },
  'app.cancel': { 'zh-CN': '取消', en: 'Cancel' },
  'app.save': { 'zh-CN': '保存', en: 'Save' },
  'app.previousBranch': { 'zh-CN': '上一分支', en: 'Previous branch' },
  'app.nextBranch': { 'zh-CN': '下一分支', en: 'Next branch' },
  'app.noMatchingThreads': { 'zh-CN': '没有匹配的会话', en: 'No matching chats' },
  'app.collapseSidebar': { 'zh-CN': '收起侧边栏', en: 'Collapse sidebar' },
  'app.expandSidebar': { 'zh-CN': '展开侧边栏', en: 'Expand sidebar' },
  'app.resizeSidebar': { 'zh-CN': '调整侧边栏宽度（←/→）', en: 'Resize sidebar (←/→)' },
  'app.threadMenu': { 'zh-CN': '会话「{title}」操作', en: 'Actions for "{title}"' },
  'app.unread': { 'zh-CN': '有新内容', en: 'Unread' },
  'app.running': { 'zh-CN': '任务运行中', en: 'Task running' },
  'app.needsApproval': { 'zh-CN': '等待审批', en: 'Awaiting approval' },
  'app.needsInput': { 'zh-CN': '等待你的输入', en: 'Awaiting your input' },
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
    'zh-CN': '给 Panelot 发消息…（@ 引用，/ 命令）',
    en: 'Message Panelot… (@ references, / commands)',
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
    en: 'Message added before the next model call',
  },
  'input.queuedInstead': {
    'zh-CN': '当前轮不可插话，已加入队列',
    en: 'This turn cannot be steered. The message was queued instead.',
  },
  'input.variableExpansionFailed': {
    'zh-CN': '动态变量读取失败，本条消息未发送',
    en: 'Dynamic variable lookup failed; this message was not sent',
  },
  'input.threadChangedBeforeSend': {
    'zh-CN': '会话已切换，消息未发送',
    en: 'The conversation changed, so the message was not sent',
  },
  'input.queuedCount': { 'zh-CN': '队列中 {n} 条消息', en: '{n} messages queued' },
  'input.remove': { 'zh-CN': '移除 {label}', en: 'Remove {label}' },
  'input.attach': { 'zh-CN': '添加', en: 'Add' },
  'input.uploadFile': { 'zh-CN': '上传文件', en: 'Upload file' },
  'input.uploadRequiresThread': {
    'zh-CN': '请先发送一条消息创建会话，再上传文件。',
    en: 'Send a message to create the chat before uploading a file.',
  },
  'input.attachPage': { 'zh-CN': '引用页面', en: 'Attach page' },
  'input.skills': { 'zh-CN': '技能', en: 'Skills' },
  'input.noTabs': { 'zh-CN': '没有可引用的标签页', en: 'No tabs available' },
  'input.noSkills': { 'zh-CN': '暂无已启用的 Skill', en: 'No enabled skills' },
  'input.pastedText': { 'zh-CN': '粘贴文本（{n} 字符）', en: 'Pasted text ({n} chars)' },
  'input.group.openTabs': { 'zh-CN': '打开的标签页', en: 'Open tabs' },
  'input.group.mcpResources': { 'zh-CN': 'MCP 资源', en: 'MCP resources' },
  'input.mcpPrompt': { 'zh-CN': 'MCP 提示词 · {server}', en: 'MCP prompt · {server}' },
  'input.group.builtinCommands': { 'zh-CN': '内置命令', en: 'Built-in commands' },
  'input.group.skills': { 'zh-CN': '技能', en: 'Skills' },
  'input.group.dynamicVariables': {
    'zh-CN': '动态变量（发送时求值）',
    en: 'Dynamic variables (evaluated on send)',
  },
  'input.menuLoadFailed': {
    'zh-CN': '无法刷新可附加的标签页或技能。',
    en: 'Could not refresh attachable tabs or skills.',
  },
  'input.draftReadFailed': {
    'zh-CN': '无法恢复已保存的草稿；你仍可继续输入新草稿。',
    en: 'The saved draft could not be restored; you can still type a new draft.',
  },
  'input.draftWriteFailed': {
    'zh-CN': '草稿尚未保存，请保持页面打开并复制重要内容。',
    en: 'The draft was not saved. Keep this page open and copy important text.',
  },

  // Approval
  'approval.allow': { 'zh-CN': '允许', en: 'Allow' },
  'approval.allowOnce': { 'zh-CN': '允许一次', en: 'Allow once' },
  'approval.allowSession': { 'zh-CN': '本次会话', en: 'This chat' },
  'approval.allowSite': { 'zh-CN': '本站始终', en: 'Always on this site' },
  'interaction.question': { 'zh-CN': '需要你的回答', en: 'Your input is needed' },
  'interaction.userAction': { 'zh-CN': '请接管此步骤', en: 'Take over this step' },
  'interaction.watchPage': { 'zh-CN': '正在等待页面变化', en: 'Waiting for a page change' },
  'interaction.schedule': { 'zh-CN': '任务已定时暂停', en: 'Task scheduled to resume' },
  'interaction.mcp': { 'zh-CN': 'MCP 服务需要输入', en: 'MCP server needs input' },
  'interaction.otherAnswer': { 'zh-CN': '输入其他答案', en: 'Type another answer' },
  'interaction.completed': { 'zh-CN': '我已完成', en: 'I completed it' },
  'interaction.submit': { 'zh-CN': '提交', en: 'Submit' },
  'interaction.skip': { 'zh-CN': '跳过', en: 'Skip' },
  'interaction.previousQuestion': { 'zh-CN': '上一题', en: 'Previous question' },
  'interaction.nextQuestion': { 'zh-CN': '下一题', en: 'Next question' },
  'interaction.questionProgress': { 'zh-CN': '/', en: 'of' },
  'interaction.watching': {
    'zh-CN': 'Panelot 会在条件满足或超时后自动继续。',
    en: 'Panelot will continue when the condition is met or the wait times out.',
  },
  'interaction.invalidJson': { 'zh-CN': '请输入有效的 JSON。', en: 'Enter valid JSON.' },
  'interaction.jsonInput': { 'zh-CN': '结构化响应 JSON', en: 'Structured response JSON' },
  'approval.decline': { 'zh-CN': '拒绝', en: 'Decline' },
  'approval.crossScope': {
    'zh-CN': '越出任务范围：本任务尚未访问目标站点',
    en: 'Outside task scope: this task has not accessed the target site',
  },
  'approval.sensitive': {
    'zh-CN': '检测到敏感信息外发：参数可能包含凭据、卡号或邮箱地址',
    en: 'Sensitive data detected: parameters may contain credentials, card numbers, or email addresses',
  },
  'approval.escalation': {
    'zh-CN': '需要使用调试模式：Chrome 会显示“正在调试此浏览器”横幅',
    en: 'Debugger mode required: Chrome will show its debugging banner',
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
  'completion.maxTokens.title': {
    'zh-CN': '回复已达到输出上限',
    en: 'Response reached the output limit',
  },
  'completion.maxTokens.description': {
    'zh-CN': '回复可能不完整。请提高最大输出长度，或让助手从中断处继续。',
    en: 'The response may be incomplete. Increase the output limit or ask the assistant to continue.',
  },
  'completion.contentFilter.title': {
    'zh-CN': '回复因内容过滤而停止',
    en: 'Response stopped by content filtering',
  },
  'completion.contentFilter.description': {
    'zh-CN': '提供方未返回完整内容。请调整请求后重试；原请求不会自动重放。',
    en: 'The provider did not return the complete content. Revise the request and try again; the original request is not replayed automatically.',
  },

  // Provider error attribution (docs/development/providers.md §7)
  'error.auth': {
    'zh-CN': '身份验证失败',
    en: 'Authentication failed',
  },
  'error.rate_limit': {
    'zh-CN': '请求频率受限',
    en: 'Request rate limited',
  },
  'error.overloaded': {
    'zh-CN': '模型服务暂时不可用',
    en: 'Model service temporarily unavailable',
  },
  'error.context_too_long': {
    'zh-CN': '上下文超过模型限制',
    en: 'Context exceeds the model limit',
  },
  'error.content_filter': {
    'zh-CN': '内容被模型服务拦截',
    en: 'Content blocked by the model service',
  },
  'error.network': {
    'zh-CN': '无法连接模型服务',
    en: 'Could not reach the model service',
  },
  'error.protocol': {
    'zh-CN': '端点返回了不兼容的响应',
    en: 'The endpoint returned an incompatible response',
  },
  'error.engineProtocol': {
    'zh-CN': '扩展界面与后台版本不一致',
    en: 'The extension UI and background are out of sync',
  },
  'error.reason.invalid_key': {
    'zh-CN': 'API Key 无效或已过期',
    en: 'API key is invalid or expired',
  },
  'error.reason.permission_denied': { 'zh-CN': 'API Key 权限不足', en: 'API key lacks permission' },
  'error.reason.quota_exceeded': { 'zh-CN': '账户额度不足', en: 'Account quota exceeded' },
  'error.reason.endpoint_not_found': { 'zh-CN': 'API 端点不存在', en: 'API endpoint not found' },
  'error.reason.model_not_found': {
    'zh-CN': '模型不存在或不可用',
    en: 'Model not found or unavailable',
  },
  'error.reason.invalid_request': {
    'zh-CN': '上游拒绝了请求参数',
    en: 'Upstream rejected the request',
  },
  'error.reason.upstream_error': { 'zh-CN': '上游服务发生错误', en: 'Upstream service error' },
  'error.reason.response_format': {
    'zh-CN': '上游响应格式不兼容',
    en: 'Upstream response format is incompatible',
  },
  'error.guidance.invalid_key': {
    'zh-CN': '在连接设置中更新 API Key 后重试。',
    en: 'Update the API key in connection settings, then retry.',
  },
  'error.guidance.permission_denied': {
    'zh-CN': '确认 API Key 有权使用所选模型和接口。',
    en: 'Confirm the API key can use the selected model and API.',
  },
  'error.guidance.quota_exceeded': {
    'zh-CN': '检查账户余额、套餐额度或计费状态。',
    en: 'Check the account balance, plan quota, or billing status.',
  },
  'error.guidance.endpoint_not_found': {
    'zh-CN': '检查 Base URL 和连接的 API 风格。',
    en: 'Check the Base URL and connection API style.',
  },
  'error.guidance.model_not_found': {
    'zh-CN': '在连接设置中选择上游实际支持的模型。',
    en: 'Select a model that the upstream endpoint actually supports.',
  },
  'error.guidance.invalid_request': {
    'zh-CN': '检查模型能力、兼容性开关和请求参数。',
    en: 'Check model capabilities, compatibility switches, and request parameters.',
  },
  'error.guidance.upstream_error': {
    'zh-CN': '稍后重试；若持续失败，请查看上游服务状态。',
    en: 'Retry later; if it persists, check the upstream service status.',
  },
  'error.guidance.response_format': {
    'zh-CN': '检查 API 风格和端点兼容性配置。',
    en: 'Check the API style and endpoint compatibility settings.',
  },
  'error.guidance.auth': {
    'zh-CN': '检查连接设置中的 API Key。',
    en: 'Check the API key in connection settings.',
  },
  'error.guidance.rate_limit': {
    'zh-CN': '稍后重试，或添加备用 API Key。',
    en: 'Retry shortly or add a backup API key.',
  },
  'error.guidance.overloaded': { 'zh-CN': '稍后重试。', en: 'Retry later.' },
  'error.guidance.context_too_long': {
    'zh-CN': '缩短上下文或开始新会话。',
    en: 'Shorten the context or start a new chat.',
  },
  'error.guidance.content_filter': {
    'zh-CN': '调整请求内容后重试。',
    en: 'Revise the request content, then retry.',
  },
  'error.guidance.network': {
    'zh-CN': '检查网络、代理和浏览器站点权限。',
    en: 'Check connectivity, proxy, and browser site permissions.',
  },
  'error.guidance.protocol': {
    'zh-CN': '检查连接的 API 风格和兼容性设置。',
    en: 'Check the connection API style and compatibility settings.',
  },
  'error.guidance.engineProtocol': {
    'zh-CN': '重载扩展即可恢复会话；现有对话数据不会被修改。',
    en: 'Reload the extension to restore the chat; existing chat data will not be changed.',
  },
  'error.reloadExtension': { 'zh-CN': '重载扩展', en: 'Reload extension' },
  'input.reloadRequired': {
    'zh-CN': '请重载扩展后继续',
    en: 'Reload the extension to continue',
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
  'settings.title': { 'zh-CN': 'Panelot 设置', en: 'Panelot Settings' },
  'settings.section.attachments': { 'zh-CN': '附件', en: 'Attachments' },
  'settings.section.sites': { 'zh-CN': '站点', en: 'Sites' },
  'settings.section.presets': { 'zh-CN': '预设', en: 'Presets' },
  'settings.section.general': { 'zh-CN': '通用', en: 'General' },
  'settings.section.providers': { 'zh-CN': '模型', en: 'Models' },
  'settings.section.permissions': { 'zh-CN': '浏览器权限', en: 'Browser permissions' },
  'settings.section.skills': { 'zh-CN': 'Skills', en: 'Skills' },
  'settings.section.plugins': { 'zh-CN': 'Plugins', en: 'Plugins' },
  'settings.section.mcp': { 'zh-CN': 'MCP 服务器', en: 'MCP servers' },
  'settings.section.data': { 'zh-CN': '数据', en: 'Data' },
  'settings.section.about': { 'zh-CN': '关于', en: 'About' },
  'settings.general.prompt': { 'zh-CN': '全局自定义指令', en: 'Global custom instructions' },
  'settings.general.promptPlaceholder': {
    'zh-CN': '例如：回复保持简洁；表格优先。',
    en: 'For example: Keep replies concise and prefer tables.',
  },
  'settings.general.promptHint': {
    'zh-CN': '作为用户层加入 system prompt，对所有会话生效。',
    en: 'Added to the user layer of the system prompt for every chat.',
  },
  'settings.general.language': { 'zh-CN': '语言', en: 'Language' },
  'settings.general.theme': { 'zh-CN': '主题', en: 'Theme' },
  'settings.general.theme.system': { 'zh-CN': '跟随系统', en: 'System' },
  'settings.general.theme.dark': { 'zh-CN': '暗色', en: 'Dark' },
  'settings.general.theme.light': { 'zh-CN': '亮色', en: 'Light' },
  'settings.about.title': { 'zh-CN': '关于 Panelot', en: 'About Panelot' },
  'settings.about.summary': {
    'zh-CN': '连接自己的模型，在浏览器里阅读页面和执行操作。',
    en: 'Connect your own model to read and operate pages in the browser.',
  },
  'settings.about.github': { 'zh-CN': '查看 GitHub', en: 'View on GitHub' },

  // Provider settings and onboarding
  'settings.providers.title': { 'zh-CN': '模型连接', en: 'Model connections' },
  'settings.providers.add': { 'zh-CN': '添加连接', en: 'Add connection' },
  'settings.providers.emptyTitle': { 'zh-CN': '还没有模型连接', en: 'No model connections yet' },
  'settings.providers.emptyHint': {
    'zh-CN': '添加 OpenAI 兼容或 Anthropic 连接，验证后即可开始对话。',
    en: 'Add an OpenAI-compatible or Anthropic connection, then verify it to start chatting.',
  },
  'settings.providers.defaultModel': { 'zh-CN': '默认模型', en: 'Default model' },
  'settings.providers.defaultModelHint': {
    'zh-CN': '必须选择一个可用模型；对话选择“默认模型”时使用它。',
    en: 'Choose an available model. Chats set to “Default model” will use it.',
  },
  'settings.providers.defaultSet': { 'zh-CN': '默认模型已设置', en: 'Default model set' },
  'settings.providers.saved': { 'zh-CN': '连接已保存', en: 'Connection saved' },
  'settings.providers.deleted': { 'zh-CN': '连接已删除', en: 'Connection deleted' },
  'settings.providers.enable': { 'zh-CN': '启用 {name}', en: 'Enable {name}' },
  'settings.providers.edit': { 'zh-CN': '编辑', en: 'Edit' },
  'settings.providers.delete': { 'zh-CN': '删除', en: 'Delete' },
  'settings.providers.deleteTitle': {
    'zh-CN': '删除连接“{name}”？',
    en: 'Delete connection “{name}”?',
  },
  'settings.providers.deleteHint': {
    'zh-CN': '该连接的模型将不再可用；已有会话记录不受影响。',
    en: 'Models from this connection will no longer be available. Existing chat history is unaffected.',
  },
  'settings.providers.kind': { 'zh-CN': '接口类型', en: 'API type' },
  'settings.providers.kind.openai': { 'zh-CN': 'OpenAI 兼容', en: 'OpenAI-compatible' },
  'settings.providers.kind.anthropic': { 'zh-CN': 'Anthropic', en: 'Anthropic' },
  'settings.providers.name': { 'zh-CN': '名称（可选）', en: 'Name (optional)' },
  'settings.providers.namePlaceholder': {
    'zh-CN': '留空时使用接口域名',
    en: 'Uses the endpoint hostname when blank',
  },
  'settings.providers.keys': {
    'zh-CN': 'API Keys（每行一个，可自动故障转移）',
    en: 'API keys (one per line, with automatic failover)',
  },
  'settings.providers.models': {
    'zh-CN': '模型列表（端点不支持 /models 时手动填写，每行一个）',
    en: 'Model list (one per line when the endpoint does not support /models)',
  },
  'settings.providers.modelsPlaceholder': {
    'zh-CN': '留空 = 自动获取\ngpt-5',
    en: 'Blank = discover automatically\ngpt-5',
  },
  'settings.providers.verify': { 'zh-CN': '验证连接', en: 'Verify connection' },
  'settings.providers.verifying': { 'zh-CN': '验证中…', en: 'Verifying…' },
  'settings.providers.reachable': { 'zh-CN': '可达', en: 'Reachable' },
  'settings.providers.keyValid': { 'zh-CN': 'Key 有效', en: 'Key valid' },
  'settings.providers.streaming': { 'zh-CN': '流式', en: 'Streaming' },
  'settings.providers.toolUse': { 'zh-CN': '工具调用', en: 'Tool use' },
  'settings.providers.discovered': {
    'zh-CN': '从端点发现 {n} 个模型：',
    en: 'Discovered {n} models from the endpoint:',
  },
  'settings.providers.quirks': {
    'zh-CN': '兼容性开关（quirks）',
    en: 'Compatibility options (quirks)',
  },
  'settings.providers.quirk.noStreamOptions': {
    'zh-CN': '端点不支持 stream_options.include_usage',
    en: 'Endpoint does not support stream_options.include_usage',
  },
  'settings.providers.quirk.thinkTagReasoning': {
    'zh-CN': '推理内容使用 <think> 内联标签（如 DeepSeek）',
    en: 'Reasoning uses inline <think> tags (for example, DeepSeek)',
  },
  'settings.providers.quirk.noParallelToolCalls': {
    'zh-CN': '强制单工具调用',
    en: 'Force one tool call at a time',
  },
  'settings.providers.quirk.noSystemRole': {
    'zh-CN': '不支持 system 角色（转为首条 user）',
    en: 'No system role (convert it to the first user message)',
  },
  'settings.providers.maxTokensField': {
    'zh-CN': 'max_tokens 字段名',
    en: 'max_tokens field name',
  },
  'settings.providers.advanced': {
    'zh-CN': '自定义 Header 与模型能力/价格',
    en: 'Custom headers and model capabilities/pricing',
  },
  'settings.providers.headers': {
    'zh-CN': '自定义 Header（每行 Name: Value，敏感值本机加密）',
    en: 'Custom headers (one Name: Value per line; sensitive values are encrypted locally)',
  },
  'settings.providers.modelConfig': {
    'zh-CN': '模型能力与价格 JSON（价格单位：$/M tokens）',
    en: 'Model capabilities and pricing JSON (prices in $/M tokens)',
  },
  'settings.providers.invalidHeader': {
    'zh-CN': '自定义 Header 第 {line} 行格式无效；请使用 Name: Value。',
    en: 'Custom header line {line} is invalid; use Name: Value.',
  },
  'settings.providers.invalidModelArray': {
    'zh-CN': '模型能力/价格必须是 JSON 数组',
    en: 'Model capabilities/pricing must be a JSON array',
  },
  'settings.providers.invalidModelObject': {
    'zh-CN': '模型配置 {index} 必须是对象',
    en: 'Model configuration {index} must be an object',
  },
  'settings.providers.invalidModelCapabilities': {
    'zh-CN': '模型配置 {index} 缺少 id/toolUse/vision',
    en: 'Model configuration {index} is missing id/toolUse/vision',
  },
  'settings.providers.invalidPricing': {
    'zh-CN': '模型配置 {index} 的 pricing 无效',
    en: 'Pricing is invalid for model configuration {index}',
  },
  'settings.providers.needsHostPermission': {
    'zh-CN': '需要授权访问该域名',
    en: 'Permission to access this endpoint is required',
  },
  'settings.providers.needsHostPermissionHint': {
    'zh-CN': '验证时请允许站点访问权限。',
    en: 'Allow site access when verifying the connection.',
  },
  'settings.providers.verifyRequestError': {
    'zh-CN': '连接验证请求失败；请检查 Base URL、网络、代理、访问权限和 Provider 配置。',
    en: 'Connection verification failed. Check the Base URL, network, proxy, site access, and provider settings.',
  },
  'settings.providers.invalidConfiguration': {
    'zh-CN': '连接配置无效。',
    en: 'Connection configuration is invalid.',
  },
  'settings.providers.invalidEndpoint': {
    'zh-CN': '请输入有效的 HTTPS Provider 端点；仅 localhost、127.0.0.1 或 [::1] 可使用 HTTP。',
    en: 'Enter a valid HTTPS provider endpoint. HTTP is allowed only for localhost, 127.0.0.1, or [::1].',
  },
  'settings.providers.invalidModelJson': {
    'zh-CN': '模型能力与价格必须是有效的 JSON。',
    en: 'Model capabilities and pricing must be valid JSON.',
  },
  'settings.providers.baseUrlHint': {
    'zh-CN': 'OpenAI 兼容端点通常以 /v1 结尾；请求失败时请检查路径。',
    en: 'OpenAI-compatible endpoints usually end in /v1; check the path if requests fail.',
  },

  // Browser permission settings. Stored protocol values stay unchanged; only these labels are localized.
  'settings.permissions.defaultPolicy': {
    'zh-CN': '默认权限策略',
    en: 'Default permission policy',
  },
  'settings.permissions.policy.always.label': { 'zh-CN': '全程询问', en: 'Ask for everything' },
  'settings.permissions.policy.always.desc': {
    'zh-CN': '每一步都先征求同意，包括读取页面。',
    en: 'Ask before every step, including reading pages.',
  },
  'settings.permissions.policy.untrusted.label': { 'zh-CN': '操作询问', en: 'Ask before acting' },
  'settings.permissions.policy.untrusted.desc': {
    'zh-CN': '自动放行只读操作，点击、输入等写操作先审批（推荐）。',
    en: 'Allow reads; ask before clicks, typing, and other writes (recommended).',
  },
  'settings.permissions.policy.auto.label': { 'zh-CN': '自动操作', en: 'Act automatically' },
  'settings.permissions.policy.auto.desc': {
    'zh-CN': '自动执行写操作；敏感站点、敏感信息与权限规则仍必须遵守。',
    en: 'Execute writes automatically; sensitive sites, sensitive data, and permission rules still apply.',
  },
  'settings.permissions.rules': { 'zh-CN': '权限规则', en: 'Permission rules' },
  'settings.permissions.rulesHint': {
    'zh-CN': '规则高于默认权限策略，命中规则的操作必须遵守 allow / ask / deny 裁决。',
    en: 'Rules take priority over the default policy; matching actions must obey allow / ask / deny.',
  },
  'settings.permissions.emptyRules': {
    'zh-CN': '审批时选择“本站始终”会创建规则，也可在下方手动添加。',
    en: 'Choose “Always on this site” during approval to create a rule, or add one below.',
  },
  'settings.permissions.tool': { 'zh-CN': '工具', en: 'Tool' },
  'settings.permissions.site': { 'zh-CN': '站点', en: 'Site' },
  'settings.permissions.verdict': { 'zh-CN': '裁决', en: 'Verdict' },
  'settings.permissions.source': { 'zh-CN': '来源', en: 'Source' },
  'settings.permissions.verdict.allow': { 'zh-CN': '允许', en: 'Allow' },
  'settings.permissions.verdict.ask': { 'zh-CN': '询问', en: 'Ask' },
  'settings.permissions.verdict.deny': { 'zh-CN': '拒绝', en: 'Deny' },
  'settings.permissions.source.user_setting': { 'zh-CN': '用户设置', en: 'User setting' },
  'settings.permissions.source.approval': { 'zh-CN': '审批记录', en: 'Approval' },
  'settings.permissions.removeRule': { 'zh-CN': '删除规则', en: 'Delete rule' },
  'settings.permissions.ruleAdded': { 'zh-CN': '规则已添加', en: 'Rule added' },
  'settings.permissions.ruleDeleted': { 'zh-CN': '规则已删除', en: 'Rule deleted' },
  'settings.permissions.add': { 'zh-CN': '添加', en: 'Add' },
  'settings.permissions.originPlaceholder': {
    'zh-CN': '* 或 *.example.com',
    en: '* or *.example.com',
  },
  'settings.permissions.askHint': {
    'zh-CN': 'ask 会强制确认，即使默认策略本可放行。类别：{categories}',
    en: 'ask forces confirmation even when the default policy would allow it. Categories: {categories}',
  },
  'settings.permissions.sensitive': {
    'zh-CN': '敏感站点（写操作始终拒绝）',
    en: 'Sensitive sites (writes are always denied)',
  },
  'settings.permissions.removeSensitive': { 'zh-CN': '移除 {pattern}', en: 'Remove {pattern}' },
  'settings.permissions.showBuiltIn': {
    'zh-CN': '查看 {n} 个预置站点',
    en: 'Show {n} built-in sites',
  },

  // Onboarding
  'onboarding.connect': { 'zh-CN': '连接你的模型', en: 'Connect your model' },
  'onboarding.baseUrl': { 'zh-CN': '接口地址（Base URL）', en: 'Endpoint (Base URL)' },
  'onboarding.apiKey': {
    'zh-CN': 'API Key（Ollama 等本地端点可留空）',
    en: 'API key (optional for local endpoints such as Ollama)',
  },
  'onboarding.connected': { 'zh-CN': '连接成功', en: 'Connected' },
  'onboarding.modelsFound': { 'zh-CN': '，发现 {n} 个模型', en: '; found {n} models' },
  'onboarding.failed': {
    'zh-CN': '验证失败，请检查域名、Key 与网络',
    en: 'Verification failed. Check the endpoint, key, and network.',
  },
  'onboarding.next': { 'zh-CN': '下一步', en: 'Next' },
  'onboarding.approval': { 'zh-CN': '选择审批档位', en: 'Choose an approval mode' },
  'onboarding.tier.safe.title': { 'zh-CN': '稳妥（推荐）', en: 'Balanced (recommended)' },
  'onboarding.tier.safe.desc': {
    'zh-CN': '读取自由；点击、输入、提交等写操作先问我。',
    en: 'Read freely; ask before clicks, typing, submissions, and other writes.',
  },
  'onboarding.tier.smooth.title': { 'zh-CN': '顺畅', en: 'Fewer prompts' },
  'onboarding.tier.smooth.desc': {
    'zh-CN': '读取自由；首次批准后，本轮同站同工具不重复询问。',
    en: 'Read freely; remember the first approval for the same site and tool this turn.',
  },
  'onboarding.tier.readonly.title': { 'zh-CN': '仅浏览', en: 'Browse only' },
  'onboarding.tier.readonly.desc': {
    'zh-CN': '只允许读取页面，禁止一切写操作。',
    en: 'Allow page reads and block every write action.',
  },
  'onboarding.approvalHint': {
    'zh-CN': '之后可在“设置 → 浏览器权限”中调整。',
    en: 'You can change this later in Settings → Browser permissions.',
  },
  'onboarding.finish': { 'zh-CN': '完成', en: 'Finish' },
  'onboarding.ready': {
    'zh-CN': '配置完成。试试第一条指令',
    en: 'Setup complete. Try your first request',
  },
  'onboarding.demo': { 'zh-CN': '总结当前页面的要点', en: 'Summarize the key points on this page' },
  'onboarding.demoHint': {
    'zh-CN': '也可以直接提问；用 @ 引用页面，用 / 调用命令。',
    en: 'You can also ask anything; use @ to reference a page and / to run a command.',
  },
  'onboarding.skip': { 'zh-CN': '跳过，稍后在设置中配置', en: 'Skip and configure later' },
  'onboarding.skipVerify': { 'zh-CN': '跳过验证直接保存', en: 'Save without verification' },
  'onboarding.savedUnverified': {
    'zh-CN': '已保存未验证的连接，可稍后在设置中验证。',
    en: 'Saved the unverified connection. You can verify it later in Settings.',
  },

  // Skills, Plugins, MCP, and data settings
  'settings.skills.edit': { 'zh-CN': '编辑 Skill', en: 'Edit Skill' },
  'settings.skills.saved': { 'zh-CN': 'Skill 已保存', en: 'Skill saved' },
  'settings.skills.importFile': { 'zh-CN': '导入文件', en: 'Import file' },
  'settings.skills.importFileLabel': { 'zh-CN': '导入 Skill 文件', en: 'Import Skill file' },
  'settings.skills.importUrl': { 'zh-CN': '从 URL 导入', en: 'Import from URL' },
  'settings.skills.new': { 'zh-CN': '新建', en: 'New' },
  'settings.skills.overwrite': { 'zh-CN': '覆盖同名 Skill', en: 'Overwrite matching Skill' },
  'settings.skills.rename': { 'zh-CN': '自动改名', en: 'Rename automatically' },
  'settings.skills.conflict': {
    'zh-CN': '已存在同名 Skill，请选择处理方式。',
    en: 'A Skill with this name already exists. Choose how to proceed.',
  },
  'settings.skills.emptyTitle': { 'zh-CN': '还没有 Skill', en: 'No Skills yet' },
  'settings.skills.emptyHint': {
    'zh-CN': '新建一个，或从社区导入兼容 Claude Code 的 SKILL.md。',
    en: 'Create one or import a Claude Code-compatible SKILL.md from the community.',
  },
  'settings.skills.enable': { 'zh-CN': '启用 {name}', en: 'Enable {name}' },
  'settings.skills.copyEdit': { 'zh-CN': '复制并编辑', en: 'Copy and edit' },
  'settings.skills.export': { 'zh-CN': '导出 {name}', en: 'Export {name}' },
  'settings.skills.delete': { 'zh-CN': '删除', en: 'Delete' },
  'settings.skills.urlTitle': { 'zh-CN': '从 URL 导入 Skill', en: 'Import Skill from URL' },
  'settings.skills.urlHint': {
    'zh-CN': '输入 SKILL.md 的 HTTPS URL（例如 GitHub raw）。',
    en: 'Enter an HTTPS URL for SKILL.md, such as a GitHub raw URL.',
  },
  'settings.skills.import': { 'zh-CN': '导入', en: 'Import' },
  'settings.skills.imported': { 'zh-CN': '已从 URL 导入', en: 'Imported from URL' },
  'settings.skills.importFailed': { 'zh-CN': '导入失败：{error}', en: 'Import failed: {error}' },
  'settings.skills.httpsOnly': {
    'zh-CN': 'Skill URL 必须使用 HTTPS',
    en: 'Skill URL must use HTTPS',
  },
  'settings.skills.permissionDenied': {
    'zh-CN': '未授予该 URL 的访问权限',
    en: 'Access to this URL was not granted',
  },
  'settings.skills.tooLarge': { 'zh-CN': 'SKILL.md 超过 1 MB 限制', en: 'SKILL.md exceeds 1 MB' },
  'settings.skills.dependencyWarning': {
    'zh-CN': '该 Skill 引用了 {files}；单文件导入不会包含这些依赖，请确认指令仍可独立使用。',
    en: 'This Skill references {files}. A single-file import excludes these dependencies; confirm the instructions still work independently.',
  },
  'settings.skills.externalFiles': {
    'zh-CN': '该 Skill 还引用 {n} 个外部文件，当前仅导入 SKILL.md。',
    en: 'This Skill references {n} external files; only SKILL.md will be imported.',
  },
  'settings.skills.templateDescription': {
    'zh-CN': '简述这个技能做什么，以及何时使用。',
    en: 'Briefly describe what this Skill does and when to use it.',
  },
  'settings.skills.templateHeading': { 'zh-CN': '指令正文', en: 'Instructions' },
  'settings.skills.templateBody': {
    'zh-CN': '在这里写详细指令。',
    en: 'Write detailed instructions here.',
  },

  'settings.plugins.installed': { 'zh-CN': 'Plugin 已安装', en: 'Plugin installed' },
  'settings.plugins.limit': {
    'zh-CN': '安装包限制：压缩 10 MB、解压 50 MB、1000 个文件；不会执行包内代码。',
    en: 'Package limits: 10 MB compressed, 50 MB extracted, 1,000 files. Packaged code is never executed.',
  },
  'settings.plugins.installGithub': { 'zh-CN': '从 GitHub 安装', en: 'Install from GitHub' },
  'settings.plugins.chooseZip': { 'zh-CN': '选择本地 ZIP', en: 'Choose local ZIP' },
  'settings.plugins.chooseZipLabel': {
    'zh-CN': '选择本地 Plugin ZIP',
    en: 'Choose a local Plugin ZIP',
  },
  'settings.plugins.emptyTitle': { 'zh-CN': '尚未安装 Plugin', en: 'No Plugins installed' },
  'settings.plugins.emptyHint': {
    'zh-CN': '可从 GitHub 或本地 ZIP 安装。安装前请核对来源和内容。',
    en: 'Install from GitHub or a local ZIP. Review the source and contents first.',
  },
  'settings.plugins.enable': { 'zh-CN': '启用 {name}', en: 'Enable {name}' },
  'settings.plugins.disable': { 'zh-CN': '停用 {name}', en: 'Disable {name}' },
  'settings.plugins.uninstall': { 'zh-CN': '卸载 {name}', en: 'Uninstall {name}' },
  'settings.plugins.manifest': { 'zh-CN': '安装清单（{n}）', en: 'Installed assets ({n})' },
  'settings.plugins.permissionDenied': {
    'zh-CN': '未授予 GitHub 下载权限',
    en: 'GitHub download permission was not granted',
  },
  'settings.plugins.urlLabel': {
    'zh-CN': 'GitHub Plugin 仓库或 ZIP 地址',
    en: 'GitHub Plugin repository or ZIP URL',
  },
  'settings.plugins.analyzeGithub': { 'zh-CN': '分析 GitHub 包', en: 'Analyze GitHub package' },
  'settings.plugins.analyzing': { 'zh-CN': '正在分析…', en: 'Analyzing…' },
  'settings.plugins.preview.installTitle': {
    'zh-CN': '确认安装 Plugin',
    en: 'Confirm Plugin install',
  },
  'settings.plugins.preview.upgradeTitle': {
    'zh-CN': '确认升级 Plugin',
    en: 'Confirm Plugin upgrade',
  },
  'settings.plugins.preview.description': {
    'zh-CN': '请核对来源、内容和提示词资产。再次确认后，Panelot 才会写入本机数据库。',
    en: 'Review the source, contents, and prompt assets. Panelot writes to the local database only after you confirm again.',
  },
  'settings.plugins.preview.source': { 'zh-CN': '来源', en: 'Source' },
  'settings.plugins.preview.resolvedSource': {
    'zh-CN': '解析后的下载地址',
    en: 'Resolved download URL',
  },
  'settings.plugins.preview.digest': { 'zh-CN': 'SHA-256 摘要', en: 'SHA-256 digest' },
  'settings.plugins.preview.expires': {
    'zh-CN': '确认窗口截止：{time}',
    en: 'Confirmation expires: {time}',
  },
  'settings.plugins.preview.existing': {
    'zh-CN': '当前已安装 {version}；升级后将保持停用。',
    en: 'Version {version} is installed. The upgraded Plugin will remain disabled.',
  },
  'settings.plugins.preview.assets': { 'zh-CN': '资产（{n}）', en: 'Assets ({n})' },
  'settings.plugins.preview.skills': { 'zh-CN': 'Skills（{n}）', en: 'Skills ({n})' },
  'settings.plugins.preview.presets': { 'zh-CN': '模型预设（{n}）', en: 'Model presets ({n})' },
  'settings.plugins.preview.sites': { 'zh-CN': '站点指令（{n}）', en: 'Site instructions ({n})' },
  'settings.plugins.preview.bytes': { 'zh-CN': '{n} 字节', en: '{n} bytes' },
  'settings.plugins.preview.model': { 'zh-CN': '模型：{model}', en: 'Model: {model}' },
  'settings.plugins.preview.promptSummary': {
    'zh-CN': '提示词摘要：{summary}',
    en: 'Prompt summary: {summary}',
  },
  'settings.plugins.preview.disabled': { 'zh-CN': '安装后停用', en: 'Disabled after install' },
  'settings.plugins.security.title': { 'zh-CN': '提示词信任边界', en: 'Prompt trust boundary' },
  'settings.plugins.security.body': {
    'zh-CN':
      'Plugin 数据不会作为代码执行，但 Skill、站点指令和预设提示词在启用后会进入 Agent 上下文。仅安装你信任并已核对的内容。',
    en: 'Plugin data is not executed as code, but Skills, site instructions, and preset prompts enter Agent context after you enable them. Install only content you trust and have reviewed.',
  },
  'settings.plugins.security.promptAssetsDisabled': {
    'zh-CN': '本包包含提示词资产；Plugin 与派生 Skills 默认停用，不会因安装进入提示词。',
    en: 'This package contains prompt assets. The Plugin and derived Skills stay disabled and do not enter prompts on install.',
  },
  'settings.plugins.security.upgradeDisabled': {
    'zh-CN': '升级会停用整个 Plugin 及其派生 Skills，需在检查新内容后手动重新启用。',
    en: 'An upgrade disables the Plugin and its derived Skills. Re-enable them only after reviewing the new content.',
  },
  'settings.plugins.security.opaqueAssets': {
    'zh-CN': '本包包含通用数据资产；安装前请检查其文件名和来源。',
    en: 'This package includes opaque data assets. Review their names and source before installing.',
  },
  'settings.plugins.cancel': { 'zh-CN': '取消', en: 'Cancel' },
  'settings.plugins.confirmInstall': {
    'zh-CN': '确认安装并保持停用',
    en: 'Install and keep disabled',
  },
  'settings.plugins.confirmUpgrade': { 'zh-CN': '确认升级并停用', en: 'Upgrade and disable' },

  'settings.data.usage': { 'zh-CN': '存储用量', en: 'Storage usage' },
  'settings.data.nearLimit': {
    'zh-CN': '存储接近上限，建议导出后清理旧会话。',
    en: 'Storage is near its limit. Export a backup, then remove old chats.',
  },
  'settings.data.export': { 'zh-CN': '导出', en: 'Export' },
  'settings.data.import': { 'zh-CN': '导入', en: 'Import' },
  'settings.data.includeSecrets': {
    'zh-CN': '包含秘密（使用口令加密）',
    en: 'Include secrets (encrypted with a passphrase)',
  },
  'settings.data.passphrase': { 'zh-CN': '备份口令', en: 'Backup passphrase' },
  'settings.data.passphraseRequired': {
    'zh-CN': '请输入加密备份口令',
    en: 'Enter a passphrase for the encrypted backup',
  },
  'settings.data.exportAll': { 'zh-CN': '导出全部为 JSON', en: 'Export everything as JSON' },
  'settings.data.exported': { 'zh-CN': '已导出', en: 'Export complete' },
  'settings.data.chooseJson': { 'zh-CN': '选择 JSON 文件', en: 'Choose JSON file' },
  'settings.data.chooseJsonLabel': {
    'zh-CN': '选择 JSON 导入文件',
    en: 'Choose a JSON import file',
  },
  'settings.data.importSuccess': {
    'zh-CN': '导入成功，请重新打开侧边栏。',
    en: 'Import complete. Reopen the side panel.',
  },
  'settings.data.importFailed': { 'zh-CN': '导入失败：{error}', en: 'Import failed: {error}' },
  'settings.data.overwriteTitle': {
    'zh-CN': '导入将覆盖现有数据',
    en: 'Import will overwrite existing data',
  },
  'settings.data.overwriteHint': {
    'zh-CN':
      '现有会话与设置会被替换。已校验 {threads} 个会话、{nodes} 个节点、{skills} 个 Skill（{size} KiB）。建议先导出备份。',
    en: 'Existing chats and settings will be replaced. Validated {threads} chats, {nodes} nodes, and {skills} Skills ({size} KiB). Export a backup first.',
  },
  'settings.data.enterPassphrase': { 'zh-CN': '输入备份口令', en: 'Enter backup passphrase' },
  'settings.data.overwrite': { 'zh-CN': '覆盖导入', en: 'Overwrite and import' },
  'settings.data.previewImport': { 'zh-CN': '预检导入', en: 'Preview import' },
  'settings.data.previewing': { 'zh-CN': '正在预检…', en: 'Previewing…' },
  'settings.data.importing': { 'zh-CN': '正在提交…', en: 'Committing…' },
  'settings.data.previewReady': {
    'zh-CN': '预检通过，可以提交',
    en: 'Preview passed. Ready to commit.',
  },
  'settings.data.previewBlocked': {
    'zh-CN': '当前状态阻止导入',
    en: 'Current activity blocks this import',
  },
  'settings.data.blockerSummary': {
    'zh-CN':
      '活动会话 {active} · 运行中任务 {hard} · 可丢弃任务 {dormant} · 待审批 {approvals} · 待交互 {interactions}',
    en: 'Active chats {active} · running tasks {hard} · discardable tasks {dormant} · pending approvals {approvals} · pending interactions {interactions}',
  },
  'settings.data.confirmDormant': {
    'zh-CN': '我确认丢弃已排队、暂停或中断的任务状态。',
    en: 'I confirm that queued, paused, or interrupted task state may be discarded.',
  },
  'settings.data.committed': {
    'zh-CN': '数据已提交。请重载扩展以完成恢复。',
    en: 'Data committed. Reload the extension to finish recovery.',
  },
  'settings.data.reloadRequired': {
    'zh-CN': '数据维护等待扩展重载',
    en: 'Data maintenance is waiting for an extension reload',
  },
  'settings.data.reloadRequiredHint': {
    'zh-CN': '重载前，新的 Agent 命令会被拒绝，以防止新旧状态混用。',
    en: 'New agent commands are rejected until reload so old and new state cannot mix.',
  },
  'settings.data.reloadNow': { 'zh-CN': '立即重载扩展', en: 'Reload extension now' },
  'settings.data.rollbackRecovered': {
    'zh-CN': '检测到未提交的导入，已恢复原设置。',
    en: 'An uncommitted import was detected and the previous settings were restored.',
  },
  'settings.data.commitRecovered': {
    'zh-CN': '检测到已提交的导入，清理工作已经完成。',
    en: 'A committed import was detected. Recovery cleanup is complete.',
  },

  'settings.mcp.importJson': { 'zh-CN': '粘贴 JSON 导入', en: 'Import pasted JSON' },
  'settings.mcp.importConfig': { 'zh-CN': '导入配置', en: 'Import configuration' },
  'settings.mcp.compatHint': {
    'zh-CN':
      '兼容 Claude Code mcpServers / Cursor 配置片段（识别 url、type 与 headers.Authorization）。',
    en: 'Accepts Claude Code mcpServers and Cursor snippets, including url, type, and headers.Authorization.',
  },
  'settings.mcp.parseAdd': { 'zh-CN': '解析并添加', en: 'Parse and add' },
  'settings.mcp.emptyTitle': { 'zh-CN': '还没有 MCP 服务器', en: 'No MCP servers yet' },
  'settings.mcp.emptyHint': {
    'zh-CN': '粘贴兼容配置，连接远端 Tool、Prompt 和 Resource。',
    en: 'Paste a compatible configuration to connect remote tools, prompts, and resources.',
  },
  'settings.mcp.enable': { 'zh-CN': '启用 {name}', en: 'Enable {name}' },
  'settings.mcp.reconnect': { 'zh-CN': '重新连接', en: 'Reconnect' },
  'settings.mcp.test': { 'zh-CN': '连接测试', en: 'Test connection' },
  'settings.mcp.authorize': { 'zh-CN': '授权', en: 'Authorize' },
  'settings.mcp.oauthFailed': { 'zh-CN': 'OAuth 授权失败', en: 'OAuth authorization failed' },
  'settings.mcp.operationFailed': {
    'zh-CN': 'MCP 操作失败：{message}',
    en: 'MCP operation failed: {message}',
  },
  'settings.mcp.oauthComplete': { 'zh-CN': 'OAuth 授权完成', en: 'OAuth authorization complete' },
  'settings.mcp.permissionTitle': {
    'zh-CN': '需要授权额外的 OAuth 站点',
    en: 'Additional OAuth sites require permission',
  },
  'settings.mcp.permissionResource': {
    'zh-CN': '资源：{resource}',
    en: 'Resource: {resource}',
  },
  'settings.mcp.permissionIssuer': { 'zh-CN': '签发方：{issuer}', en: 'Issuer: {issuer}' },
  'settings.mcp.permissionPlanChanged': {
    'zh-CN': 'OAuth 元数据已变化。请重新确认此授权计划。',
    en: 'OAuth metadata changed. Review this authorization plan again.',
  },
  'settings.mcp.permissionPlanExpired': {
    'zh-CN': '此授权计划已过期。请重新确认后继续。',
    en: 'This authorization plan expired. Review it again to continue.',
  },
  'settings.mcp.permissionContinue': {
    'zh-CN': '授权以上站点并继续',
    en: 'Allow these sites and continue',
  },
  'settings.mcp.delete': { 'zh-CN': '删除', en: 'Delete' },
  'settings.mcp.enableTool': { 'zh-CN': '启用 MCP 工具 {name}', en: 'Enable MCP tool {name}' },
  'settings.mcp.toolsAfterConnect': {
    'zh-CN': '连接后显示工具清单',
    en: 'Tools appear after connection',
  },
  'settings.mcp.deleteTitle': { 'zh-CN': '删除 {name}？', en: 'Delete {name}?' },
  'settings.mcp.deleteHint': {
    'zh-CN': '该服务器提供的工具与 Prompt 将不再可用。',
    en: 'Tools and prompts from this server will no longer be available.',
  },
  'settings.mcp.deleted': { 'zh-CN': '服务器已删除', en: 'Server deleted' },
  'settings.mcp.added': { 'zh-CN': '已添加 {n} 个服务器', en: 'Added {n} servers' },
  'settings.mcp.permissionDenied': {
    'zh-CN': '未授予 {url} 的访问权限',
    en: 'Access to {url} was not granted',
  },
  'settings.mcp.status.disconnected': { 'zh-CN': '未连接', en: 'Disconnected' },
  'settings.mcp.status.connecting': { 'zh-CN': '连接中', en: 'Connecting' },
  'settings.mcp.status.ready': { 'zh-CN': '已连接', en: 'Connected' },
  'settings.mcp.status.error': { 'zh-CN': '错误', en: 'Error' },
  'settings.mcp.auth.none': { 'zh-CN': '无认证', en: 'No authentication' },
  'settings.mcp.auth.oauth': { 'zh-CN': 'OAuth', en: 'OAuth' },
  'settings.mcp.auth.bearer': { 'zh-CN': 'Bearer token', en: 'Bearer token' },
  'settings.mcp.inventory': {
    'zh-CN': '工具 {tools} · Prompts {prompts} · Resources {resources}',
    en: 'Tools {tools} · Prompts {prompts} · Resources {resources}',
  },

  // Attachment, site-instruction, and preset settings
  'settings.attachments.summary': {
    'zh-CN': '{count} 条记录 · 本地存储 {size}',
    en: '{count} records · {size} stored locally',
  },
  'settings.attachments.emptyTitle': { 'zh-CN': '没有已存储的附件', en: 'No stored attachments' },
  'settings.attachments.emptyHint': {
    'zh-CN': '对话引用的截图、页面摘录和用户上传内容会显示在这里。',
    en: 'Screenshots, page extracts, and user uploads referenced by chats appear here.',
  },
  'settings.attachments.delete': { 'zh-CN': '删除附件', en: 'Delete attachment' },
  'settings.attachments.deleteTitle': { 'zh-CN': '删除此附件？', en: 'Delete this attachment?' },
  'settings.attachments.deleteHint': {
    'zh-CN': '删除文件前，引用它的消息节点会被标记为不可用。',
    en: 'Referencing message nodes will be marked unavailable before the bytes are removed.',
  },
  'settings.attachments.deleted': { 'zh-CN': '附件已删除', en: 'Attachment deleted' },
  'settings.attachments.nodeRefs': { 'zh-CN': '{count} 个节点引用', en: '{count} node refs' },
  'settings.attachments.unclassified': { 'zh-CN': '未分类', en: 'Unclassified' },
  'settings.attachments.unknownSource': { 'zh-CN': '来源未知', en: 'Unknown source' },

  'settings.sites.title': { 'zh-CN': '站点指令', en: 'Site instructions' },
  'settings.sites.summary': {
    'zh-CN': '仅当活动标签页匹配主机名时，才把可信指令加入系统提示词。',
    en: 'Add trusted instructions to the system prompt only when the active tab matches the hostname.',
  },
  'settings.sites.new': { 'zh-CN': '新建指令', en: 'New instruction' },
  'settings.sites.emptyTitle': { 'zh-CN': '没有站点指令', en: 'No site instructions' },
  'settings.sites.emptyHint': {
    'zh-CN': '使用精确主机名或 *.example.com 等通配符；不支持 URL 路径。',
    en: 'Use an exact hostname or a wildcard such as *.example.com. URL paths are intentionally unsupported.',
  },
  'settings.sites.saved': { 'zh-CN': '站点指令已保存', en: 'Site instruction saved' },
  'settings.sites.edit': { 'zh-CN': '编辑', en: 'Edit' },
  'settings.sites.copyEdit': { 'zh-CN': '复制并编辑', en: 'Copy and edit' },
  'settings.sites.delete': { 'zh-CN': '删除', en: 'Delete' },
  'settings.sites.pluginTitle': { 'zh-CN': 'Plugin 站点指令', en: 'Plugin site instructions' },
  'settings.sites.deleteTitle': {
    'zh-CN': '删除此站点指令？',
    en: 'Delete this site instruction?',
  },
  'settings.sites.deleteHint': {
    'zh-CN': '匹配页面将不再包含此指令。',
    en: 'The instruction will stop being included on matching pages.',
  },
  'settings.sites.editTitle': { 'zh-CN': '编辑站点指令', en: 'Edit site instruction' },
  'settings.sites.createTitle': { 'zh-CN': '创建站点指令', en: 'Create site instruction' },
  'settings.sites.patternHint': {
    'zh-CN': '模式按主机名边界匹配，不会匹配任意后缀。',
    en: 'Patterns match complete hostname labels, not arbitrary suffixes.',
  },
  'settings.sites.hostname': { 'zh-CN': '主机名模式', en: 'Hostname pattern' },
  'settings.sites.hostnameHint': {
    'zh-CN': '精确主机：example.com · 通配符：*.example.com',
    en: 'Exact host: example.com · wildcard: *.example.com',
  },
  'settings.sites.instruction': { 'zh-CN': '指令', en: 'Instruction' },
  'settings.sites.save': { 'zh-CN': '保存指令', en: 'Save instruction' },

  'settings.presets.title': { 'zh-CN': '模型预设', en: 'Model presets' },
  'settings.presets.summary': {
    'zh-CN': '保存一组模型、提示词、工具和审批策略，供新会话复用。',
    en: 'Save a model, prompt, tools, and approval policy for reuse in new chats.',
  },
  'settings.presets.new': { 'zh-CN': '新建预设', en: 'New preset' },
  'settings.presets.taskModel': { 'zh-CN': '后台任务模型', en: 'Task model' },
  'settings.presets.taskModelHint': {
    'zh-CN': '用于标题等低成本后台任务；留空则跟随默认模型。',
    en: 'Used for titles and other low-cost background tasks. Leave it empty to use the default model.',
  },
  'settings.presets.taskModelSet': { 'zh-CN': '后台任务模型：{model}', en: 'Task model: {model}' },
  'settings.presets.taskModelDefault': {
    'zh-CN': '后台任务模型跟随默认设置',
    en: 'Task model follows the default',
  },
  'settings.presets.emptyTitle': { 'zh-CN': '还没有模型预设', en: 'No model presets yet' },
  'settings.presets.emptyHint': {
    'zh-CN': '创建预设，为新会话复用同一组模型、参数和工具。',
    en: 'Create a preset to reuse the same model, parameters, and tools in new chats.',
  },
  'settings.presets.saved': { 'zh-CN': '预设已保存', en: 'Preset saved' },
  'settings.presets.edit': { 'zh-CN': '编辑', en: 'Edit' },
  'settings.presets.delete': { 'zh-CN': '删除', en: 'Delete' },
  'settings.presets.pluginTitle': { 'zh-CN': 'Plugin 预设', en: 'Plugin presets' },
  'settings.presets.copyEdit': { 'zh-CN': '复制并编辑', en: 'Copy and edit' },
  'settings.presets.copySuffix': { 'zh-CN': '{name} 副本', en: '{name} copy' },
  'settings.presets.deleteTitle': { 'zh-CN': '删除此模型预设？', en: 'Delete this model preset?' },
  'settings.presets.deleteHint': {
    'zh-CN': '现有对话记录会保留，但此预设将无法再被选择。',
    en: 'Existing chat records remain, but this preset can no longer be selected.',
  },
  'settings.presets.editTitle': { 'zh-CN': '编辑预设', en: 'Edit preset' },
  'settings.presets.createTitle': { 'zh-CN': '创建模型预设', en: 'Create model preset' },
  'settings.presets.formHint': {
    'zh-CN': '开始任务时，Panelot 会把这些设置写入本次运行环境。',
    en: 'Panelot applies these settings to the run environment when a task starts.',
  },
  'settings.presets.name': { 'zh-CN': '名称', en: 'Name' },
  'settings.presets.icon': { 'zh-CN': '图标或 Emoji', en: 'Icon or emoji' },
  'settings.presets.connection': { 'zh-CN': '模型连接', en: 'Connection' },
  'settings.presets.selectConnection': { 'zh-CN': '选择连接', en: 'Select a connection' },
  'settings.presets.modelId': { 'zh-CN': '模型 ID', en: 'Model ID' },
  'settings.presets.systemPrompt': { 'zh-CN': '系统提示词', en: 'System prompt' },
  'settings.presets.parameters': { 'zh-CN': '生成参数', en: 'Generation parameters' },
  'settings.presets.maxTokens': { 'zh-CN': '最大输出 token', en: 'Maximum output tokens' },
  'settings.presets.reasoning': { 'zh-CN': '推理强度', en: 'Reasoning effort' },
  'settings.presets.reasoning.unset': { 'zh-CN': '未设置', en: 'Not set' },
  'settings.presets.reasoning.low': { 'zh-CN': '低', en: 'Low' },
  'settings.presets.reasoning.medium': { 'zh-CN': '中', en: 'Medium' },
  'settings.presets.reasoning.high': { 'zh-CN': '高', en: 'High' },
  'settings.presets.stop': { 'zh-CN': '停止序列（每行一个）', en: 'Stop sequences, one per line' },
  'settings.presets.toolLevels': { 'zh-CN': '启用的工具层级', en: 'Enabled tool levels' },
  'settings.presets.toolLevelsHint': {
    'zh-CN': 'L0 读取 · L1 页面写入 · L2 调试器 · MCP',
    en: 'L0 read · L1 page write · L2 debugger · MCP',
  },
  'settings.presets.defaultPolicy': { 'zh-CN': '默认权限策略', en: 'Default permission policy' },
  'settings.presets.skills': { 'zh-CN': '启用的 Skills', en: 'Active Skills' },
  'settings.presets.noSkills': { 'zh-CN': '没有已启用的 Skill', en: 'No enabled Skills' },
  'settings.presets.promptVersion': { 'zh-CN': '提示词版本', en: 'Prompt version' },
  'settings.presets.save': { 'zh-CN': '保存预设', en: 'Save preset' },

  'settings.permissions.toolPlaceholder': {
    'zh-CN': '工具 / mcp__github__* / category:eval',
    en: 'Tool / mcp__github__* / category:eval',
  },
  'settings.permissions.source.approval_persist': { 'zh-CN': '持久审批', en: 'Saved approval' },
  'settings.permissions.source.plugin_default': {
    'zh-CN': 'Plugin 默认规则',
    en: 'Plugin default',
  },
  // Permission switch (composer autonomy tiers)
  'perm.switch': { 'zh-CN': '权限模式', en: 'Permission mode' },
  'perm.always': { 'zh-CN': '全程询问', en: 'Ask for everything' },
  'perm.alwaysHint': {
    'zh-CN': '所有浏览器和 MCP 工具调用都先询问，包括读取',
    en: 'Ask before every browser and MCP tool call, including reads',
  },
  'perm.balanced': { 'zh-CN': '操作询问', en: 'Ask before acting' },
  'perm.balancedHint': {
    'zh-CN': '读取无需确认；点击、输入等写操作先询问（默认）',
    en: 'Reads do not require approval. Writes such as clicks and typing ask first (default)',
  },
  'perm.auto': { 'zh-CN': '自动操作', en: 'Act automatically' },
  'perm.autoHint': {
    'zh-CN': '写操作无需逐次确认；敏感站点和敏感信息规则仍然生效',
    en: 'Writes run without per-action approval. Sensitive-site and sensitive-data rules still apply',
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
    'zh-CN': '读取多个已打开的标签页后整理差异',
    en: 'Read several open tabs and summarize the differences',
  },
  'empty.sugForm': { 'zh-CN': '帮我填这个表单', en: 'Fill this form for me' },
  'empty.sugFormHint': {
    'zh-CN': '写操作遵守当前权限模式和规则',
    en: 'Writes follow the current permission mode and rules',
  },
  'empty.sugExtract': { 'zh-CN': '提取页面数据为表格', en: 'Extract page data as a table' },
  'empty.sugExtractHint': {
    'zh-CN': '把正文、列表或表格整理成结构化结果',
    en: 'Turn page content, lists, or tables into structured results',
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
  'actions.usageInput': { 'zh-CN': '输入', en: 'Input' },
  'actions.usageOutput': { 'zh-CN': '输出', en: 'Output' },
  'actions.usageCacheRead': { 'zh-CN': '缓存读取', en: 'Cache read' },
  'actions.editHint': {
    'zh-CN': 'Esc 取消 · Ctrl+Enter 重新发送',
    en: 'Esc to cancel · Ctrl+Enter to resend',
  },
  'actions.resend': { 'zh-CN': '重新发送', en: 'Resend' },

  // Message stream
  'stream.backToBottom': { 'zh-CN': '↓ 回到底部', en: '↓ Back to bottom' },
  'stream.working': { 'zh-CN': '处理中', en: 'Working' },
  'stream.completed': { 'zh-CN': '已处理', en: 'Processed' },
  'stream.reasoning': { 'zh-CN': '思考过程', en: 'Reasoning' },
  'stream.reasoningLive': { 'zh-CN': '思考中…', en: 'Thinking…' },
  'stream.thoughtFor': { 'zh-CN': '思考了 {s} 秒', en: 'Thought for {s}s' },
  'stream.steps': { 'zh-CN': '{n} 步浏览器操作', en: '{n} browser steps' },
  'tool.params': { 'zh-CN': '参数', en: 'Parameters' },
  'tool.result': { 'zh-CN': '结果', en: 'Result' },
  'tool.error': { 'zh-CN': '错误', en: 'Error' },
  'tool.status.pending': { 'zh-CN': '等待执行', en: 'Pending' },
  'tool.status.running': { 'zh-CN': '正在执行', en: 'Running' },
  'tool.status.ok': { 'zh-CN': '执行成功', en: 'Succeeded' },
  'tool.status.fail': { 'zh-CN': '执行失败', en: 'Failed' },
  'evidence.title': { 'zh-CN': '执行证据', en: 'Execution evidence' },
  'evidence.attempts': { 'zh-CN': '{n} 次尝试', en: '{n} attempt(s)' },
  'evidence.observed': { 'zh-CN': '已观察', en: 'Observed' },
  'evidence.effect.dispatched': { 'zh-CN': '已派发', en: 'Dispatched' },
  'evidence.effect.observed': { 'zh-CN': '已观察', en: 'Observed' },
  'evidence.effect.verified': { 'zh-CN': '已验证', en: 'Verified' },
  'evidence.outcome.verified': { 'zh-CN': '已验证', en: 'Verified' },
  'evidence.outcome.failed': { 'zh-CN': '失败', en: 'Failed' },
  'evidence.outcome.uncertain': { 'zh-CN': '结果不确定', en: 'Uncertain' },
  'evidence.strategy.l0': { 'zh-CN': '浏览器操作', en: 'Browser operation' },
  'evidence.strategy.l1': { 'zh-CN': '页面操作', en: 'Page operation' },
  'evidence.strategy.l2': { 'zh-CN': '调试器操作', en: 'Debugger operation' },
  'evidence.phase.resolve': { 'zh-CN': '解析目标', en: 'Resolve target' },
  'evidence.phase.precheck': { 'zh-CN': '执行前检查', en: 'Pre-check' },
  'evidence.phase.execute': { 'zh-CN': '执行', en: 'Execute' },
  'evidence.phase.settle': { 'zh-CN': '等待稳定', en: 'Settle' },
  'evidence.phase.verify': { 'zh-CN': '验证', en: 'Verify' },
  'evidence.phase.recover': { 'zh-CN': '恢复', en: 'Recover' },
  'evidence.failure.stale_ref': { 'zh-CN': '引用已过期', en: 'Stale reference' },
  'evidence.failure.detached': { 'zh-CN': '目标已分离', en: 'Target detached' },
  'evidence.failure.not_visible': { 'zh-CN': '目标不可见', en: 'Target not visible' },
  'evidence.failure.not_stable': { 'zh-CN': '目标不稳定', en: 'Target not stable' },
  'evidence.failure.disabled': { 'zh-CN': '目标已禁用', en: 'Target disabled' },
  'evidence.failure.not_editable': { 'zh-CN': '目标不可编辑', en: 'Target not editable' },
  'evidence.failure.occluded': { 'zh-CN': '目标被遮挡', en: 'Target occluded' },
  'evidence.failure.ambiguous_target': { 'zh-CN': '目标不明确', en: 'Ambiguous target' },
  'evidence.failure.unsupported_frame': { 'zh-CN': '不支持的框架', en: 'Unsupported frame' },
  'evidence.failure.l1_not_effective': { 'zh-CN': '页面操作未生效', en: 'Page action ineffective' },
  'evidence.failure.navigation_uncertain': {
    'zh-CN': '导航结果不确定',
    en: 'Navigation uncertain',
  },
  'evidence.failure.safety_boundary_unavailable': {
    'zh-CN': '安全边界不可用',
    en: 'Safety boundary unavailable',
  },
  'evidence.failure.timeout': { 'zh-CN': '超时', en: 'Timed out' },
  'evidence.failure.aborted': { 'zh-CN': '已中止', en: 'Aborted' },
  'evidence.failure.unknown': { 'zh-CN': '未知错误', en: 'Unknown error' },
  'evidence.observedEffect.url_changed': { 'zh-CN': '网址已变化', en: 'URL changed' },
  'evidence.observedEffect.dom_changed': { 'zh-CN': '页面内容已变化', en: 'Page content changed' },
  'evidence.observedEffect.target_state_changed': {
    'zh-CN': '目标状态已变化',
    en: 'Target state changed',
  },
  'evidence.observedEffect.focus_changed': { 'zh-CN': '焦点已变化', en: 'Focus changed' },
  'evidence.observedEffect.tab_created': { 'zh-CN': '已创建标签页', en: 'Tab created' },
  'context.currentPage': { 'zh-CN': '当前页', en: 'Current page' },
  'context.screenshot': { 'zh-CN': '截图（{title}）', en: 'Screenshot ({title})' },
  'context.selection': { 'zh-CN': '选中文本（{title}）', en: 'Selected text ({title})' },
  'context.contentTruncated': { 'zh-CN': '[内容已截断]', en: '[Content truncated]' },
  'context.pageContent': {
    'zh-CN': '页面：{title}\n网址：{url}\n\n{content}',
    en: 'Page: {title}\nURL: {url}\n\n{content}',
  },
  'context.selectionContent': {
    'zh-CN': '选自 {url}：\n\n{content}',
    en: 'Selection from {url}:\n\n{content}',
  },
  'skills.variableSelect': { 'zh-CN': '选择…', en: 'Select…' },
};

let currentLang: Lang = 'zh-CN';
const languageListeners = new Set<() => void>();

function storedLanguage(value: unknown): Lang {
  return (value as GlobalSettings | undefined)?.language === 'en' ? 'en' : 'zh-CN';
}

export function setLang(lang: Lang): void {
  const changed = currentLang !== lang;
  currentLang = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  if (changed) for (const listener of languageListeners) listener();
}

export function getLang(): Lang {
  return currentLang;
}

export function subscribeLang(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

export function useLanguage(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

export async function bootstrapLanguage(): Promise<() => void> {
  let storageGeneration = 0;
  const stop = onStorageChange('global_settings', (value) => {
    storageGeneration += 1;
    setLang(storedLanguage(value));
  });
  const readGeneration = storageGeneration;
  try {
    const settings = await SettingsStore.global.get();
    if (storageGeneration === readGeneration) setLang(storedLanguage(settings));
  } catch {
    if (storageGeneration === readGeneration) setLang('zh-CN');
  }
  return stop;
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
