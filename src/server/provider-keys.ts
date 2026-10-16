import { createDecipheriv, createCipheriv, randomBytes } from 'crypto';
import type { Pool } from 'pg';

const ENCRYPTION_KEY_ENV = 'TRACEMIND_CREDENTIAL_ENCRYPTION_KEY';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface ProviderKeyStatus {
  configured: boolean;
  provider?: string;
  updatedAt?: string;
}

export interface ProviderKeyStorePort {
  getStatus(subject: string): Promise<ProviderKeyStatus>;
  save(subject: string, provider: string, apiKey: string): Promise<void>;
  delete(subject: string): Promise<void>;
  getDecrypted(subject: string): Promise<{ provider: string; apiKey: string } | undefined>;
}

interface ProviderKeyRow {
  provider: string;
  ciphertext: Buffer | string;
  iv: Buffer | string;
  tag: Buffer | string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Create the encrypted provider credential table. Safe to run during startup. */
export async function migrateProviderKeys(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_keys (
      owner_sub TEXT NOT NULL,
      provider TEXT NOT NULL,
      ciphertext BYTEA NOT NULL,
      iv BYTEA NOT NULL,
      tag BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_sub)
    )
  `);
}

/**
 * Persists per-Auth0-user provider credentials encrypted with AES-256-GCM.
 * The encryption key is read from TRACEMIND_CREDENTIAL_ENCRYPTION_KEY and must
 * be the canonical base64 encoding of exactly 32 random bytes.
 */
export class ProviderKeyStore implements ProviderKeyStorePort {
  private readonly encryptionKey: Buffer;

  constructor(private readonly pool: Pick<Pool, 'query'>, encodedKey = process.env[ENCRYPTION_KEY_ENV]) {
    this.encryptionKey = decodeEncryptionKey(encodedKey);
  }

  async getStatus(ownerSub: string): Promise<ProviderKeyStatus> {
    validateOwner(ownerSub);
    const { rows } = await this.pool.query<Pick<ProviderKeyRow, 'provider' | 'updated_at'>>(
      `SELECT provider, created_at, updated_at
       FROM provider_keys WHERE owner_sub = $1`,
      [ownerSub]
    );
    const row = rows[0];
    return row
      ? {
          provider: row.provider,
          configured: true,
          updatedAt: toIso(row.updated_at),
        }
      : { configured: false };
  }

  async save(ownerSub: string, provider: string, secret: string): Promise<void> {
    validateOwner(ownerSub);
    validateProvider(provider);
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('Provider key must be a non-empty string');
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${ownerSub}\0${provider}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const { rows } = await this.pool.query<Pick<ProviderKeyRow, 'provider' | 'created_at' | 'updated_at'>>(
      `INSERT INTO provider_keys (owner_sub, provider, ciphertext, iv, tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner_sub) DO UPDATE SET
         provider = EXCLUDED.provider,
         ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv,
         tag = EXCLUDED.tag,
         updated_at = NOW()`,
      [ownerSub, provider, ciphertext, iv, tag]
    );
  }

  async delete(ownerSub: string): Promise<void> {
    validateOwner(ownerSub);
    const result = await this.pool.query(
      'DELETE FROM provider_keys WHERE owner_sub = $1',
      [ownerSub]
    );
  }

  /** Retrieve a secret only for the owning Auth0 subject, for server-side LLM use. */
  async getDecrypted(ownerSub: string): Promise<{ provider: string; apiKey: string } | undefined> {
    validateOwner(ownerSub);
    const { rows } = await this.pool.query<ProviderKeyRow>(
      `SELECT provider, ciphertext, iv, tag, created_at, updated_at
       FROM provider_keys WHERE owner_sub = $1`,
      [ownerSub]
    );
    const row = rows[0];
    if (!row) return undefined;

    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, toBuffer(row.iv));
    decipher.setAAD(Buffer.from(`${ownerSub}\0${row.provider}`, 'utf8'));
    decipher.setAuthTag(toBuffer(row.tag));
    const apiKey = Buffer.concat([
      decipher.update(toBuffer(row.ciphertext)),
      decipher.final(),
    ]).toString('utf8');
    return { provider: row.provider, apiKey };
  }
}

function decodeEncryptionKey(encodedKey: string | undefined): Buffer {
  if (!encodedKey) throw new Error(`${ENCRYPTION_KEY_ENV} must be configured`);
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) {
    throw new Error(`${ENCRYPTION_KEY_ENV} must be canonical base64 for exactly 32 bytes`);
  }
  return key;
}

function validateOwner(ownerSub: string): void {
  if (typeof ownerSub !== 'string' || ownerSub.trim().length === 0 || ownerSub.length > 512) {
    throw new Error('Auth0 subject is invalid');
  }
}

function validateProvider(provider: string): void {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(provider)) throw new Error('Provider identifier is invalid');
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
