export interface HostPermissionStatus {
  origin: string;
  pattern: string;
  granted: boolean;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported host permission protocol: ${url.protocol}`);
  }
  return url.origin;
}

export class HostPermissionBroker {
  async inspect(value: string): Promise<HostPermissionStatus> {
    const origin = normalizeOrigin(value);
    const pattern = `${origin}/*`;
    return {
      origin,
      pattern,
      granted: await chrome.permissions.contains({ origins: [pattern] }),
    };
  }

  /** Must be called directly from a user gesture handler. */
  request(value: string): Promise<boolean> {
    return this.requestAll([value]);
  }

  /** Must be called directly from a user gesture handler. */
  requestAll(values: readonly string[]): Promise<boolean> {
    const origins = [...new Set(values.map((value) => `${normalizeOrigin(value)}/*`))];
    if (origins.length === 0) return Promise.resolve(true);
    return chrome.permissions.request({ origins });
  }
}

export const hostPermissionBroker = new HostPermissionBroker();
