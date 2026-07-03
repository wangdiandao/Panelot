/**
 * Browser permissions settings (docs/06 §7, docs/09 §3.4): two-axis default
 * selector + rule table (tool × site × verdict × source) + sensitive-origin
 * blacklist block.
 */

import { useEffect, useState } from 'react';
import { GatekeeperService } from '../../src/gatekeeper/service';
import { DEFAULT_SENSITIVE_PATTERNS, type PermissionRule } from '../../src/gatekeeper/rules';
import { SettingsStore, type GlobalSettings, storageGet, storageSet } from '../../src/settings/store';

const POLICY_DESC: Record<string, string> = {
  untrusted: '只自动放行只读操作，其余一律弹审批（推荐默认）',
  'on-request': '读操作放行；写操作首次弹审批，本轮同站同工具后续放行',
  never: '从不弹窗 = 需要审批的动作直接拒绝（绝非自动批准）',
  granular: '完全按规则表裁决，未覆盖的按 untrusted 兜底',
};

const SCOPE_DESC: Record<string, string> = {
  'read-only': '只能读，一切写操作被拒绝',
  'same-origin-write': '仅在任务作用域内的站点读写',
  'cross-origin': '可跨域读写，但每次触达新站点强制审批（推荐默认）',
  full: '无域名限制（仍受黑名单与 deny 规则约束）',
};

export function PermissionsPage() {
  const [settings, setSettings] = useState<GlobalSettings>({});
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [sensitive, setSensitive] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState('');

  useEffect(() => {
    void SettingsStore.global.get().then(setSettings);
    void GatekeeperService.listRules().then(setRules);
    void storageGet<string[]>('sensitive_origins', []).then(setSensitive);
  }, []);

  const updateSettings = async (patch: Partial<GlobalSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await SettingsStore.global.set(next);
  };

  const removeRule = async (id: string) => {
    await GatekeeperService.removeRule(id);
    setRules(await GatekeeperService.listRules());
  };

  const addSensitive = async () => {
    const p = newPattern.trim();
    if (!p) return;
    const next = [...sensitive, p];
    setSensitive(next);
    setNewPattern('');
    await storageSet('sensitive_origins', next);
  };

  const removeSensitive = async (p: string) => {
    const next = sensitive.filter((x) => x !== p);
    setSensitive(next);
    await storageSet('sensitive_origins', next);
  };

  const select = 'rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] outline-none focus:border-accent/60';

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-[15px] font-semibold">浏览器权限</h2>

      {/* Two-axis defaults */}
      <div className="space-y-3">
        <div className="text-[13px] font-medium text-text-dim">默认两轴档位</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-[12px] text-text-dim">审批策略（何时问）</label>
            <select
              className={`${select} w-full`}
              value={settings.defaultApprovalPolicy ?? 'untrusted'}
              onChange={(e) => void updateSettings({ defaultApprovalPolicy: e.target.value })}
            >
              {Object.keys(POLICY_DESC).map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <div className="mt-1 text-[11px] text-text-dim">{POLICY_DESC[settings.defaultApprovalPolicy ?? 'untrusted']}</div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-text-dim">能力域（能做什么·硬闸）</label>
            <select
              className={`${select} w-full`}
              value={settings.defaultCapabilityScope ?? 'cross-origin'}
              onChange={(e) => void updateSettings({ defaultCapabilityScope: e.target.value })}
            >
              {Object.keys(SCOPE_DESC).map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <div className="mt-1 text-[11px] text-text-dim">{SCOPE_DESC[settings.defaultCapabilityScope ?? 'cross-origin']}</div>
          </div>
        </div>
      </div>

      {/* Rule table */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-text-dim">权限规则</div>
        {rules.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-[12px] text-text-dim">
            暂无规则。审批时选择「本站始终」会在此生成持久规则。
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-text-dim">
                <th className="py-1">工具</th>
                <th>站点</th>
                <th>裁决</th>
                <th>来源</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border/50">
                  <td className="py-1 font-mono">{r.tool}</td>
                  <td className="font-mono">{r.origin}</td>
                  <td className={r.verdict === 'deny' ? 'text-danger' : 'text-ok'}>{r.verdict}</td>
                  <td className="text-text-dim">{r.source}</td>
                  <td className="text-right">
                    <button type="button" onClick={() => void removeRule(r.id)} className="text-text-dim hover:text-danger">
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Sensitive-origin blacklist */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-text-dim">敏感站点黑名单（硬拒绝，不可被规则覆盖）</div>
        <div className="flex gap-2">
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            placeholder="*.mybank.com"
            className={`${select} flex-1 font-mono`}
          />
          <button type="button" onClick={() => void addSensitive()} className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:brightness-110">
            添加
          </button>
        </div>
        {sensitive.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sensitive.map((p) => (
              <span key={p} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px]">
                {p}
                <button type="button" onClick={() => void removeSensitive(p)} className="text-text-dim hover:text-danger">×</button>
              </span>
            ))}
          </div>
        )}
        <details className="text-[11px] text-text-dim">
          <summary className="cursor-pointer">查看 {DEFAULT_SENSITIVE_PATTERNS.length} 条预置黑名单</summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {DEFAULT_SENSITIVE_PATTERNS.map((p) => (
              <span key={p} className="rounded-full bg-surface-2 px-2 py-0.5 font-mono">{p}</span>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}
