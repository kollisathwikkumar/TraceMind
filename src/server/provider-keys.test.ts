import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import { ProviderKeyStore, migrateProviderKeys } from './provider-keys';

type StoredKey = {
  provider: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  created_at: Date;
  updated_at: Date;
};

function memoryPool() {
  const records = new Map<string, StoredKey>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const owner = String(values[0] || '');
      if (sql.includes('INSERT INTO provider_keys')) {
        const existing = records.get(owner);
        records.set(owner, {
          provider: String(values[1]),
          ciphertext: Buffer.from(values[2] as Buffer),
          iv: Buffer.from(values[3] as Buffer),
          tag: Buffer.from(values[4] as Buffer),
          created_at: existing?.created_at || new Date('2026-10-17T00:00:00.000Z'),
          updated_at: new Date('2026-10-17T00:00:01.000Z'),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM provider_keys')) {
        return { rows: [], rowCount: records.delete(owner) ? 1 : 0 };
      }
      if (sql.includes('SELECT provider, created_at, updated_at')) {
        const record = records.get(owner);
        return { rows: record ? [{ provider: record.provider, created_at: record.created_at, updated_at: record.updated_at }] : [], rowCount: record ? 1 : 0 };
      }
      if (sql.includes('SELECT provider, ciphertext, iv, tag')) {
        const record = records.get(owner);
        return { rows: record ? [{ ...record }] : [], rowCount: record ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    records,
    calls,
  };
  return pool;
}

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

describe('ProviderKeyStore', () => {
  it('migrates encrypted per-subject storage and round-trips only for the owner', async () => {
    const pool = memoryPool();
    await migrateProviderKeys(pool as never);
    const store = new ProviderKeyStore(pool as never, keyA);
    await store.save('auth0|alice', 'openai', 'sk-private-example');

    expect(await store.getDecrypted('auth0|alice')).toEqual({
      provider: 'openai',
      apiKey: 'sk-private-example',
    });
    expect(await store.getDecrypted('auth0|bob')).toBeUndefined();
    expect(await store.getStatus('auth0|alice')).toMatchObject({
      configured: true,
      provider: 'openai',
    });
    expect(await store.getStatus('auth0|bob')).toEqual({ configured: false });

    const row = pool.records.get('auth0|alice')!;
    expect(row.ciphertext.toString('utf8')).not.toContain('sk-private-example');
    expect(JSON.stringify(await store.getStatus('auth0|alice'))).not.toContain('sk-private-example');
    expect(pool.calls.every(({ sql }) => !/\$\{?owner|\$\{?provider/.test(sql))).toBe(true);
  });

  it('rejects decryption under a different key and after authenticated data is tampered', async () => {
    const pool = memoryPool();
    const store = new ProviderKeyStore(pool as never, keyA);
    await store.save('auth0|alice', 'anthropic', 'secret-value');
    await expect(new ProviderKeyStore(pool as never, keyB).getDecrypted('auth0|alice')).rejects.toThrow();

    pool.records.get('auth0|alice')!.tag[0] ^= 0xff;
    await expect(store.getDecrypted('auth0|alice')).rejects.toThrow();
  });

  it('deletes only the matching owner row and validates key configuration', async () => {
    const pool = memoryPool();
    const store = new ProviderKeyStore(pool as never, keyA);
    await store.save('auth0|alice', 'openai', 'alice-key');
    await store.save('auth0|bob', 'openai', 'bob-key');
    await store.delete('auth0|alice');
    expect(await store.getStatus('auth0|alice')).toEqual({ configured: false });
    expect(await store.getDecrypted('auth0|bob')).toEqual({ provider: 'openai', apiKey: 'bob-key' });
    expect(() => new ProviderKeyStore(pool as never, 'not-base64')).toThrow(/32 bytes/);
  });
});
