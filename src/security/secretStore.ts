export const LOCAL_SECRET_KEY_STORAGE = 'panelot_local_secret_key';
const SESSION_PREFIX = 'panelot_session_secret:';
const PBKDF2_ITERATIONS = 600_000;

export interface EncryptedSecretBackup {
  format: 'panelot-secret-backup';
  version: 1;
  kdf: {
    name: 'PBKDF2-SHA-256';
    iterations: 600_000;
    salt: string;
  };
  cipher: 'AES-GCM-256';
  iv: string;
  ciphertext: string;
}

export async function sealSecretWithRawKey(
  plaintext: string,
  purpose: string,
  rawKey: Uint8Array | readonly number[],
): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(rawKey);
  if (bytes.length !== 32) throw new Error('Invalid local secret key');
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `secret:v1:${encode(iv)}:${encode(new Uint8Array(ciphertext))}`;
}

export async function unsealSecretWithRawKey(
  sealed: string,
  purpose: string,
  rawKey: Uint8Array | readonly number[],
): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(rawKey);
  if (bytes.length !== 32) throw new Error('Invalid local secret key');
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
  return decryptSealedSecret(sealed, purpose, key);
}

async function decryptSealedSecret(
  sealed: string,
  purpose: string,
  key: CryptoKey,
): Promise<string> {
  const [prefix, version, ivEncoded, ciphertextEncoded, extra] = sealed.split(':');
  if (prefix !== 'secret' || version !== 'v1' || !ivEncoded || !ciphertextEncoded || extra) {
    throw new Error('Unsupported sealed secret format');
  }
  const iv = decode(ivEncoded);
  const ciphertext = decode(ciphertextEncoded);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid sealed secret payload');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function storageGet(area: 'local' | 'session', key: string): Promise<unknown> {
  const result = await chrome.storage[area].get(key);
  return result[key];
}

async function storageSet(area: 'local' | 'session', key: string, value: unknown): Promise<void> {
  await chrome.storage[area].set({ [key]: value });
}

export class SecretStore {
  async seal(plaintext: string, purpose: string): Promise<string> {
    const key = await this.localKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
      key,
      new TextEncoder().encode(plaintext),
    );
    return `secret:v1:${encode(iv)}:${encode(new Uint8Array(ciphertext))}`;
  }

  async unseal(sealed: string, purpose: string): Promise<string> {
    return decryptSealedSecret(sealed, purpose, await this.localKey());
  }

  isSealed(value: string): boolean {
    return value.startsWith('secret:v1:');
  }

  async setSessionSecret(id: string, value: string): Promise<void> {
    await storageSet('session', `${SESSION_PREFIX}${id}`, value);
  }

  async getSessionSecret(id: string): Promise<string | null> {
    const value = await storageGet('session', `${SESSION_PREFIX}${id}`);
    return typeof value === 'string' ? value : null;
  }

  async deleteSessionSecret(id: string): Promise<void> {
    await chrome.storage.session.remove(`${SESSION_PREFIX}${id}`);
  }

  async encryptBackup(value: unknown, passphrase: string): Promise<EncryptedSecretBackup> {
    if (!passphrase) throw new Error('A backup passphrase is required');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveBackupKey(passphrase, salt, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return {
      format: 'panelot-secret-backup',
      version: 1,
      kdf: {
        name: 'PBKDF2-SHA-256',
        iterations: PBKDF2_ITERATIONS,
        salt: encode(salt),
      },
      cipher: 'AES-GCM-256',
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
    };
  }

  async decryptBackup(backup: EncryptedSecretBackup, passphrase: string): Promise<unknown> {
    if (
      backup.format !== 'panelot-secret-backup' ||
      backup.version !== 1 ||
      backup.kdf.name !== 'PBKDF2-SHA-256' ||
      backup.kdf.iterations !== PBKDF2_ITERATIONS ||
      backup.cipher !== 'AES-GCM-256'
    ) {
      throw new Error('Unsupported encrypted backup format');
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(backup.iv) },
      await this.deriveBackupKey(passphrase, decode(backup.kdf.salt), ['decrypt']),
      decode(backup.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  }

  private async localKey(): Promise<CryptoKey> {
    const stored = await storageGet('local', LOCAL_SECRET_KEY_STORAGE);
    let raw: Uint8Array<ArrayBuffer>;
    if (Array.isArray(stored) && stored.length === 32) {
      raw = new Uint8Array(stored as number[]);
    } else {
      raw = crypto.getRandomValues(new Uint8Array(32));
      await storageSet('local', LOCAL_SECRET_KEY_STORAGE, [...raw]);
    }
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  private async deriveBackupKey(
    passphrase: string,
    salt: Uint8Array<ArrayBuffer>,
    usages: KeyUsage[],
  ): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    );
  }
}

export const secretStore = new SecretStore();
