import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeType } from '../types';
import { migratePostgresKnowledge, PostgresKnowledgeStore } from './postgres';
import { migratePostgresVectorStore } from './postgres-vector-store';
import { transactionForTenant } from '../../server/postgres-tenant-context';

export interface KnowledgeMigrationResult {
  documents: number;
  chunks: number;
  vectors: number;
  applied: boolean;
}

interface SqliteDocumentRow {
  id: string;
  type: string;
  title: string;
  content: string;
  services: string | null;
  tags: string | null;
  symptoms: string | null;
  severity_relevance: string | null;
  source_url: string | null;
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_validated: string | null;
}

interface SqliteVectorRow {
  id: string;
  chunk_id: string;
  document_id: string;
  embedding: Buffer;
  content: string;
  title: string | null;
  type: string;
  services: string | null;
}

/** Copy a SQLite knowledge/vector snapshot into canonical PostgreSQL tables. */
export async function migrateSqliteKnowledgeToPostgres(
  sourcePath: string,
  pool: Pool | undefined,
  tenantId: string,
  apply = false,
  vectorPath = join(dirname(sourcePath), 'vectors.db'),
  migrationPool: Pool | undefined = pool,
  runtimeRole?: string
): Promise<KnowledgeMigrationResult> {
  if (!tenantId.trim()) throw new Error('Tenant ID must not be empty.');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const separateVectorSource = existsSync(vectorPath)
    ? new Database(vectorPath, { readonly: true, fileMustExist: true })
    : undefined;
  try {
    const documents = source
      .prepare('SELECT * FROM documents ORDER BY id')
      .all() as SqliteDocumentRow[];
    const vectorSource = separateVectorSource ?? source;
    const hasVectors = vectorSource
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vector_embeddings'")
      .get();
    const vectors = hasVectors
      ? (vectorSource
          .prepare('SELECT * FROM vector_embeddings ORDER BY id')
          .all() as SqliteVectorRow[])
      : [];
    const chunksByDocument = new Map<string, KnowledgeChunk[]>();
    const chunks = source.prepare('SELECT * FROM chunks ORDER BY document_id,id').all() as Array<{
      id: string;
      document_id: string;
      content: string;
      section_title: string | null;
      chunk_type: KnowledgeChunk['chunkType'];
      line_start: number | null;
      line_end: number | null;
    }>;
    for (const row of chunks) {
      const list = chunksByDocument.get(row.document_id) ?? [];
      list.push({
        id: row.id,
        documentId: row.document_id,
        content: row.content,
        sectionTitle: row.section_title ?? undefined,
        chunkType: row.chunk_type,
        lineStart: row.line_start ?? undefined,
        lineEnd: row.line_end ?? undefined,
      });
      chunksByDocument.set(row.document_id, list);
    }

    if (apply) {
      if (!pool)
        throw new Error('A PostgreSQL connection pool is required when applying the migration.');
      if (!migrationPool) throw new Error('A privileged PostgreSQL migration pool is required when applying the migration.');
      await migratePostgresKnowledge(migrationPool, runtimeRole);
      await migratePostgresVectorStore(migrationPool, runtimeRole);
      const store = new PostgresKnowledgeStore(pool, tenantId, false);
      for (const row of documents) {
        await store.upsertDocument({
          id: row.id,
          source: {
            type: 'filesystem',
            name: 'sqlite-import',
            config: { type: 'filesystem', path: '', filePatterns: [] },
          },
          type: row.type as KnowledgeType,
          title: row.title,
          content: row.content,
          chunks: chunksByDocument.get(row.id) ?? [],
          services: jsonArray(row.services),
          tags: jsonArray(row.tags),
          symptoms: jsonArray(row.symptoms),
          severityRelevance: jsonArray(
            row.severity_relevance
          ) as KnowledgeDocument['severityRelevance'],
          sourceUrl: row.source_url ?? undefined,
          author: row.author ?? undefined,
          createdAt: row.created_at ?? '',
          updatedAt: row.updated_at ?? '',
          lastValidated: row.last_validated ?? undefined,
        });
      }
      if (vectors.length > 0) {
        await transactionForTenant(pool, tenantId, async (client) => {
          for (const row of vectors) {
            const embedding = decodeFloat64(row.embedding);
            await client.query(
              `INSERT INTO knowledge_vector_embeddings
                (tenant_id,id,chunk_id,document_id,embedding,content,title,type,services,updated_at)
               VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,NOW())
               ON CONFLICT(tenant_id,id) DO UPDATE SET
                chunk_id=EXCLUDED.chunk_id,document_id=EXCLUDED.document_id,
                embedding=EXCLUDED.embedding,content=EXCLUDED.content,title=EXCLUDED.title,
                type=EXCLUDED.type,services=EXCLUDED.services,updated_at=NOW()`,
              [
                tenantId,
                row.id,
                row.chunk_id,
                row.document_id,
                JSON.stringify(embedding),
                row.content,
                row.title,
                row.type,
                JSON.stringify(jsonArray(row.services)),
              ]
            );
          }
        });
      }
    }
    return {
      documents: documents.length,
      chunks: chunks.length,
      vectors: vectors.length,
      applied: apply,
    };
  } finally {
    separateVectorSource?.close();
    source.close();
  }
}

function jsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function decodeFloat64(buffer: Buffer): number[] {
  if (buffer.length % 8 !== 0) throw new Error('SQLite vector blob length is not a Float64 array.');
  const values: number[] = [];
  for (let offset = 0; offset < buffer.length; offset += 8) {
    const value = buffer.readDoubleLE(offset);
    if (!Number.isFinite(value)) throw new Error('SQLite vector contains a non-finite number.');
    values.push(value);
  }
  if (values.length === 0) throw new Error('SQLite vector is empty.');
  return values;
}
