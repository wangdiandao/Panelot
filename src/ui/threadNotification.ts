const PREFIX = 'panelot:thread:';

export function threadNotificationId(
  threadId: string,
  kind: 'approval' | 'recovery' | 'interaction',
  instanceId: string,
): string {
  return `${PREFIX}${encodeURIComponent(threadId)}:${kind}:${encodeURIComponent(instanceId)}`;
}

export function threadIdFromNotification(id: string): string | null {
  if (!id.startsWith(PREFIX)) return null;
  const encoded = id.slice(PREFIX.length).split(':', 1)[0];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
