import { z } from 'zod';

const RELEASE_API_URL = 'https://api.github.com/repos/wangdiandao/Panelot/releases/latest';
const RELEASE_REPOSITORY_PATH = '/wangdiandao/Panelot/releases';
const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/;

const releaseAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string().url(),
  content_type: z.string(),
});

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(releaseAssetSchema),
});

export type ReleaseTarget = 'chrome' | 'edge';

export type ReleaseUpdateResult =
  | {
      status: 'current';
      latestVersion: string;
      releaseUrl: string;
    }
  | {
      status: 'available';
      latestVersion: string;
      releaseUrl: string;
      assetName: string;
      downloadUrl: string;
    };

export class ReleaseUpdateError extends Error {
  constructor(readonly code: 'network' | 'invalid_response' | 'invalid_release' | 'asset_missing') {
    super(code);
    this.name = 'ReleaseUpdateError';
  }
}

function parseVersion(value: string): number[] {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new ReleaseUpdateError('invalid_release');
  const parts = match
    .slice(1)
    .filter((part): part is string => part !== undefined)
    .map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65_535)) {
    throw new ReleaseUpdateError('invalid_release');
  }
  return parts;
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function releaseTargetForUserAgent(userAgent: string): ReleaseTarget {
  return /\bEdg\//.test(userAgent) ? 'edge' : 'chrome';
}

export function releaseAssetName(target: ReleaseTarget): string {
  return `panelot-${target}.zip`;
}

function isExactGithubUrl(value: string, expectedPath: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === expectedPath &&
    url.search === '' &&
    url.hash === ''
  );
}

export async function checkForReleaseUpdate(
  currentVersion: string,
  target: ReleaseTarget,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ReleaseUpdateResult> {
  let response: Response;
  try {
    response = await fetchImpl(RELEASE_API_URL, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReleaseUpdateError('network');
  }

  if (!response.ok) throw new ReleaseUpdateError('network');

  let rawRelease: unknown;
  try {
    rawRelease = await response.json();
  } catch {
    throw new ReleaseUpdateError('invalid_response');
  }

  const parsedRelease = releaseSchema.safeParse(rawRelease);
  if (!parsedRelease.success) throw new ReleaseUpdateError('invalid_response');

  const release = parsedRelease.data;
  const latestVersion = release.tag_name.replace(/^v/, '');
  const expectedReleasePath = `${RELEASE_REPOSITORY_PATH}/tag/${release.tag_name}`;
  if (
    release.draft ||
    release.prerelease ||
    !VERSION_PATTERN.test(release.tag_name) ||
    !isExactGithubUrl(release.html_url, expectedReleasePath)
  ) {
    throw new ReleaseUpdateError('invalid_release');
  }

  if (compareReleaseVersions(latestVersion, currentVersion) <= 0) {
    return {
      status: 'current',
      latestVersion,
      releaseUrl: release.html_url,
    };
  }

  const assetName = releaseAssetName(target);
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  const expectedAssetPath = `${RELEASE_REPOSITORY_PATH}/download/${release.tag_name}/${assetName}`;
  if (
    !asset ||
    asset.content_type !== 'application/zip' ||
    !isExactGithubUrl(asset.browser_download_url, expectedAssetPath)
  ) {
    throw new ReleaseUpdateError('asset_missing');
  }

  return {
    status: 'available',
    latestVersion,
    releaseUrl: release.html_url,
    assetName,
    downloadUrl: asset.browser_download_url,
  };
}
