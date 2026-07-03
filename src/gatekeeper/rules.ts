/**
 * Permission rules & sensitive-origin blacklist (docs/06 §3).
 *
 * Priority: deny > allow; specific > wildcard; user_setting >
 * approval_persist > plugin_default.
 */

export interface PermissionRule {
  id: string;
  /** 'browser_click' / 'mcp__github__*' (prefix wildcard supported). */
  tool: string;
  /** 'https://github.com' / '*.example.com' / '*'. */
  origin: string;
  verdict: 'allow' | 'deny';
  source: 'user_setting' | 'approval_persist' | 'plugin_default';
  createdAt: number;
  /** For approval_persist: which thread produced it (traceability, docs/06 §7). */
  sourceThreadId?: string;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

export function originMatches(pattern: string, origin: string): boolean {
  if (pattern === '*') return true;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = origin.replace(/^[a-z]+:\/\//, '').split('/')[0] ?? origin;
  }
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  try {
    return new URL(pattern).origin === new URL(origin).origin;
  } catch {
    return pattern === host || pattern === origin;
  }
}

const SOURCE_PRIORITY: Record<PermissionRule['source'], number> = {
  user_setting: 3,
  approval_persist: 2,
  plugin_default: 1,
};

/** Specificity score: exact tool+origin (4) > one wildcard (2-3) > both (0). */
function specificity(rule: PermissionRule): number {
  let score = 0;
  if (rule.tool !== '*' && !rule.tool.endsWith('*')) score += 2;
  else if (rule.tool !== '*') score += 1;
  if (rule.origin !== '*' && !rule.origin.startsWith('*.')) score += 2;
  else if (rule.origin !== '*') score += 1;
  return score;
}

/**
 * Find the winning rule for (tool, origin), or null when nothing matches.
 * deny > allow at equal standing; higher specificity wins; higher source
 * priority breaks remaining ties.
 */
export function matchRules(rules: PermissionRule[], tool: string, origin: string): PermissionRule | null {
  const hits = rules.filter((r) => toolMatches(r.tool, tool) && originMatches(r.origin, origin));
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const spec = specificity(b) - specificity(a);
    if (spec !== 0) return spec;
    const source = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
    if (source !== 0) return source;
    // deny beats allow at full tie.
    if (a.verdict !== b.verdict) return a.verdict === 'deny' ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
  // deny wins over a same-specificity, same-source allow.
  const top = hits[0]!;
  const rival = hits.find(
    (h) => h !== top && specificity(h) === specificity(top) && SOURCE_PRIORITY[h.source] === SOURCE_PRIORITY[top.source] && h.verdict === 'deny',
  );
  return rival ?? top;
}

// ---------------------------------------------------------------------------
// Sensitive-origin blacklist (docs/06 §3) — hard DENY, not overridable
// ---------------------------------------------------------------------------

/** Pre-seeded patterns: banks/payment/brokers/government/browser-internal. */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  // Browser internal & extension stores
  'chrome://*', 'chrome-extension://*', 'edge://*', 'about:*',
  '*.chromewebstore.google.com', 'chromewebstore.google.com',
  'microsoftedge.microsoft.com',
  // Payment networks
  '*.paypal.com', '*.stripe.com', 'pay.google.com', '*.alipay.com', 'pay.weixin.qq.com',
  '*.unionpay.com', '*.unionpayintl.com',
  // Major banks (CN + intl, non-exhaustive seed)
  '*.icbc.com.cn', '*.ccb.com', '*.abchina.com', '*.boc.cn', '*.bankcomm.com',
  '*.cmbchina.com', '*.chase.com', '*.bankofamerica.com', '*.wellsfargo.com',
  '*.citibank.com', '*.hsbc.com',
  // Brokers
  '*.fidelity.com', '*.schwab.com', '*.etrade.com', '*.futuhk.com', '*.tigerbrokers.com',
  // Government
  '*.gov', '*.gov.cn', '*.gov.uk',
] as const;

export function isSensitiveOrigin(patterns: readonly string[], origin: string): boolean {
  if (!origin) return false;
  // chrome:// style schemes match on prefix.
  for (const p of patterns) {
    if (p.includes('://') || p.startsWith('about:')) {
      const prefix = p.endsWith('*') ? p.slice(0, -1) : p;
      if (origin.startsWith(prefix)) return true;
    } else if (originMatches(p.startsWith('*.') ? p : p, origin)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sensitive-payload detection (docs/06 §2 step 4) — err toward asking
// ---------------------------------------------------------------------------

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function detectSensitivePayload(params: unknown): string[] {
  const text = JSON.stringify(params ?? '');
  const findings: string[] = [];

  // Card numbers: 13-19 digits (with optional separators) passing Luhn.
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      findings.push('card_number');
      break;
    }
  }
  // Credential-shaped keys in the params.
  if (/"(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key)"\s*:/i.test(text)) {
    findings.push('credential_field');
  }
  // Email exfil heuristic only fires alongside other signals upstream.
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
    findings.push('email_address');
  }
  return findings;
}
