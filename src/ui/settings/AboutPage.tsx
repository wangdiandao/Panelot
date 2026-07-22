import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Code2,
  Download,
  ExternalLink,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { t } from '../i18n';
import {
  checkForReleaseUpdate,
  releaseTargetForUserAgent,
  type ReleaseUpdateResult,
} from './releaseUpdate';

type UpdateState =
  { status: 'idle' } | { status: 'checking' } | ReleaseUpdateResult | { status: 'error' };

const UPDATE_TIMEOUT_MS = 15_000;

export function AboutPage() {
  const version =
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : null;
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  const activeCheck = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeCheck.current?.abort();
      activeCheck.current = null;
    },
    [],
  );

  const checkForUpdate = async () => {
    if (!version) return;

    activeCheck.current?.abort();
    const controller = new AbortController();
    activeCheck.current = controller;
    setUpdateState({ status: 'checking' });
    const timeout = globalThis.setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);

    try {
      const target = releaseTargetForUserAgent(globalThis.navigator?.userAgent ?? '');
      const result = await checkForReleaseUpdate(version, target, controller.signal);
      if (activeCheck.current === controller) setUpdateState(result);
    } catch {
      if (activeCheck.current === controller) setUpdateState({ status: 'error' });
    } finally {
      globalThis.clearTimeout(timeout);
      if (activeCheck.current === controller) activeCheck.current = null;
    }
  };

  const isChecking = updateState.status === 'checking';

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h2 className="text-[15px] font-semibold">{t('settings.about.title')}</h2>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 p-5 sm:p-6">
          <img
            src="/icon/128.png"
            alt=""
            aria-hidden="true"
            className="size-14 rounded-2xl shadow-sm sm:size-16"
          />
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span>Panelot</span>
              {version && <Badge variant="outline">v{version}</Badge>}
            </CardTitle>
            <CardDescription className="leading-relaxed">
              {t('settings.about.summary')}
            </CardDescription>
          </div>
        </CardHeader>

        {updateState.status !== 'idle' && updateState.status !== 'checking' && (
          <CardContent className="px-5 pb-5 sm:px-6 sm:pb-6">
            {updateState.status === 'current' && (
              <Alert variant="success">
                <CheckCircle2 aria-hidden="true" />
                <AlertTitle>{t('settings.about.update.currentTitle')}</AlertTitle>
                <AlertDescription>
                  {t('settings.about.update.currentDescription', {
                    version: updateState.latestVersion,
                  })}
                </AlertDescription>
              </Alert>
            )}
            {updateState.status === 'available' && (
              <Alert variant="info">
                <Download aria-hidden="true" />
                <AlertTitle>
                  {t('settings.about.update.availableTitle', {
                    version: updateState.latestVersion,
                  })}
                </AlertTitle>
                <AlertDescription>
                  {t('settings.about.update.availableDescription', {
                    asset: updateState.assetName,
                  })}
                </AlertDescription>
                <AlertAction placement="footer">
                  <Button size="sm" asChild>
                    <a href={updateState.downloadUrl} rel="noreferrer">
                      <Download data-icon="inline-start" aria-hidden="true" />
                      {t('settings.about.update.download')}
                    </a>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href={updateState.releaseUrl} target="_blank" rel="noreferrer">
                      {t('settings.about.update.releaseNotes')}
                      <ExternalLink data-icon="inline-end" aria-hidden="true" />
                    </a>
                  </Button>
                </AlertAction>
              </Alert>
            )}
            {updateState.status === 'error' && (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>{t('settings.about.update.errorTitle')}</AlertTitle>
                <AlertDescription>{t('settings.about.update.errorDescription')}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        )}

        <CardFooter className="flex-wrap justify-start gap-2 px-5 pb-5 sm:px-6 sm:pb-6">
          <Button
            variant="outline"
            size="sm"
            disabled={!version || isChecking}
            onClick={() => void checkForUpdate()}
          >
            {isChecking ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
            )}
            {isChecking ? t('settings.about.update.checking') : t('settings.about.update.check')}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="https://github.com/wangdiandao/Panelot" target="_blank" rel="noreferrer">
              <Code2 data-icon="inline-start" aria-hidden="true" />
              {t('settings.about.github')}
              <ExternalLink data-icon="inline-end" aria-hidden="true" />
            </a>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
