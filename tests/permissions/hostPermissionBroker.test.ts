import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostPermissionBroker } from '../../src/permissions/hostPermissionBroker';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HostPermissionBroker', () => {
  it('requests distinct origins together from the active user gesture', async () => {
    const request = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('chrome', { permissions: { request } });

    const broker = new HostPermissionBroker();
    await expect(
      broker.requestAll([
        'https://github.com/example/repo',
        'https://api.github.com/repos/example/repo',
        'https://github.com/another/repo',
      ]),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({
      origins: ['https://github.com/*', 'https://api.github.com/*'],
    });
  });

  it('treats an empty batch as already granted', async () => {
    const request = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('chrome', { permissions: { request } });

    await expect(new HostPermissionBroker().requestAll([])).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
