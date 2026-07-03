/**
 * SettingsPanel — the settings surface shared by the in-app modal and the
 * standalone options page. Left vertical tab nav + section content
 * (docs/09 §3.4), built on shadcn/ui Tabs (Radix: real tablist semantics,
 * arrow-key navigation). Interaction pattern follows OpenWebUI's settings
 * dialog: vertical tabs + grouped forms + immediate persistence.
 */

import { useEffect, useState } from 'react';
import {
  Cog,
  Database,
  Info,
  Plug,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { ProvidersPage } from './ProvidersPage';
import { PermissionsPage } from './PermissionsPage';
import { SkillsPage } from './SkillsPage';
import { McpPage } from './McpPage';
import { DataPage } from './DataPage';
import { SettingsStore, type GlobalSettings } from '../../settings/store';
import { setLang } from '../i18n';

const SECTIONS = [
  { id: 'general', label: '通用', Icon: Cog },
  { id: 'providers', label: '模型', Icon: Zap },
  { id: 'permissions', label: '浏览器权限', Icon: Shield },
  { id: 'skills', label: 'Skills', Icon: Sparkles },
  { id: 'mcp', label: 'MCP 服务器', Icon: Plug },
  { id: 'data', label: '数据', Icon: Database },
  { id: 'about', label: '关于', Icon: Info },
] as const;

export type SettingsSectionId = (typeof SECTIONS)[number]['id'];

interface Props {
  initialSection?: SettingsSectionId;
  /** Rendered in the nav footer (e.g. a close button in modal mode). */
  footer?: React.ReactNode;
}

export function SettingsPanel({ initialSection = 'providers', footer }: Props) {
  // Layout classes are all EXPLICIT (flex/flex-col/w-full/h-auto) rather than
  // relying on the tabs.tsx group-data-[orientation] variant chain — the
  // vertical variants proved fragile across build targets and a collapsed
  // list is unusable (user-reported regression).
  return (
    <Tabs
      defaultValue={initialSection}
      orientation="vertical"
      className="flex h-full min-h-0 flex-row gap-0 bg-background text-foreground"
    >
      <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-card p-3">
        <div className="mb-4 px-2 text-[15px] font-semibold">
          <span className="text-primary">Panelot</span> 设置
        </div>
        <TabsList variant="line" className="flex h-auto w-full flex-1 flex-col items-stretch justify-start gap-0.5 bg-transparent p-0">
          {SECTIONS.map(({ id, label, Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              className="h-auto w-full flex-none justify-start gap-2.5 rounded-lg px-2.5 py-2 text-[13px] after:hidden data-[state=active]:bg-muted data-[state=active]:font-medium dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-muted"
            >
              <Icon className="size-4 opacity-70" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {footer && <div className="pt-2">{footer}</div>}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <TabsContent value="general"><GeneralPage /></TabsContent>
        <TabsContent value="providers"><ProvidersPage /></TabsContent>
        <TabsContent value="permissions"><PermissionsPage /></TabsContent>
        <TabsContent value="skills"><SkillsPage /></TabsContent>
        <TabsContent value="mcp"><McpPage /></TabsContent>
        <TabsContent value="data"><DataPage /></TabsContent>
        <TabsContent value="about"><AboutPage /></TabsContent>
      </main>
    </Tabs>
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
    if (patch.language) setLang(patch.language);
    await SettingsStore.global.set(next);
  };

  return (
    <div className="max-w-xl space-y-5">
      <h2 className="text-[16px] font-semibold">通用</h2>
      <div className="space-y-1.5">
        <Label htmlFor="global-prompt" className="text-[12px] text-muted-foreground">全局自定义指令</Label>
        <Textarea
          id="global-prompt"
          rows={4}
          value={settings.userGlobalPrompt ?? ''}
          onChange={(e) => void update({ userGlobalPrompt: e.target.value })}
          placeholder="例如：回复保持简洁；表格优先。"
        />
        <p className="text-[11px] text-faint-foreground">拼入 system prompt 的用户层，对所有会话生效。</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">语言</Label>
          <Select
            value={settings.language ?? 'zh-CN'}
            onValueChange={(v) => void update({ language: v as GlobalSettings['language'] })}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">主题</Label>
          <Select
            value={settings.theme ?? 'system'}
            onValueChange={(v) => void update({ theme: v as GlobalSettings['theme'] })}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="system">跟随系统</SelectItem>
              <SelectItem value="dark">暗色</SelectItem>
              <SelectItem value="light">亮色</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="max-w-xl space-y-3 text-[13px] leading-relaxed text-muted-foreground">
      <h2 className="text-[16px] font-semibold text-foreground">关于 Panelot</h2>
      <p>浏览器原生 AI Agent — 模型自带（BYOK）、能力可扩展（Skills / MCP）、数据全本地。</p>
      <p>会话、配置与 API Key 全部存储在本机，仅发往你自己配置的模型端点。无遥测。</p>
    </div>
  );
}
