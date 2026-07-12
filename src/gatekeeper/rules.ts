/**
 * Permission rules & sensitive-origin blacklist (docs/06 §3).
 *
 * Priority: deny > ask > allow; specific > wildcard; user_setting >
 * approval_persist > plugin_default. The three-verdict rule model and the
 * action-category patterns are borrowed from vercel-labs/agent-browser
 * (action policy: allow/deny/confirm + category gating).
 */

export interface PermissionRule {
  id: string;
  /** 'click' / 'mcp__github__*' (prefix wildcard) / 'category:eval'. */
  tool: string;
  /** 'https://github.com' / '*.example.com' / '*'. */
  origin: string;
  /** 'ask' = always confirm, even where the policy default would allow. */
  verdict: 'allow' | 'deny' | 'ask';
  source: 'user_setting' | 'approval_persist' | 'plugin_default';
  createdAt: number;
  /** For approval_persist: which thread produced it (traceability, docs/06 §7). */
  sourceThreadId?: string;
}

// ---------------------------------------------------------------------------
// Action categories (agent-browser's policy categories, adapted to Panelot's
// tool set). Only write tools are listed — reads never reach the rule table.
// ---------------------------------------------------------------------------

export const ACTION_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  navigate: [
    'navigate',
    'tab_open',
    'tab_focus',
    'tab_close',
    'go_back',
    'go_forward',
    'session_restore',
  ],
  organize: ['tabs_group', 'tab_group_update'],
  click: ['click', 'click_xy', 'click_trusted'],
  fill: ['type', 'type_trusted', 'select_option', 'press_key', 'batch_actions'],
  eval: ['run_javascript'],
  download: ['download'],
  upload: ['upload_file'],
  interact: ['hover', 'drag'],
  memory: ['memory_write'],
};

const TOOL_TO_CATEGORY: Record<string, string> = {};
for (const [cat, tools] of Object.entries(ACTION_CATEGORIES)) {
  for (const t of tools) TOOL_TO_CATEGORY[t] = cat;
}

/** Category of a tool; every mcp__* tool falls into the 'mcp' category. */
export function categoryOf(tool: string): string | null {
  return TOOL_TO_CATEGORY[tool] ?? (tool.startsWith('mcp__') ? 'mcp' : null);
}

// ---------------------------------------------------------------------------
// Destination-origin attribution: tools whose real target is a URL parameter,
// not the current tab. Gatekeeper decisions (blacklist, rules, session grants)
// for these key on where the action GOES, so approving one navigation never
// silently authorizes navigating anywhere else from the same page.
// ---------------------------------------------------------------------------

const URL_BEARING_TOOLS: Record<string, string> = {
  navigate: 'url',
  tab_open: 'url',
  download: 'url',
};

export function destinationOrigin(tool: string, params: unknown): string | null {
  const key = URL_BEARING_TOOLS[tool];
  if (!key) return null;
  const url = (params as Record<string, unknown> | null | undefined)?.[key];
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    // Opaque origins (chrome://, about:) → keep the raw URL so scheme-prefix
    // blacklist patterns still match.
    return parsed.origin === 'null' ? url : parsed.origin;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('category:')) return categoryOf(tool) === pattern.slice(9);
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/** FQDN trailing dots ('chase.com.') resolve to the same site — normalize. */
function stripTrailingDots(host: string): string {
  return host.replace(/\.+$/, '');
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
  host = stripTrailingDots(host);
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  try {
    const p = new URL(pattern);
    const o = new URL(origin);
    return (
      p.protocol === o.protocol &&
      stripTrailingDots(p.hostname) === stripTrailingDots(o.hostname) &&
      p.port === o.port
    );
  } catch {
    return pattern === host || pattern === origin;
  }
}

const SOURCE_PRIORITY: Record<PermissionRule['source'], number> = {
  user_setting: 3,
  approval_persist: 2,
  plugin_default: 1,
};

/** Specificity score: exact tool+origin (4) > one wildcard/category (2-3) > both (0). */
function specificity(rule: PermissionRule): number {
  let score = 0;
  if (rule.tool !== '*' && !rule.tool.endsWith('*') && !rule.tool.startsWith('category:'))
    score += 2;
  else if (rule.tool !== '*') score += 1;
  if (rule.origin !== '*' && !rule.origin.startsWith('*.')) score += 2;
  else if (rule.origin !== '*') score += 1;
  return score;
}

/** Restrictiveness at equal standing: deny > ask > allow. */
const VERDICT_PRIORITY: Record<PermissionRule['verdict'], number> = {
  deny: 2,
  ask: 1,
  allow: 0,
};

/**
 * Find the winning rule for (tool, origin), or null when nothing matches.
 * deny > ask > allow at equal standing; higher specificity wins; higher
 * source priority breaks remaining ties.
 */
export function matchRules(
  rules: PermissionRule[],
  tool: string,
  origin: string,
): PermissionRule | null {
  const hits = rules.filter((r) => toolMatches(r.tool, tool) && originMatches(r.origin, origin));
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const spec = specificity(b) - specificity(a);
    if (spec !== 0) return spec;
    const source = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
    if (source !== 0) return source;
    // The more restrictive verdict wins at a full tie.
    const verdict = VERDICT_PRIORITY[b.verdict] - VERDICT_PRIORITY[a.verdict];
    if (verdict !== 0) return verdict;
    return b.createdAt - a.createdAt;
  });
  // The most restrictive verdict wins over a same-specificity, same-source rival.
  const top = hits[0]!;
  const rival = hits.find(
    (h) =>
      h !== top &&
      specificity(h) === specificity(top) &&
      SOURCE_PRIORITY[h.source] === SOURCE_PRIORITY[top.source] &&
      VERDICT_PRIORITY[h.verdict] > VERDICT_PRIORITY[top.verdict],
  );
  return rival ?? top;
}

// ---------------------------------------------------------------------------
// Sensitive-origin blacklist (docs/06 §3) — hard DENY, not overridable
// ---------------------------------------------------------------------------

/** Pre-seeded patterns: banks/payment/brokers/government/browser-internal. */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  // Browser internal & extension stores (extension pages themselves are NOT
  // sensitive — the standalone chat page must be operable; owner decision)
  'chrome://*',
  'edge://*',
  'about:*',
  '*.chromewebstore.google.com',
  'chromewebstore.google.com',
  'microsoftedge.microsoft.com',
  // Payment networks
  '*.paypal.com',
  '*.stripe.com',
  'pay.google.com',
  '*.alipay.com',
  'pay.weixin.qq.com',
  '*.unionpay.com',
  '*.unionpayintl.com',
  // Major banks (CN + intl, non-exhaustive seed)
  '*.icbc.com.cn',
  '*.ccb.com',
  '*.abchina.com',
  '*.boc.cn',
  '*.bankcomm.com',
  '*.cmbchina.com',
  '*.chase.com',
  '*.bankofamerica.com',
  '*.wellsfargo.com',
  '*.citibank.com',
  '*.hsbc.com',
  // Brokers
  '*.fidelity.com',
  '*.schwab.com',
  '*.etrade.com',
  '*.futuhk.com',
  '*.tigerbrokers.com',
  // Government
  '*.gov',
  '*.gov.cn',
  '*.gov.uk',
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
