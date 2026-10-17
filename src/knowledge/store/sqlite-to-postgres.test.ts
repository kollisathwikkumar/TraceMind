import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migratePostgresKnowledge, PostgresKnowledgeStore } from './postgres';
import { migratePostgresVectorStore, PostgresVectorStore } from './postgres-vector-store';
import { migrateSqliteKnowledgeToPostgres } from './sqlite-to-postgres';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe('SQLite-to-PostgreSQL knowledge migration', () => {
  it.skipIf(!connectionString)(
    'copies documents, chunks and vector blobs without modifying the SQLite source',
    async () => {
      const schema = `sqlite_import_${randomUUID().replaceAll('-', '')}`;
      const runtimeRole = `tm_import_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const migrationPool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      let pool: Pool | undefined;
      let roleCreated = false;
      const tempDir = mkdtempSync(join(tmpdir(), 'tracemind-sqlite-import-'));
      const sourcePath = join(tempDir, 'knowledge.db');
      const vectorPath = join(tempDir, 'vectors.db');
      const source = new Database(sourcePath);
      source.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, type TEXT, title TEXT, content TEXT, services TEXT, tags TEXT,
        symptoms TEXT, severity_relevance TEXT, source_url TEXT, author TEXT,
        created_at TEXT, updated_at TEXT, last_validated TEXT
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY, document_id TEXT, content TEXT, section_title TEXT,
        chunk_type TEXT, line_start INTEGER, line_end INTEGER
      );
    `);
      source
        .prepare(`INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          'doc-1',
          'runbook',
          'Worker recovery',
          'Restart worker',
          '["worker"]',
          '[]',
          '[]',
          '[]',
          null,
          null,
          '2026-01-01',
          '2026-01-02',
          null
        );
      source
        .prepare(`INSERT INTO chunks VALUES(?,?,?,?,?,?,?)`)
        .run('chunk-1', 'doc-1', 'Restart the worker safely', 'Recovery', 'procedure', 1, 2);
      source.close();
      const vectorSource = new Database(vectorPath);
      vectorSource.exec(`CREATE TABLE vector_embeddings (
        id TEXT PRIMARY KEY, chunk_id TEXT, document_id TEXT, embedding BLOB, content TEXT,
        title TEXT, type TEXT, services TEXT
      );
    `);
      const embedding = Buffer.alloc(16);
      embedding.writeDoubleLE(1, 0);
      embedding.writeDoubleLE(0, 8);
      vectorSource
        .prepare(`INSERT INTO vector_embeddings VALUES(?,?,?,?,?,?,?,?)`)
        .run(
          'vec_chunk-1',
          'chunk-1',
          'doc-1',
          embedding,
          'Restart the worker safely',
          'Recovery',
          'runbook',
          '["worker"]'
        );
      vectorSource.close();
      try {
        await migratePostgresKnowledge(migrationPool);
        await migratePostgresVectorStore(migrationPool);
        await admin.query(`CREATE ROLE ${runtimeRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        roleCreated = true;
        await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${runtimeRole}`);
        await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${runtimeRole}`);
        await admin.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${runtimeRole}`);
        pool = new Pool({ connectionString, options: `-c search_path=${schema} -c role=${runtimeRole}` });
        const dryRun = await migrateSqliteKnowledgeToPostgres(
          sourcePath,
          undefined,
          'org-a',
          false,
          vectorPath
        );
        expect(dryRun).toEqual({ documents: 1, chunks: 1, vectors: 1, applied: false });
        expect(await new PostgresKnowledgeStore(pool!, 'org-a', false).getDocumentCount()).toBe(0);
        const result = await migrateSqliteKnowledgeToPostgres(
          sourcePath,
          pool!,
          'org-a',
          true,
          vectorPath,
          migrationPool
        );
        expect(result).toEqual({ documents: 1, chunks: 1, vectors: 1, applied: true });
        const document = await new PostgresKnowledgeStore(pool!, 'org-a', false).getDocument('doc-1');
        expect(document?.chunks[0]?.content).toBe('Restart the worker safely');
        const vectorStore = new PostgresVectorStore(pool!, {
          tenantId: 'org-a',
          embedText: async () => [1, 0],
        });
        expect(await vectorStore.getCount()).toBe(1);
        expect(
          (await vectorStore.search('worker', { minScore: 0.5 })).map((chunk) => chunk.id)
        ).toEqual(['chunk-1']);
        const reopenedSource = new Database(sourcePath, { readonly: true });
        expect(
          reopenedSource.prepare('SELECT COUNT(*) AS count FROM documents').get()
        ).toMatchObject({ count: 1 });
        reopenedSource.close();
      } finally {
        await pool?.end();
        await migrationPool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        if (roleCreated) {
          await admin.query(`DROP OWNED BY ${runtimeRole}`).catch(() => undefined);
          await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => undefined);
        }
        await admin.end();
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );
});
