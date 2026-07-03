/**
 * API key obfuscation (DESIGN §7): AES-GCM at rest in storage.local.
 *
 * Honest boundary: a device-derived key stored alongside the ciphertext is
 * obfuscation, not protection against an attacker with full disk + extension
 * access. It defends against casual inspection and accidental leakage (e.g. a
 * synced storage dump), which is the realistic threat for a local-first BYOK
 * extension. An optional session-only mode (keys in storage.session, never
 * persisted) is offered for users who want a stronger boundary.
 */

const WRAP_KEY_STORAGE = 'panelot_kek_v1';

async function getOrCreateKek(): Promise<CryptoKey> {
  const existing = await chrome.storage.local.get(WRAP_KEY_STORAGE);
  let raw: number[] | undefined = existing[WRAP_KEY_STORAGE] as number[] | undefined;
  if (!raw) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = [...bytes];
    await chrome.storage.local.set({ [WRAP_KEY_STORAGE]: raw });
  }
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getOrCreateKek();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), iv.length);
  return `enc:${btoa(String.fromCharCode(...combined))}`;
}

export async function decryptSecret(stored: string): Promise<string> {
  if (!stored.startsWith('enc:')) return stored; // plaintext (pre-encryption or session mode)
  const combined = Uint8Array.from(atob(stored.slice(4)), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const key = await getOrCreateKek();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:');
}
