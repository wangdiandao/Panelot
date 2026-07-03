/**
 * SettingsPanel — the settings surface shared by the in-app modal and the
 * standalone options page. Left vertical nav + section content (docs/09 §3.4).
 * Moving this in-app means users configure without leaving the conversation.
 */

import { useEffect, useState } from 'react';
import { ProvidersPage } from './ProvidersPage';
import { PermissionsPage } from './PermissionsPage';
import { SkillsPage } from './SkillsPage';
import { McpPage } from './McpPage';
import { DataPage } from './DataPage';
import { SettingsStore, type GlobalSettings } from '../../settings/store';

const SECTIONS = [
  { id: 'general', label: '通用', icon: '⚙' },
  { id: 'providers', label: '模型', icon: '⚡' },
  { id: 'permissions', label: '浏览器权限', icon: '🛡' },
  { id: 'skills', label: 'Skills', icon: '✦' },
  { id: 'mcp', label: 'MCP 服务器', icon: '⧉' },
  { id: 'data', label: '数据', icon: '⛃' },
  { id: 'about', label: '关于', icon: 'ⓘ' },
] as const;

export type SettingsSectionId = (typeof SECTIONS)[number]['id'];

interface Props {
  initialSection?: SettingsSectionId;
  /** Rendered in the nav footer (e.g. a close button in modal mode). */
  footer?: React.ReactNode;
}

export function SettingsPanel({ initialSection = 'providers', footer }: Props) {
  const [section, setSection] = useState<SettingsSectionId>(initialSection);

  return (
    <div className="flex h-full min-h-0 bg-bg text-text">
      <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-surface p-3">
        <div className="mb-4 px-2 text-[15px] font-semibold">
          <span className="text-accent">Panelot</span> 设置
        </div>
        <div className="flex-1 space-y-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                section === s.id ? 'bg-surface-2 font-medium text-text' : 'text-text-dim hover:bg-surface-2/60 hover:text-text'
              }`}
            >
              <span className="w-4 text-center text-[13px] opacity-70">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </div>
        {footer && <div className="pt-2">{footer}</div>}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        {section === 'general' && <GeneralPage />}
        {section === 'providers' && <ProvidersPage />}
        {section === 'permissions' && <PermissionsPage />}
        {section === 'skills' && <SkillsPage />}
        {section === 'mcp' && <McpPage />}
        {section === 'data' && <DataPage />}
        {section === 'about' && <AboutPage />}
      </main>
    </div>
  );
}

function GeneralPage() {
  const [settings, setSettings] = useState<GlobalSettings>({});

  useEffect(() => {
    void SettingsStore.global.get().then(setSettings);
  }, []);

  const update = async (patch: Partial<GlobalSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await SettingsStore.global.set(next);
  };

  const input = 'w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] outline-none transition-colors focus:border-accent/60';

  return (
    <div className="max-w-xl space-y-5">
      <h2 className="text-[16px] font-semibold">通用</h2>
      <div>
        <label className="mb-1.5 block text-[12px] font-medium text-text-dim">全局自定义指令</label>
        <textarea
          className={input}
          rows={4}
          value={settings.userGlobalPrompt ?? ''}
          onChange={(e) => void update({ userGlobalPrompt: e.target.value })}
          placeholder="例如：回复保持简洁；表格优先。"
        />
        <p className="mt-1 text-[11px] text-text-faint">拼入 system prompt 的用户层，对所有会话生效。</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-text-dim">语言</label>
          <select className={input} value={settings.language ?? 'zh-CN'} onChange={(e) => void update({ language: e.target.value as GlobalSettings['language'] })}>
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-text-dim">主题</label>
          <select className={input} value={settings.theme ?? 'system'} onChange={(e) => void update({ theme: e.target.value as GlobalSettings['theme'] })}>
            <option value="system">跟随系统</option>
            <option value="dark">暗色</option>
            <option value="light">亮色</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="max-w-xl space-y-3 text-[13px] leading-relaxed text-text-dim">
      <h2 className="text-[16px] font-semibold text-text">关于 Panelot</h2>
      <p>浏览器原生 AI Agent — 模型自带（BYOK）、能力可扩展（Skills / MCP）、数据全本地。</p>
      <p>会话、配置与 API Key 全部存储在本机，仅发往你自己配置的模型端点。无遥测。</p>
    </div>
  );
}
