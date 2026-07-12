export type ActionPhase = 'resolve' | 'precheck' | 'execute' | 'settle' | 'verify' | 'recover';

export type ActionFailureCode =
  | 'stale_ref'
  | 'detached'
  | 'not_visible'
  | 'not_stable'
  | 'disabled'
  | 'not_editable'
  | 'occluded'
  | 'ambiguous_target'
  | 'unsupported_frame'
  | 'l1_not_effective'
  | 'navigation_uncertain'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export interface ActionFailure {
  code: ActionFailureCode;
  message: string;
  phase: ActionPhase;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ActionAttemptEvidence {
  phase: ActionPhase;
  strategy: 'l1' | 'l2';
  startedAt: number;
  durationMs: number;
  failureCode?: ActionFailureCode;
  message?: string;
}

export interface ActionEvidence {
  attemptId: string;
  tabId?: number;
  urlBefore?: string;
  urlAfter?: string;
  generationBefore?: number;
  generationAfter?: number;
  attempts: ActionAttemptEvidence[];
  observedEffects: string[];
  outcome: 'verified' | 'failed' | 'uncertain';
}
