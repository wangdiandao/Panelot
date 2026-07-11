export interface SiteInstruction {
  pattern: string;
  prompt: string;
}

function normalizePattern(value: string): string {
  const source = value.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = source.startsWith('*.');
  const hostname = wildcard ? source.slice(2) : source;
  if (!hostname || /[/:\s]/.test(hostname)) {
    throw new Error('Site pattern must be a hostname such as example.com or *.example.com.');
  }
  const normalized = new URL(`https://${hostname}`).hostname.replace(/\.$/, '');
  if (!normalized || normalized !== hostname || normalized.length > 253) {
    throw new Error('Site pattern must be a valid hostname.');
  }
  return wildcard ? `*.${normalized}` : normalized;
}

export function normalizeSiteInstructions(entries: readonly SiteInstruction[]): SiteInstruction[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    const pattern = normalizePattern(entry.pattern);
    const prompt = entry.prompt.trim();
    if (!prompt) throw new Error(`Instruction for ${pattern} is empty.`);
    if (seen.has(pattern)) throw new Error(`Duplicate site pattern: ${pattern}`);
    seen.add(pattern);
    return { pattern, prompt };
  });
}

export function siteInstructionMatches(pattern: string, url: string): boolean {
  let normalized: string;
  let hostname: string;
  try {
    normalized = normalizePattern(pattern);
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  const target = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
  return hostname === target || (normalized.startsWith('*.') && hostname.endsWith(`.${target}`));
}
