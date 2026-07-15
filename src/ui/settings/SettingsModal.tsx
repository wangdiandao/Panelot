/**
 * SettingsModal — in-app settings overlay. Opening settings no longer navigates
 * away to a separate options tab; it slides a dialog over the conversation, so
 * the user keeps their place (a key usability improvement over openOptionsPage).
 * Built on shadcn/ui Dialog (Radix): focus trap, Esc, focus return, aria.
 */

import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { SettingsPanel, type SettingsSectionId } from './SettingsPanel';
import { t } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSectionId;
}

export function SettingsModal({ open, onClose, initialSection }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="block h-[min(720px,92vh)] w-[min(940px,94vw)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{t('settings.title')}</DialogTitle>
        <SettingsPanel initialSection={initialSection} />
      </DialogContent>
    </Dialog>
  );
}
