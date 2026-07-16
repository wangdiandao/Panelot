import type { ActionEvidence } from '../../tools/action/types';
import { t } from '../i18n';

export function isActionEvidence(value: unknown): value is ActionEvidence {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActionEvidence>;
  return (
    typeof candidate.attemptId === 'string' &&
    Array.isArray(candidate.attempts) &&
    Array.isArray(candidate.observedEffects) &&
    (candidate.effectState === undefined ||
      ['dispatched', 'observed', 'verified'].includes(candidate.effectState)) &&
    ['verified', 'failed', 'uncertain'].includes(candidate.outcome ?? '')
  );
}

export function ActionEvidenceDetails({ evidence }: { evidence: ActionEvidence }) {
  return (
    <section>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-faint-foreground">
        {t('evidence.title')}
      </div>
      <div className="flex flex-col gap-1 rounded-md bg-muted p-2 font-mono text-[11px] text-muted-foreground">
        <div>
          {evidence.effectState ? t(`evidence.effect.${evidence.effectState}`) : '—'} ·{' '}
          {t(`evidence.outcome.${evidence.outcome}`)} ·{' '}
          {t('evidence.attempts', { n: evidence.attempts.length })}
        </div>
        {evidence.attempts.map((attempt, index) => (
          <div key={`${attempt.startedAt}-${index}`}>
            {localizeEvidenceValue('evidence.strategy', attempt.strategy)} ·{' '}
            {localizeEvidenceValue('evidence.phase', attempt.phase)} · {attempt.durationMs}ms
            {attempt.failureCode
              ? ` · ${localizeEvidenceValue('evidence.failure', attempt.failureCode)}`
              : ''}
            {attempt.message ? ` · ${attempt.message}` : ''}
          </div>
        ))}
        {evidence.observedEffects.length > 0 && (
          <div>
            {t('evidence.observed')}:{' '}
            {evidence.observedEffects
              .map((effect) => localizeEvidenceValue('evidence.observedEffect', effect))
              .join(', ')}
          </div>
        )}
      </div>
    </section>
  );
}

function localizeEvidenceValue(prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  const translated = t(key);
  return translated === key ? value : translated;
}
