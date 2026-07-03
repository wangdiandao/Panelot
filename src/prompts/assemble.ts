/**
 * Layered system-prompt assembly + untrusted-content fencing (docs/10 §1/§4/§6).
 *
 * Layer order (stability descending, cache breakpoint after layer 2 is applied
 * by the Anthropic adapter via cache_control on `system`):
 *   [1] kernel  [2] (tools, in request)  [3] user global  [4] site prompts
 *   [5] skills index  [6] environment block
 */

import { KERNEL_PROMPT } from './kernel';

export interface SkillIndexEntry {
  name: string;
  description: string;
  sites?: string[];
}

export interface AssembleOptions {
  userGlobalPrompt?: string;
  /** Site-level prompts matching the current controlled tab (docs/08 §6). */
  sitePrompts?: { pattern: string; prompt: string }[];
  skillsIndex?: SkillIndexEntry[];
  environment?: {
    date?: string;
    language?: string;
    activeTab?: { url: string; title: string };
    approvalPolicy?: string;
    capabilityScope?: string;
  };
  /** Preset-level system prompt (ModelPreset.systemPrompt) sits with the user layer. */
  presetPrompt?: string;
}

export function assembleSystemPrompt(opts: AssembleOptions = {}): string {
  const layers: string[] = [KERNEL_PROMPT];

  if (opts.presetPrompt?.trim()) layers.push(opts.presetPrompt.trim());
  if (opts.userGlobalPrompt?.trim()) {
    layers.push(`# User instructions\n${opts.userGlobalPrompt.trim()}`);
  }
  if (opts.sitePrompts?.length) {
    const site = opts.sitePrompts
      .map((s) => `## ${s.pattern}\n${s.prompt.trim()}`)
      .join('\n\n');
    layers.push(`# Site instructions\n${site}`);
  }
  if (opts.skillsIndex?.length) {
    const index = opts.skillsIndex
      .map((s) => `- ${s.name}: ${s.description}${s.sites?.length ? ` [sites: ${s.sites.join(', ')}]` : ''}`)
      .join('\n');
    layers.push(
      `# Skills\nThe following skills are available. Call load_skill(name) before doing a matching task.\n${index}`,
    );
  }
  if (opts.environment) {
    const e = opts.environment;
    const lines: string[] = [];
    if (e.date) lines.push(`Date: ${e.date}`);
    if (e.language) lines.push(`User language: ${e.language}`);
    if (e.activeTab) lines.push(`Active tab: ${e.activeTab.title} — ${e.activeTab.url}`);
    if (e.approvalPolicy) lines.push(`Approval policy: ${e.approvalPolicy}`);
    if (e.capabilityScope) lines.push(`Capability scope: ${e.capabilityScope}`);
    if (lines.length) layers.push(`# Environment\n${lines.join('\n')}`);
  }

  return layers.join('\n\n');
}

// ---------------------------------------------------------------------------
// Untrusted content fencing (docs/10 §4)
// ---------------------------------------------------------------------------

/**
 * Wrap web/file/MCP-sourced content in delimiter markers with a random suffix
 * so page content cannot forge a closing tag. Applied by the engine at
 * tool_result assembly — tools themselves never fence.
 */
export function fenceUntrusted(content: string, origin: string, tool: string): string {
  const suffix = randomSuffix();
  const tag = `web_content_${suffix}`;
  // Defense in depth: if the content somehow contains our random tag (astronomically
  // unlikely), strip it.
  const safe = content.replaceAll(`<<<end_${tag}>>>`, '');
  return `<<<${tag} origin="${origin}" tool="${tool}">>>\n${safe}\n<<<end_${tag}>>>`;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 6);
}
