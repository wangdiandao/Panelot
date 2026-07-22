/**
 * SettingsPanel — the settings surface shared by the in-app modal and the
 * standalone options page. Left vertical tab nav + section content
 * (docs/development/ui.md §3.4), built on shadcn/ui Tabs (Radix: real tablist semantics,
 * arrow-key navigation). Interaction pattern follows OpenWebUI's settings
 * dialog: vertical tabs + grouped forms + immediate persistence.
 */

import { useState } from 'react';
import {
  Bot,
  Code2,
  Cog,
  Database,
  ExternalLink,
  Globe2,
  Info,
  Plug,
  Package,
  Paperclip,
  Search,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import {
  Select,
  SelectContent,
  SelectGroup,
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
import { useStorageValue } from '../useStorageValue';

const SECTIONS = [
  { id: 'attachments', labelKey: 'settings.section.attachments', Icon: Paperclip },
  { id: 'sites', labelKey: 'settings.section.sites', Icon: Globe2 },
  { id: 'presets', labelKey: 'settings.section.presets', Icon: Bot },
  { id: 'general', labelKey: 'settings.section.general', Icon: Cog },
  { id: 'providers', labelKey: 'settings.section.providers', Icon: Zap },
  { id: 'permissions', labelKey: 'settings.section.permissions', Icon: Shield },
  { id: 'skills', labelKey: 'settings.section.skills', Icon: Sparkles },
  { id: 'plugins', labelKey: 'settings.section.plugins', Icon: Package },
  { id: 'mcp', labelKey: 'settings.section.mcp', Icon: Plug },
  { id: 'data', labelKey: 'settings.section.data', Icon: Database },
  { id: 'about', labelKey: 'settings.section.about', Icon: Info },
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
      settingsSectionLabel(id).toLowerCase().includes(q) ||
      SECTION_KEYWORDS[id].some((k) => k.toLowerCase().includes(q)),
  );
}

export function settingsSectionLabel(id: SettingsSectionId): string {
  const section = SECTIONS.find((candidate) => candidate.id === id);
  return section ? t(section.labelKey) : id;
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
  const visibleActive = visible.includes(active) ? active : (visible[0] ?? active);

  // If the active tab is filtered out, jump to the first surviving match
  // (OpenWebUI behavior — searching '密钥' lands you inside Providers).
  // Layout classes are all EXPLICIT (flex/flex-col/w-full/h-auto) rather than
  // relying on the tabs.tsx group-data-[orientation] variant chain — the
  // vertical variants proved fragile across build targets and a collapsed
  // list is unusable (user-reported regression).
  return (
    <Tabs
      value={visibleActive}
      onValueChange={(v) => setActive(v as SettingsSectionId)}
      orientation="vertical"
      className="flex h-full min-h-0 flex-col gap-0 bg-background text-foreground sm:flex-row"
    >
      <nav className="flex max-h-[45vh] w-full shrink-0 flex-col border-b border-border-soft bg-card p-3 sm:max-h-none sm:w-52 sm:border-r sm:border-b-0">
        <div className="mb-3 px-2 text-[15px] font-semibold">{t('settings.title')}</div>
        <InputGroup className="mb-2">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.search')}
            aria-label={t('settings.search')}
          />
        </InputGroup>
        <TabsList variant="line" className="w-full flex-1 overflow-y-auto">
          {SECTIONS.filter(({ id }) => visible.includes(id)).map(({ id, Icon }) => (
            <TabsTrigger key={id} value={id}>
              <Icon aria-hidden="true" />
              {settingsSectionLabel(id)}
            </TabsTrigger>
          ))}
        </TabsList>
        {visible.length === 0 && (
          <Empty className="p-3 md:p-3">
            <EmptyHeader>
              <EmptyTitle>{t('settings.noMatch')}</EmptyTitle>
              <EmptyDescription>{t('settings.search')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {footer && <div className="pt-2">{footer}</div>}
      </nav>
      <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
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
  const settings = useStorageValue<GlobalSettings | null>('global_settings', null) ?? {};

  const update = async (patch: Partial<GlobalSettings>) => {
    if (patch.language) setLang(patch.language);
    await SettingsStore.global.patch(patch);
  };

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <h2 className="text-[15px] font-semibold">{t('settings.section.general')}</h2>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="global-prompt">{t('settings.general.prompt')}</FieldLabel>
          <Textarea
            id="global-prompt"
            rows={4}
            value={settings.userGlobalPrompt ?? ''}
            onChange={(e) => void update({ userGlobalPrompt: e.target.value })}
            placeholder={t('settings.general.promptPlaceholder')}
          />
          <FieldDescription>{t('settings.general.promptHint')}</FieldDescription>
        </Field>
      </FieldGroup>
      <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="settings-language">{t('settings.general.language')}</FieldLabel>
          <Select
            value={settings.language ?? 'zh-CN'}
            onValueChange={(v) => void update({ language: v as GlobalSettings['language'] })}
          >
            <SelectTrigger id="settings-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="zh-CN">中文</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-theme">{t('settings.general.theme')}</FieldLabel>
          <Select
            value={settings.theme ?? 'system'}
            onValueChange={(v) => void update({ theme: v as GlobalSettings['theme'] })}
          >
            <SelectTrigger id="settings-theme" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="system">{t('settings.general.theme.system')}</SelectItem>
                <SelectItem value="dark">{t('settings.general.theme.dark')}</SelectItem>
                <SelectItem value="light">{t('settings.general.theme.light')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
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
    <div className="flex max-w-2xl flex-col gap-5">
      <h2 className="text-[15px] font-semibold">{t('settings.about.title')}</h2>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 p-5 sm:p-6">
          <img
            src="/icon/128.png"
            alt=""
            aria-hidden="true"
            className="size-14 rounded-2xl shadow-sm sm:size-16"
          />
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle className="flex flex-wrap items-baseline gap-2">
              <span>Panelot</span>
              {version && (
                <span className="text-xs font-normal text-muted-foreground">v{version}</span>
              )}
            </CardTitle>
            <CardDescription className="leading-relaxed">
              {t('settings.about.summary')}
            </CardDescription>
          </div>
        </CardHeader>

        <CardFooter className="justify-start px-5 pb-5 sm:px-6 sm:pb-6">
          <Button variant="outline" size="sm" asChild>
            <a href="https://github.com/wangdiandao/Panelot" target="_blank" rel="noreferrer">
              <Code2 data-icon="inline-start" aria-hidden="true" />
              {t('settings.about.github')}
              <ExternalLink data-icon="inline-end" aria-hidden="true" />
            </a>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
