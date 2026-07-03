/**
 * Minimal i18n (docs/09 §8): zh-CN / en string tables, browser-language
 * default. Kept dependency-free — the UI is small enough that a keyed lookup
 * with interpolation covers it.
 */

type Lang = 'zh-CN' | 'en';

const STRINGS: Record<string, { 'zh-CN': string; en: string }> = {
  'app.newChat': { 'zh-CN': '新会话', en: 'New chat' },
  'app.settings': { 'zh-CN': '设置', en: 'Settings' },
  'input.placeholder': { 'zh-CN': '问点什么… (@ 引用 / 命令)', en: 'Ask anything… (@ mention / command)' },
  'input.running': { 'zh-CN': '输入以插话，Esc 停止…', en: 'Type to steer, Esc to stop…' },
  'input.noProvider': { 'zh-CN': '先在设置中添加模型 →', en: 'Add a model in settings first →' },
  'approval.allowOnce': { 'zh-CN': '允许一次', en: 'Allow once' },
  'approval.allowSite': { 'zh-CN': '本站始终', en: 'Always on this site' },
  'approval.decline': { 'zh-CN': '拒绝', en: 'Decline' },
  'reconnecting': { 'zh-CN': '重新连接引擎…', en: 'Reconnecting to engine…' },
  'recovery.interrupted': { 'zh-CN': '任务此前被中断（可能是浏览器休眠）。', en: 'The task was interrupted (browser may have slept).' },
  'recovery.continue': { 'zh-CN': '继续', en: 'Continue' },
};

let currentLang: Lang = detectLang();

function detectLang(): Lang {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) return 'zh-CN';
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('en') ? 'en' : 'zh-CN';
}

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function t(key: keyof typeof STRINGS | string, vars?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  let text = entry ? entry[currentLang] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}
