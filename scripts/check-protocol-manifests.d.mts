export type ProtocolManifestName = 'engine' | 'content';

export function buildProtocolManifests(
  rootDirectory?: string,
): Promise<Record<ProtocolManifestName, unknown>>;

export function protocolManifestHash(manifest: unknown): string;
