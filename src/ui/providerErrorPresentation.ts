import type {
  ProviderErrorDetails,
  ProviderErrorKind,
  ProviderErrorReason,
} from '../providers/types';

export interface ProviderErrorViewInput {
  message: string;
  kind?: string;
  details?: ProviderErrorDetails;
}

export interface ProviderErrorPresentation {
  summaryKey?: string;
  summary?: string;
  guidanceKey?: string;
  detail?: string;
  opensSettings: boolean;
}

interface PresentationPolicy {
  summaryKey: string;
  guidanceKey: string;
  opensSettings: boolean;
}

const PRESENTATION_BY_REASON: Record<ProviderErrorReason, PresentationPolicy> = {
  invalid_key: {
    summaryKey: 'error.reason.invalid_key',
    guidanceKey: 'error.guidance.invalid_key',
    opensSettings: true,
  },
  permission_denied: {
    summaryKey: 'error.reason.permission_denied',
    guidanceKey: 'error.guidance.permission_denied',
    opensSettings: true,
  },
  quota_exceeded: {
    summaryKey: 'error.reason.quota_exceeded',
    guidanceKey: 'error.guidance.quota_exceeded',
    opensSettings: true,
  },
  endpoint_not_found: {
    summaryKey: 'error.reason.endpoint_not_found',
    guidanceKey: 'error.guidance.endpoint_not_found',
    opensSettings: true,
  },
  model_not_found: {
    summaryKey: 'error.reason.model_not_found',
    guidanceKey: 'error.guidance.model_not_found',
    opensSettings: true,
  },
  invalid_request: {
    summaryKey: 'error.reason.invalid_request',
    guidanceKey: 'error.guidance.invalid_request',
    opensSettings: true,
  },
  upstream_error: {
    summaryKey: 'error.reason.upstream_error',
    guidanceKey: 'error.guidance.upstream_error',
    opensSettings: false,
  },
  response_format: {
    summaryKey: 'error.reason.response_format',
    guidanceKey: 'error.guidance.response_format',
    opensSettings: true,
  },
};

const PRESENTATION_BY_KIND: Record<ProviderErrorKind, PresentationPolicy> = {
  auth: {
    summaryKey: 'error.auth',
    guidanceKey: 'error.guidance.auth',
    opensSettings: true,
  },
  rate_limit: {
    summaryKey: 'error.rate_limit',
    guidanceKey: 'error.guidance.rate_limit',
    opensSettings: false,
  },
  overloaded: {
    summaryKey: 'error.overloaded',
    guidanceKey: 'error.guidance.overloaded',
    opensSettings: false,
  },
  context_too_long: {
    summaryKey: 'error.context_too_long',
    guidanceKey: 'error.guidance.context_too_long',
    opensSettings: false,
  },
  content_filter: {
    summaryKey: 'error.content_filter',
    guidanceKey: 'error.guidance.content_filter',
    opensSettings: false,
  },
  network: {
    summaryKey: 'error.network',
    guidanceKey: 'error.guidance.network',
    opensSettings: false,
  },
  protocol: {
    summaryKey: 'error.protocol',
    guidanceKey: 'error.guidance.protocol',
    opensSettings: true,
  },
};

const PRESENTATION_BY_APP_KIND: Record<string, PresentationPolicy> = {
  engine_protocol: {
    summaryKey: 'error.engineProtocol',
    guidanceKey: 'error.guidance.engineProtocol',
    opensSettings: false,
  },
};

const REASONING_PASSBACK_POLICY: PresentationPolicy = {
  summaryKey: 'error.reason.reasoning_passback',
  guidanceKey: 'error.guidance.reasoning_passback',
  opensSettings: true,
};

function isReasoningPassbackError(details?: ProviderErrorDetails): boolean {
  if (!details) return false;
  const upstream = [details.upstreamCode, details.upstreamMessage, details.raw]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase();
  return upstream.includes('reasoning_content') && /pass(?:ed)? back|return/.test(upstream);
}

function findOwnPolicy<Key extends string>(
  policies: Record<Key, PresentationPolicy>,
  key: string | undefined,
): PresentationPolicy | undefined {
  if (!key || !Object.hasOwn(policies, key)) return undefined;
  return policies[key as Key];
}

function detailFrom(details?: ProviderErrorDetails): string | undefined {
  if (!details) return undefined;
  const parts = [
    details.status === undefined ? undefined : `HTTP ${details.status}`,
    details.upstreamCode,
    details.upstreamMessage,
    details.upstreamMessage ? undefined : details.raw,
  ].filter((part): part is string => Boolean(part));
  const uniqueParts = [...new Set(parts)];
  return uniqueParts.length > 0 ? uniqueParts.join(' · ') : undefined;
}

export function buildProviderErrorPresentation(
  input: ProviderErrorViewInput,
): ProviderErrorPresentation {
  const reasonPolicy = findOwnPolicy(PRESENTATION_BY_REASON, input.details?.reason);
  const appKindPolicy = findOwnPolicy(PRESENTATION_BY_APP_KIND, input.kind);
  const kindPolicy = findOwnPolicy(PRESENTATION_BY_KIND, input.kind);
  const policy = isReasoningPassbackError(input.details)
    ? REASONING_PASSBACK_POLICY
    : (reasonPolicy ?? appKindPolicy ?? kindPolicy);
  const detail = detailFrom(input.details);

  if (!policy) {
    return {
      summary: input.message,
      ...(detail ? { detail } : {}),
      opensSettings: false,
    };
  }

  return {
    summaryKey: policy.summaryKey,
    guidanceKey: policy.guidanceKey,
    ...(detail ? { detail } : {}),
    opensSettings: policy.opensSettings,
  };
}
