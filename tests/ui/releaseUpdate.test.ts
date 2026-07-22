import { describe, expect, it, vi } from 'vitest';
import {
  checkForReleaseUpdate,
  compareReleaseVersions,
  releaseAssetName,
  releaseTargetForUserAgent,
  ReleaseUpdateError,
} from '../../src/ui/settings/releaseUpdate';

function releaseResponse(
  version: string,
  assets: Array<{ name: string; browser_download_url: string; content_type: string }>,
): Response {
  return new Response(
    JSON.stringify({
      tag_name: `v${version}`,
      html_url: `https://github.com/wangdiandao/Panelot/releases/tag/v${version}`,
      draft: false,
      prerelease: false,
      assets,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('GitHub Release update checks', () => {
  it('compares manifest-compatible versions numerically', () => {
    expect(compareReleaseVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareReleaseVersions('v1.2.0', '1.2')).toBe(0);
    expect(compareReleaseVersions('1.2.3', '1.2.4')).toBe(-1);
  });

  it('selects stable browser-specific asset names', () => {
    expect(releaseTargetForUserAgent('Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toBe('edge');
    expect(releaseTargetForUserAgent('Chrome/140.0.0.0 Safari/537.36')).toBe('chrome');
    expect(releaseAssetName('chrome')).toBe('panelot-chrome.zip');
    expect(releaseAssetName('edge')).toBe('panelot-edge.zip');
  });

  it('returns the exact fixed-name asset for a newer release', async () => {
    const fetchImpl = vi.fn(async () =>
      releaseResponse('0.5.0', [
        {
          name: 'panelot-chrome.zip',
          browser_download_url:
            'https://github.com/wangdiandao/Panelot/releases/download/v0.5.0/panelot-chrome.zip',
          content_type: 'application/zip',
        },
      ]),
    );

    await expect(checkForReleaseUpdate('0.4.5', 'chrome', undefined, fetchImpl)).resolves.toEqual({
      status: 'available',
      latestVersion: '0.5.0',
      releaseUrl: 'https://github.com/wangdiandao/Panelot/releases/tag/v0.5.0',
      assetName: 'panelot-chrome.zip',
      downloadUrl:
        'https://github.com/wangdiandao/Panelot/releases/download/v0.5.0/panelot-chrome.zip',
    });
  });

  it('does not require an asset when the installed version is current', async () => {
    const fetchImpl = vi.fn(async () => releaseResponse('0.4.5', []));

    await expect(checkForReleaseUpdate('0.4.5', 'edge', undefined, fetchImpl)).resolves.toEqual({
      status: 'current',
      latestVersion: '0.4.5',
      releaseUrl: 'https://github.com/wangdiandao/Panelot/releases/tag/v0.4.5',
    });
  });

  it('rejects renamed or off-repository download assets', async () => {
    const fetchImpl = vi.fn(async () =>
      releaseResponse('0.5.0', [
        {
          name: 'panelot-chrome.zip',
          browser_download_url: 'https://example.com/panelot-chrome.zip',
          content_type: 'application/zip',
        },
      ]),
    );

    await expect(
      checkForReleaseUpdate('0.4.5', 'chrome', undefined, fetchImpl),
    ).rejects.toMatchObject({
      name: ReleaseUpdateError.name,
      code: 'asset_missing',
    });
  });
});
