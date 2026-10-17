import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { KnowledgeDocument } from '../types';
import { migratePostgresKnowledge, PostgresKnowledgeStore } from './postgres';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe('PostgresKnowledgeStore', () => {
  it.skipIf(!connectionString)('persists and searches documents with tenant isolation', async () => {
    const schema = `knowledge_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      await migratePostgresKnowledge(pool);
      const tenantA = new PostgresKnowledgeStore(pool, 'org-a', false);
      const tenantB = new PostgresKnowledgeStore(pool, 'org-b', false);
      const document: KnowledgeDocument = {
        id: 'runbook-1',
        source: { type: 'api', name: 'fixture', config: { type: 'api', endpoint: 'https://example.test/docs' } },
        type: 'runbook',
        title: 'Database connection recovery',
        content: 'Restart the pooler and verify database connectivity.',
        chunks: [{
          id: 'chunk-1', documentId: 'runbook-1', content: 'Restart the pooler and verify database connectivity.',
          chunkType: 'procedure', sectionTitle: 'Recovery', lineStart: 2, lineEnd: 4,
        }],
        services: ['payments'], tags: ['database'], severityRelevance: ['sev1'],
        symptoms: ['connection timeout'], createdAt: '2026-01-01', updatedAt: '2026-01-02',
        sourceUrl: 'https://example.test/docs/runbook', author: 'platform',
      };
      await tenantA.upsertDocument(document);
      await tenantB.upsertDocument({ ...document, title: 'Tenant B runbook', content: 'Different content', chunks: [] });

      expect(await tenantA.getDocumentCount()).toBe(1);
      expect(await tenantB.getDocumentCount()).toBe(1);
      expect((await tenantA.search('database connectivity')).map((item) => item.id)).toEqual(['chunk-1']);
      expect(await tenantA.search('database', { serviceFilter: ['payments'] })).toHaveLength(1);
      expect(await tenantA.search('database', { serviceFilter: ['billing'] })).toHaveLength(0);
      expect((await tenantB.search('database')).map((item) => item.title)).toEqual([]);
      expect((await tenantA.getDocumentsByType('runbook'))[0].source).toEqual(document.source);
      expect((await tenantA.getDocument('runbook-1'))?.chunks).toEqual(document.chunks);
      expect((await tenantA.getDocumentCountsByType()).runbook).toBe(1);

      await tenantA.upsertDocument({ ...document, title: 'Updated recovery guide', chunks: [] });
      expect((await tenantA.getDocument('runbook-1'))?.title).toBe('Updated recovery guide');
      expect(await tenantA.search('database connectivity')).toEqual([]);
      expect(await tenantB.getDocument('runbook-1')).not.toBeNull();
      await tenantA.deleteDocument('runbook-1');
      expect(await tenantA.getDocument('runbook-1')).toBeNull();
      await tenantB.clear();
      expect(await tenantB.getDocumentCount()).toBe(0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
