import type { StopReason } from '../../messaging/protocol';
import { t } from '../i18n';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';

interface ProviderStopNoticeProps {
  stopReason: StopReason | null;
}

export function ProviderStopNotice({ stopReason }: ProviderStopNoticeProps) {
  const keys =
    stopReason === 'max_tokens'
      ? {
          title: 'completion.maxTokens.title',
          description: 'completion.maxTokens.description',
        }
      : stopReason === 'content_filter'
        ? {
            title: 'completion.contentFilter.title',
            description: 'completion.contentFilter.description',
          }
        : null;

  if (!keys) return null;

  return (
    <Alert
      role="status"
      aria-live="polite"
      className="rounded-none border-x-0 border-t-0 px-3 py-2"
    >
      <AlertTitle>{t(keys.title)}</AlertTitle>
      <AlertDescription>{t(keys.description)}</AlertDescription>
    </Alert>
  );
}
