import type { ReactNode } from 'react';
import {
  buildProviderErrorPresentation,
  type ProviderErrorViewInput,
} from '../providerErrorPresentation';
import { t } from '../i18n';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './ui/alert';

interface ProviderErrorNoticeProps {
  error: ProviderErrorViewInput;
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function ProviderErrorNotice({
  error,
  status,
  actions,
  className,
}: ProviderErrorNoticeProps) {
  const view = buildProviderErrorPresentation(error);

  return (
    <Alert variant="destructive" className={className}>
      {status && <div className="col-start-2">{status}</div>}
      <AlertTitle className="line-clamp-none min-w-0 max-w-full break-words whitespace-pre-wrap">
        {view.summaryKey ? t(view.summaryKey) : view.summary}
      </AlertTitle>
      <AlertDescription className="min-w-0">
        {view.detail && <p className="max-w-full break-words whitespace-pre-wrap">{view.detail}</p>}
        {view.guidanceKey && <p>{t(view.guidanceKey)}</p>}
      </AlertDescription>
      {actions && <AlertAction placement="footer">{actions}</AlertAction>}
    </Alert>
  );
}
