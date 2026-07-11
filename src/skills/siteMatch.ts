export function skillMatchesUrl(sites: string[] | undefined, url: string): boolean {
  if (!sites || sites.length === 0) return false;
  for (const pattern of sites) {
    if (matchSite(pattern, url)) return true;
  }
  return false;
}

function matchSite(pattern: string, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const patternHost = pattern.replace(/^https?:\/\//, '').split('/')[0] ?? pattern;
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === patternHost;
}
