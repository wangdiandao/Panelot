/**
 * API key obfuscation (docs/development/index.md §5): AES-GCM at rest in storage.local.
 *
 * Honest boundary: a device-derived key stored alongside the ciphertext is
 * obfuscation, not protection against an attacker with full disk + extension
 * access. It defends against casual inspection and accidental leakage (e.g. a
 * synced storage dump), which is the realistic threat for a local-first BYOK
 * extension. An optional session-only mode (keys in storage.session, never
 * persisted) is offered for users who want a stronger boundary.
 */

import { secretStore } from '../security/secretStore';

const WRAP_KEY_STORAGE = 'panelot_kek_v1';

async function getOrCreateKek(): Promise<CryptoKey> {
  const existing = await chrome.storage.local.get(WRAP_KEY_STORAGE);
  let raw: number[] | undefined = existing[WRAP_KEY_STORAGE] as number[] | undefined;
  if (!raw) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = [...bytes];
    await chrome.storage.local.set({ [WRAP_KEY_STORAGE]: raw });
  }
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  return secretStore.seal(plaintext, 'provider-key');
}

export async function decryptSecret(stored: string): Promise<string> {
  if (secretStore.isSealed(stored)) return secretStore.unseal(stored, 'provider-key');
  if (!stored.startsWith('enc:')) return stored; // plaintext (pre-encryption or session mode)
  const combined = Uint8Array.from(atob(stored.slice(4)), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const key = await getOrCreateKek();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:') || secretStore.isSealed(value);
}

export async function encryptHeaderValue(
  connectionId: string,
  name: string,
  value: string,
): Promise<string> {
  if (secretStore.isSealed(value)) return value;
  return secretStore.seal(value, `provider:${connectionId}:header:${name.toLowerCase()}`);
}

export async function decryptHeaderValue(
  connectionId: string,
  name: string,
  value: string,
): Promise<string> {
  if (!secretStore.isSealed(value)) return value;
  return secretStore.unseal(value, `provider:${connectionId}:header:${name.toLowerCase()}`);
}
