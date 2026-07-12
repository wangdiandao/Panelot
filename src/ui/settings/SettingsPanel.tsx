/**
 * SettingsPanel — the settings surface shared by the in-app modal and the
 * standalone options page. Left vertical tab nav + section content
 * (docs/09 §3.4), built on shadcn/ui Tabs (Radix: real tablist semantics,
 * arrow-key navigation). Interaction pattern follows OpenWebUI's settings
 * dialog: vertical tabs + grouped forms + immediate persistence.
 */

import { useEffect, useState } from 'react';
import {
  Bot,
  Cog,
  Database,
  Globe2,
  Plug,
  Package,
  Paperclip,
  Search,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
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
import { PluginsPage } from './PluginsPage';
import { PresetsPage } from './PresetsPage';
import { SiteInstructionsPage } from './SiteInstructionsPage';
import { AttachmentsPage } from './AttachmentsPage';
import { SettingsStore, type GlobalSettings } from '../../settings/store';
import { setLang, t } from '../i18n';

const SECTIONS = [
  { id: 'attachments', label: 'Attachments', Icon: Paperclip },
  { id: 'sites', label: 'Sites', Icon: Globe2 },
  { id: 'presets', label: 'Presets', Icon: Bot },
  { id: 'general', label: '通用', Icon: Cog },
  { id: 'providers', label: '模型', Icon: Zap },
  { id: 'permissions', label: '浏览器权限', Icon: Shield },
  { id: 'skills', label: 'Skills', Icon: Sparkles },
  { id: 'plugins', label: 'Plugins', Icon: Package },
  { id: 'mcp', label: 'MCP 服务器', Icon: Plug },
  { id: 'data', label: '数据', Icon: Database },
  { id: 'about', label: '关于', Icon: Cog },
] as const;

export type SettingsSectionId = (typeof SECTIONS)[number]['id'];

/**
 * Human-vocabulary → tab mapping (OpenWebUI's settings-search pattern:
 * searching filters NAVIGATION, not a flat result list). Keywords are
 * bilingual — '密钥' and 'key' both land on Providers.
 */
const SECTION_KEYWORDS: Record<SettingsSectionId, string[]> = {
  attachments: ['attachment', 'attachments', 'file', 'upload', 'screenshot', 'storage'],
  sites: ['site', 'sites', 'domain', 'hostname', 'instruction', 'prompt'],
  presets: ['preset', 'presets', 'agent', 'system prompt', 'temperature', 'tools', 'skills'],
  general: [
    '通用',
    'general',
    '语言',
    'language',
    '主题',
    'theme',
    '暗色',
    'dark',
    '指令',
    'prompt',
    '自定义',
  ],
  providers: [
    '模型',
    'model',
    'provider',
    '连接',
    'connection',
    '密钥',
    'key',
    'api',
    'baseurl',
    'endpoint',
    'openai',
    'anthropic',
    '验证',
    'verify',
  ],
  permissions: [
    '权限',
    'permission',
    '审批',
    'approval',
    '黑名单',
    'blacklist',
    '敏感',
    'sensitive',
    '规则',
    'rule',
    '安全',
    'safety',
    '写操作',
    'write',
  ],
  skills: ['skill', 'skills', '技能', '命令', 'command', 'slash', '斜杠', '导入', 'import'],
  plugins: ['plugin', 'plugins', '插件', 'zip', 'github', '安装', '卸载'],
  mcp: ['mcp', '服务器', 'server', 'oauth', '工具', 'tool', '集成', 'integration'],
  data: [
    '数据',
    'data',
    '导出',
    'export',
    '导入',
    'import',
    '备份',
    'backup',
    '配额',
    'quota',
    '存储',
    'storage',
    '清理',
  ],
  about: ['关于', 'about', '版本', 'version', '帮助', 'help'],
};

/** Sections whose label or keywords match the query (exported for tests). */
export function filterSections(query: string): SettingsSectionId[] {
  const q = query.trim().toLowerCase();
  const all = SECTIONS.map((s) => s.id);
  if (!q) return all;
  return all.filter(
    (id) =>
      SECTIONS.find((s) => s.id === id)!
        .label.toLowerCase()
        .includes(q) || SECTION_KEYWORDS[id].some((k) => k.toLowerCase().includes(q)),
  );
}

interface Props {
  initialSection?: SettingsSectionId;
  /** Rendered in the nav footer (e.g. a close button in modal mode). */
  footer?: React.ReactNode;
}

export function SettingsPanel({ initialSection = 'providers', footer }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<SettingsSectionId>(initialSection);
  const visible = filterSections(query);

  // If the active tab is filtered out, jump to the first surviving match
  // (OpenWebUI behavior — searching '密钥' lands you inside Providers).
  useEffect(() => {
    if (visible.length > 0 && !visible.includes(active)) setActive(visible[0]!);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Layout classes are all EXPLICIT (flex/flex-col/w-full/h-auto) rather than
  // relying on the tabs.tsx group-data-[orientation] variant chain — the
  // vertical variants proved fragile across build targets and a collapsed
  // list is unusable (user-reported regression).
  return (
    <Tabs
      value={active}
      onValueChange={(v) => setActive(v as SettingsSectionId)}
      orientation="vertical"
      className="flex h-full min-h-0 flex-row gap-0 bg-background text-foreground"
    >
      <nav className="flex w-52 shrink-0 flex-col border-r border-border-soft bg-card p-3">
        <div className="mb-3 px-2 text-[15px] font-semibold">
          <span className="text-primary">Panelot</span> 设置
        </div>
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.search')}
            className="h-8 border-transparent bg-muted pl-8 text-[13px] shadow-none"
          />
        </div>
        <TabsList
          variant="line"
          className="flex h-auto w-full flex-1 flex-col items-stretch justify-start gap-0.5 overflow-y-auto bg-transparent p-0"
        >
          {SECTIONS.filter(({ id }) => visible.includes(id)).map(({ id, label, Icon }) => (
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
        {visible.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-faint-foreground">{t('settings.noMatch')}</div>
        )}
        {footer && <div className="pt-2">{footer}</div>}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <TabsContent value="attachments">
          <AttachmentsPage />
        </TabsContent>
        <TabsContent value="sites">
          <SiteInstructionsPage />
        </TabsContent>
        <TabsContent value="presets">
          <PresetsPage />
        </TabsContent>
        <TabsContent value="general">
          <GeneralPage />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersPage />
        </TabsContent>
        <TabsContent value="permissions">
          <PermissionsPage />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsPage />
        </TabsContent>
        <TabsContent value="plugins">
          <PluginsPage />
        </TabsContent>
        <TabsContent value="mcp">
          <McpPage />
        </TabsContent>
        <TabsContent value="data">
          <DataPage />
        </TabsContent>
        <TabsContent value="about">
          <AboutPage />
        </TabsContent>
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
      <h2 className="text-[15px] font-semibold">通用</h2>
      <div className="space-y-1.5">
        <Label htmlFor="global-prompt" className="text-[12px] text-muted-foreground">
          全局自定义指令
        </Label>
        <Textarea
          id="global-prompt"
          rows={4}
          value={settings.userGlobalPrompt ?? ''}
          onChange={(e) => void update({ userGlobalPrompt: e.target.value })}
          placeholder="例如：回复保持简洁；表格优先。"
        />
        <p className="text-[11px] text-faint-foreground">
          拼入 system prompt 的用户层，对所有会话生效。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">语言</Label>
          <Select
            value={settings.language ?? 'zh-CN'}
            onValueChange={(v) => void update({ language: v as GlobalSettings['language'] })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
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
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
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
  // Version comes from the manifest (single source: package.json → wxt build).
  // Guarded so the chrome-less preview server renders without it.
  const version =
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : null;
  return (
    <div className="max-w-xl space-y-3 text-[13px] leading-relaxed text-muted-foreground">
      <h2 className="text-[15px] font-semibold text-foreground">
        关于 Panelot
        {version && <span className="ml-2 font-normal text-faint-foreground">v{version}</span>}
      </h2>
      <p>浏览器原生 AI Agent — 模型自带（BYOK）、能力可扩展（Skills / MCP）、数据全本地。</p>
      <p>会话、配置与 API Key 全部存储在本机，仅发往你自己配置的模型端点。无遥测。</p>
      <p>
        <a
          href="https://github.com/wangdiandao/Panelot"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-2 hover:underline"
        >
          github.com/wangdiandao/Panelot
        </a>
      </p>
    </div>
  );
}
