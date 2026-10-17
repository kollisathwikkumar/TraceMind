import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresVectorStore, migratePostgresVectorStore } from './postgres-vector-store';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

function fixturePool(rows: unknown[] = []) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    return { rows: sql.trim().toLowerCase().startsWith('select') ? rows : [], rowCount: sql.trim().toLowerCase().startsWith('select') ? rows.length : 1 };
  });
  const poolQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    return { rows, rowCount: rows.length };
  });
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    end: vi.fn(),
  } as unknown as Pool;
  return { pool, statements, clientQuery, poolQuery };
}

describe('PostgresVectorStore', () => {
  it('creates an extension-free JSONB schema with tenant-scoped indexes', async () => {
    const { pool, poolQuery } = fixturePool();
    await migratePostgresVectorStore(pool);
    const sql = poolQuery.mock.calls[0][0];
    expect(sql).toContain('embedding JSONB NOT NULL');
    expect(sql).toContain('PRIMARY KEY (tenant_id, id)');
    expect(sql).toContain('knowledge_vector_embeddings_document_idx');
    expect(sql.toLowerCase()).not.toContain('create extension');
  });

  it('writes chunks transactionally, upserts by tenant, and scopes destructive operations', async () => {
    const { pool, statements, clientQuery } = fixturePool();
    const store = new PostgresVectorStore(pool, {
      tenantId: 'org-a',
      embedText: async () => [1, 0],
    });
    const chunk = {
      id: 'chunk-1', documentId: 'doc-1', content: 'restart the worker', chunkType: 'procedure' as const,
    };
    await store.addChunk(chunk, 'Worker guide', 'runbook', ['worker']);
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', expect.stringContaining('ON CONFLICT'), 'COMMIT']));
    expect(statements.find(({ sql }) => sql.includes('INSERT INTO'))?.values?.slice(0, 4)).toEqual([
      'org-a', 'vec_chunk-1', 'chunk-1', 'doc-1',
    ]);
    await store.deleteDocument('doc-1');
    await store.clear();
    expect(statements.filter(({ sql }) => sql.startsWith('DELETE')).every(({ values }) => values?.[0] === 'org-a')).toBe(true);
  });

  it('searches exact cosine scores while applying tenant, type and service filters', async () => {
    const { pool, clientQuery } = fixturePool([
      {
        id: 'vec-1', chunk_id: 'chunk-1', document_id: 'doc-1', embedding: [1, 0],
        content: 'restart safely', title: 'Restart', type: 'runbook', services: ['worker'],
      },
      {
        id: 'vec-2', chunk_id: 'chunk-2', document_id: 'doc-2', embedding: [0, 1],
        content: 'other', title: 'Other', type: 'faq', services: ['api'],
      },
    ]);
    const store = new PostgresVectorStore(pool, {
      tenantId: 'org-a', embedText: async () => [1, 0],
    });
    const results = await store.search('restart', {
      topK: 3, minScore: 0.5, typeFilter: ['runbook'], serviceFilter: ['worker'],
    });
    expect(results).toEqual([{
      id: 'chunk-1', documentId: 'doc-1', title: 'Restart', content: 'restart safely',
      type: 'runbook', services: ['worker'], score: 1,
    }]);
    const search = clientQuery.mock.calls.find(([sql]) => sql.includes('FROM knowledge_vector_embeddings'));
    expect(search?.[1]).toEqual(['org-a', ['runbook'], ['worker']]);
    expect(search?.[0]).toContain('tenant_id = $1');
    expect(search?.[0]).toContain('type = ANY($2::text[])');
    expect(search?.[0]).toContain('services ?| $3::text[]');
  });

  it('keeps count/existence reads tenant-scoped and validates stored vector shape', async () => {
    const { pool, clientQuery } = fixturePool([{ count: '4' }]);
    const store = new PostgresVectorStore(pool, { tenantId: 'org-b', embedText: async () => [1] });
    expect(await store.getCount()).toBe(4);
    expect(await store.hasDocument('doc-x')).toBe(true);
    expect(clientQuery.mock.calls.filter(([sql]) => sql.includes('knowledge_vector_embeddings')).every(([, values]) => values?.[0] === 'org-b')).toBe(true);
  });

  it.skipIf(!connectionString)('persists and isolates vectors in a real PostgreSQL schema', async () => {
    const schema = `vector_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      await migratePostgresVectorStore(pool);
      const chunk = {
        id: 'chunk-1', documentId: 'doc-1', content: 'restart the worker', chunkType: 'procedure' as const,
      };
      const tenantA = new PostgresVectorStore(pool, {
        tenantId: 'org-a', embedText: async () => [1, 0],
      });
      const tenantB = new PostgresVectorStore(pool, {
        tenantId: 'org-b', embedText: async () => [0, 1],
      });
      await tenantA.addChunk(chunk, 'Worker runbook', 'runbook', ['worker']);
      await tenantB.addChunk(chunk, 'Private worker runbook', 'runbook', ['worker']);
      expect(await tenantA.getCount()).toBe(1);
      expect(await tenantB.getCount()).toBe(1);
      expect(await tenantA.hasDocument('doc-1')).toBe(true);
      const results = await tenantA.search('worker restart', { minScore: 0.5 });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('restart the worker');
      await tenantA.deleteDocument('doc-1');
      expect(await tenantA.getCount()).toBe(0);
      expect(await tenantB.getCount()).toBe(1);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
