/**
 * Data sources for the TriggerMenu (docs/development/ui.md §5):
 *   @  → open tabs
 *   /  → built-in commands + all enabled Skills (activated on send)
 *   {{ → dynamic variables, evaluated at submit time
 * MCP Prompts join the / list with the command palette phase (S5).
 */

import { useEffect, useState } from 'react';
import type { ContextBlock, SubmissionBrowserContext } from '../../messaging/protocol';
import { attachSelectionFromTab, attachTab, listAttachableTabs } from '../pageContext';
import type { SkillFrontmatter, VariableDef } from '../../skills/parse';
import type { TriggerItem, TriggerState } from './TriggerMenu';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { t } from '../i18n';

export const DYNAMIC_VARIABLES = [
  'PAGE_URL',
  'PAGE_TITLE',
  'SELECTION',
  'CLIPBOARD',
  'CURRENT_DATE',
] as const;

/** Evaluate {{VAR}} placeholders at submit time (docs/development/ui.md §5). */
export async function evaluateVariables(
  text: string,
  browserContext?: SubmissionBrowserContext,
): Promise<string> {
  if (!/\{\{(PAGE_URL|PAGE_TITLE|SELECTION|CLIPBOARD|CURRENT_DATE)\}\}/.test(text)) return text;
  const values = new Map<string, string>();
  values.set('CURRENT_DATE', new Date().toISOString().slice(0, 10));
  if (text.includes('{{PAGE_URL}}') || text.includes('{{PAGE_TITLE}}')) {
    values.set('PAGE_URL', browserContext?.defaultTab?.url ?? '');
    values.set('PAGE_TITLE', browserContext?.defaultTab?.title ?? '');
  }
  if (text.includes('{{SELECTION}}')) {
    const sel = browserContext?.defaultTab
      ? await attachSelectionFromTab(browserContext.defaultTab)
      : null;
    const first = sel?.content[0];
    values.set('SELECTION', first?.type === 'text' ? first.text : '');
  }
  if (text.includes('{{CLIPBOARD}}')) {
    try {
      values.set('CLIPBOARD', await navigator.clipboard.readText());
    } catch {
      values.set('CLIPBOARD', '');
    }
  }
  return text.replace(
    /\{\{(PAGE_URL|PAGE_TITLE|SELECTION|CLIPBOARD|CURRENT_DATE)\}\}/g,
    (_, k: string) => values.get(k) ?? '',
  );
}

export interface SkillCommand {
  command: string;
  skillName: string;
  description: string;
  variables?: VariableDef[];
}

/** Enabled skills as slash commands (shared by TriggerMenu and the + menu). */
export async function listSkillCommands(): Promise<SkillCommand[]> {
  const [{ PanelotDB }, { SkillManager }] = await Promise.all([
    import('../../db/schema'),
    import('../../skills/manager'),
  ]);
  const skillManager = new SkillManager(new PanelotDB());
  const skills = await skillManager.list();
  const cmds: SkillCommand[] = [];
  for (const s of skills) {
    if (!s.enabled) continue;
    const fm = s.frontmatter as SkillFrontmatter;
    cmds.push({
      command: fm.panelot?.command ?? `/${s.name}`,
      skillName: s.name,
      description: fm.description,
      variables: fm.panelot?.variables,
    });
  }
  return cmds;
}

interface McpCatalog {
  ok: boolean;
  prompts?: {
    command: string;
    serverId: string;
    prompt: string;
    args: { name: string; required?: boolean }[];
  }[];
  resources?: {
    serverId: string;
    uri: string;
    name: string;
    description?: string;
    origin?: string;
  }[];
}

async function listMcpCatalog(): Promise<McpCatalog> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return { ok: true };
  return chrome.runtime.sendMessage({ type: 'panelot.mcpCatalog' }) as Promise<McpCatalog>;
}

