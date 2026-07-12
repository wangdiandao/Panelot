import type { ActionEvidence } from '../../tools/action/types';

export function isActionEvidence(value: unknown): value is ActionEvidence {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActionEvidence>;
  return (
    typeof candidate.attemptId === 'string' &&
    Array.isArray(candidate.attempts) &&
    Array.isArray(candidate.observedEffects) &&
    ['verified', 'failed', 'uncertain'].includes(candidate.outcome ?? '')
  );
}

export function ActionEvidenceDetails({ evidence }: { evidence: ActionEvidence }) {
  return (
    <section>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-faint-foreground">
        Execution evidence
      </div>
      <div className="space-y-1 rounded-md bg-muted p-2 font-mono text-[11px] text-muted-foreground">
        <div>
          {evidence.outcome} · {evidence.attempts.length} attempt
          {evidence.attempts.length === 1 ? '' : 's'}
        </div>
        {evidence.attempts.map((attempt, index) => (
          <div key={`${attempt.startedAt}-${index}`}>
            {attempt.strategy} · {attempt.phase} · {attempt.durationMs}ms
            {attempt.failureCode ? ` · ${attempt.failureCode}` : ''}
          </div>
        ))}
        {evidence.observedEffects.length > 0 && (
          <div>observed: {evidence.observedEffects.join(', ')}</div>
        )}
      </div>
    </section>
  );
}
