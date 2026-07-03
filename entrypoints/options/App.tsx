/**
 * Options page (docs/09 §3.4): left vertical nav; sections fill in as their
 * subsystems land (permissions with Phase 7, Skills/MCP/Plugins with Phase 9).
 */

import { useEffect, useState } from 'react';
import { ProvidersPage } from './ProvidersPage';
import { PermissionsPage } from './PermissionsPage';
import { SettingsStore, type GlobalSettings } from '../../src/settings/store';

const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'providers', label: 'Providers' },
  { id: 'permissions', label: '浏览器权限' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP 服务器' },
  { id: 'data', label: '数据' },
  { id: 'about', label: '关于' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function App() {
  const [section, setSection] = useState<SectionId>('providers');

  return (
    <div className="flex h-screen bg-bg text-text">
      <nav className="w-48 shrink-0 border-r border-border bg-surface p-3">
        <div className="mb-4 px-2 text-[15px] font-semibold text-accent">Panelot 设置</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={`block w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 ${
              section === s.id ? 'bg-surface-2 font-medium text-accent' : 'text-text-dim'
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {section === 'general' && <GeneralPage />}
        {section === 'providers' && <ProvidersPage />}
        {section === 'permissions' && <PermissionsPage />}
        {section === 'skills' && <Placeholder text="Skills 管理将随生态能力一同上线。" />}
        {section === 'mcp' && <Placeholder text="MCP 服务器管理将随生态能力一同上线。" />}
        {section === 'data' && <Placeholder text="导入导出与存储管理将在打磨阶段上线。" />}
        {section === 'about' && <AboutPage />}
      </main>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="rounded-[10px] border border-dashed border-border p-8 text-center text-[13px] text-text-dim">{text}</div>;
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

  const input = 'w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] outline-none focus:border-accent/60';

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-[15px] font-semibold">通用</h2>
      <div>
        <label className="mb-1 block text-[12px] text-text-dim">全局自定义指令（拼入 system prompt 用户层）</label>
        <textarea
          className={input}
          rows={4}
          value={settings.userGlobalPrompt ?? ''}
          onChange={(e) => void update({ userGlobalPrompt: e.target.value })}
          placeholder="例如：回复保持简洁；表格优先。"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[12px] text-text-dim">语言</label>
          <select className={input} value={settings.language ?? 'zh-CN'} onChange={(e) => void update({ language: e.target.value as GlobalSettings['language'] })}>
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] text-text-dim">主题</label>
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
    <div className="max-w-xl space-y-2 text-[13px] text-text-dim">
      <h2 className="text-[15px] font-semibold text-text">关于 Panelot</h2>
      <p>浏览器原生 AI Agent — 模型自带（BYOK）、能力可扩展（Skills / MCP）、数据全本地。</p>
      <p>会话、配置与 API Key 全部存储在本机，仅发往你自己配置的模型端点。无遥测。</p>
    </div>
  );
}