export interface BuiltinCommand {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

interface Callbacks {
  attachContext: (block: ContextBlock) => void;
  /** Replace the active trigger text with `replacement` in the input. */
  replaceTrigger: (replacement: string) => void;
  /** Open the variable form for a skill command. */
  openVariableForm: (cmd: SkillCommand) => void;
  builtinCommands: BuiltinCommand[];
}

/** Assemble TriggerMenu items for the active trigger. */
export function useTriggerItems(trigger: TriggerState | null, cb: Callbacks): TriggerItem[] {
  const [tabs, setTabs] = useState<{ id: number; title: string; url: string }[]>([]);
  const [skillCommands, setSkillCommands] = useState<SkillCommand[]>([]);
  const [mcpResources, setMcpResources] = useState<NonNullable<McpCatalog['resources']>>([]);

  useEffect(() => {
    if (trigger?.kind !== '@') return;
    void Promise.all([listAttachableTabs(), listMcpCatalog()]).then(([nextTabs, catalog]) => {
      setTabs(nextTabs);
      setMcpResources(catalog.ok ? (catalog.resources ?? []) : []);
    });
  }, [trigger?.kind]);

  useEffect(() => {
    if (trigger?.kind !== '/') return;
    // Every enabled Skill is a slash command; panelot.command only renames it.
    void Promise.all([listSkillCommands(), listMcpCatalog()]).then(([skills, catalog]) => {
      const prompts: SkillCommand[] = (catalog.ok ? (catalog.prompts ?? []) : []).map((prompt) => ({
        command: prompt.command,
        skillName: `${prompt.serverId}:${prompt.prompt}`,
        description: t('input.mcpPrompt', { server: prompt.serverId }),
        variables: prompt.args.map((argument) => ({
          key: argument.name,
          label: argument.name,
          type: 'text',
          required: argument.required,
        })),
      }));
      setSkillCommands([...skills, ...prompts]);
    });
  }, [trigger?.kind]);

  if (!trigger) return [];

  if (trigger.kind === '@') {
    const attach = (fn: () => Promise<ContextBlock | null>) => async () => {
      cb.replaceTrigger('');
      const block = await fn();
      if (block) cb.attachContext(block);
    };
    return [
      ...tabs.map((tab) => ({
        id: `tab-${tab.id}`,
        kind: '@' as const,
        group: t('input.group.openTabs'),
        label: tab.title,
        hint: new URL(tab.url).hostname,
        icon: 'tab' as const,
        action: attach(() => attachTab(tab.id, tab.url)),
      })),
      ...mcpResources.map((resource) => ({
        id: `mcp-${resource.serverId}-${resource.uri}`,
        kind: '@' as const,
        group: t('input.group.mcpResources'),
        label: resource.name,
        hint: resource.description ?? resource.uri,
        icon: 'page' as const,
        action: async () => {
          cb.replaceTrigger('');
          if (resource.origin && !(await hostPermissionBroker.request(resource.origin))) return;
          const response = (await chrome.runtime.sendMessage({
            type: 'panelot.mcpReadResource',
            serverId: resource.serverId,
            uri: resource.uri,
          })) as { ok: boolean; context?: ContextBlock };
          if (response.ok && response.context) cb.attachContext(response.context);
        },
      })),
    ];
  }

  if (trigger.kind === '/') {
    return [
      ...cb.builtinCommands.map((c) => ({
        id: c.id,
        kind: '/' as const,
        group: t('input.group.builtinCommands'),
        label: c.id,
        hint: c.hint,
        icon: 'command' as const,
        action: () => {
          cb.replaceTrigger('');
          c.run();
        },
      })),
      ...skillCommands.map((c) => ({
        id: c.command,
        kind: '/' as const,
        group: t('input.group.skills'),
        label: c.command,
        hint: c.description,
        icon: 'command' as const,
        action: () => {
          if (c.variables?.length) {
            cb.replaceTrigger('');
            cb.openVariableForm(c);
          } else {
            cb.replaceTrigger(`${c.command} `);
          }
        },
      })),
    ];
  }

  // '{{' — dynamic variables
  return DYNAMIC_VARIABLES.map((v) => ({
    id: v,
    kind: '{{' as const,
    group: t('input.group.dynamicVariables'),
    label: `{{${v}}}`,
    icon: 'variable' as const,
    action: () => cb.replaceTrigger(`{{${v}}} `),
  }));
}
