/**
 * Keyboard shortcut reference (docs/09 §6): opened with `?` when focus is
 * outside an input. Rendered FROM the central registry (src/ui/shortcuts.ts)
 * so the sheet can never drift from the actual bindings.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { shortcutsByScope } from '../shortcuts';
import { t } from '../i18n';

/** Mount once per page; listens for `?` outside inputs. */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const groups = shortcutsByScope();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-md"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('keys.title')}</DialogTitle>
        </DialogHeader>
        {[...groups.entries()].map(([scope, defs]) => (
          <div key={scope}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
              {t(`keys.scope.${scope}`)}
            </div>
            <table className="w-full text-[13px]">
              <tbody>
                {defs.map((s) => (
                  <tr key={s.id} className="border-b border-border/40 last:border-0">
                    <td className="w-40 py-1.5">
                      <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {s.keys}
                      </kbd>
                    </td>
                    <td>{t(s.labelKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </DialogContent>
    </Dialog>
  );
}
