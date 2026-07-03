/**
 * SettingsModal — in-app settings overlay. Opening settings no longer navigates
 * away to a separate options tab; it slides a dialog over the conversation, so
 * the user keeps their place (a key usability improvement over openOptionsPage).
 */

import { useEffect } from 'react';
import { SettingsPanel, type SettingsSectionId } from './SettingsPanel';

interface Props {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSectionId;
}

export function SettingsModal({ open, onClose, initialSection }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-[fade-in_120ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="flex h-[min(720px,92vh)] w-[min(940px,94vw)] flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-pop"
      >
        <div className="relative flex-1 min-h-0">
          <SettingsPanel initialSection={initialSection} />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-text-dim transition-colors hover:bg-surface-2 hover:text-text"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
