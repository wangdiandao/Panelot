/**
 * Keyboard shortcut reference (docs/development/ui.md §6): opened with `?` when focus is
 * outside an input. Rendered FROM the central registry (src/ui/shortcuts.ts)
 * so the sheet can never drift from the actual bindings.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Kbd } from './ui/kbd';
import { ScrollArea } from './ui/scroll-area';
import { Table, TableBody, TableCell, TableRow } from './ui/table';
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
        className="max-h-[85vh] overflow-hidden sm:max-w-md"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('keys.title')}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="min-h-0 pr-3">
          <div className="flex flex-col gap-4">
            {[...groups.entries()].map(([scope, defs]) => (
              <section key={scope} aria-labelledby={`shortcut-scope-${scope}`}>
                <h3
                  id={`shortcut-scope-${scope}`}
                  className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t(`keys.scope.${scope}`)}
                </h3>
                <Table>
                  <TableBody>
                    {defs.map((shortcut) => (
                      <TableRow key={shortcut.id}>
                        <TableCell className="w-40">
                          <Kbd>{shortcut.keys}</Kbd>
                        </TableCell>
                        <TableCell>{t(shortcut.labelKey)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
