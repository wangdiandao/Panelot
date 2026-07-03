/**
 * Keyboard shortcut reference (docs/09 §6): opened with `?` when focus is
 * outside an input. Full table, grouped by scope.
 */

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

const SHORTCUTS: { keys: string; action: string; scope: string }[] = [
  { keys: 'Alt+P', action: '开/关侧边栏', scope: '全局' },
  { keys: 'Ctrl/Cmd+K', action: '命令面板（切会话/命令）', scope: '扩展页' },
  { keys: 'Ctrl/Cmd+N', action: '新会话', scope: '扩展页' },
  { keys: 'Ctrl/Cmd+,', action: '打开设置', scope: '全屏页' },
  { keys: 'Ctrl/Cmd+E', action: '侧边栏 ⇄ 全屏页切换', scope: '扩展页' },
  { keys: 'Enter / Shift+Enter', action: '发送 / 换行', scope: '输入框' },
  { keys: 'Enter（运行中）', action: '插话 steer', scope: '输入框' },
  { keys: 'Shift+Alt+Enter', action: '显式排队', scope: '输入框' },
  { keys: 'Esc', action: '停止 turn / 关闭面板', scope: '扩展页' },
  { keys: 'Y / A / N', action: '审批：允许一次 / 本站始终 / 拒绝', scope: '审批卡片' },
  { keys: 'Ctrl/Cmd+↑↓', action: '分支切换', scope: '消息流' },
  { keys: '@ / / / {{', action: '引用 / 命令 / 变量菜单', scope: '输入框' },
  { keys: '?', action: '本快捷键表', scope: '扩展页' },
];

/** Mount once per page; listens for `?` outside inputs. */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
        </DialogHeader>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1.5 font-medium">按键</th>
              <th className="font-medium">作用</th>
              <th className="font-medium">作用域</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys} className="border-b border-border/40">
                <td className="py-1.5"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{s.keys}</kbd></td>
                <td>{s.action}</td>
                <td className="text-muted-foreground">{s.scope}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
