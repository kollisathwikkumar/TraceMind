/**
 * PostgreSQL-backed vector persistence with portable JSONB embeddings.
 *
 * Similarity is calculated in-process so this store works on PostgreSQL
 * providers that do not install pgvector. For large corpora, use a pgvector
 * index or a dedicated vector service behind the same contract.
 */
import type { Pool } from 'pg';
import { grantRuntimeTenantTables, queryForTenant } from '../../server/postgres-tenant-context';
import { cosineSimilarity, embedText, embedTexts, isEmbedderConfigured } from '../indexer/embedder';
import type { KnowledgeChunk, KnowledgeType, RetrievedChunk } from '../types';

export interface VectorDocument {
  id: string;
  chunkId: string;
  documentId: string;
  embedding: number[];
  content: string;
  title?: string;
  type: KnowledgeType;
  services: string[];
}

export interface PostgresVectorStoreOptions {
  /** Organization/tenant boundary; every read, write and delete is scoped to it. */
  tenantId?: string;
  /** Primarily useful for deterministic tests and controlled embedding migrations. */
  embedText?: (text: string) => Promise<number[]>;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  /** Set true only when this store created the pool and owns its lifecycle. */
  ownsPool?: boolean;
}

interface VectorRow {
  id: string;
  chunk_id: string;
  document_id: string;
  embedding: number[] | string;
  content: string;
  title: string | null;
  type: string;
  services: string[] | string | null;
}

const DEFAULT_TENANT_ID = 'default';

/** Idempotently create the schema needed by PostgresVectorStore. */
export async function migratePostgresVectorStore(pool: Pool, runtimeRole?: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_vector_embeddings (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      embedding JSONB NOT NULL,
      content TEXT NOT NULL,
      title TEXT,
      type TEXT NOT NULL,
      services JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, id),
      CHECK (jsonb_typeof(embedding) = 'array'),
      CHECK (jsonb_typeof(services) = 'array')
    );
    CREATE INDEX IF NOT EXISTS knowledge_vector_embeddings_document_idx
      ON knowledge_vector_embeddings (tenant_id, document_id);
    CREATE INDEX IF NOT EXISTS knowledge_vector_embeddings_type_idx
      ON knowledge_vector_embeddings (tenant_id, type);
  `);
  const client = await pool.connect();
  try {
    await grantRuntimeTenantTables(client, runtimeRole, ['knowledge_vector_embeddings']);
  } finally {
    client.release();
  }
  await pool.query(`
    ALTER TABLE knowledge_vector_embeddings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_vector_embeddings FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tracemind_tenant_isolation ON knowledge_vector_embeddings;
    CREATE POLICY tracemind_tenant_isolation ON knowledge_vector_embeddings
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
  `);
}

export class PostgresVectorStore {
  private readonly tenantId: string;
  private readonly embedOne: (text: string) => Promise<number[]>;
  private readonly embedMany: (texts: string[]) => Promise<number[][]>;
  private readonly hasSingleEmbedder: boolean;
  private readonly hasBatchEmbedder: boolean;
  private readonly ownsPool: boolean;

  constructor(
    private readonly pool: Pool,
    options: PostgresVectorStoreOptions = {}
  ) {
    this.tenantId = options.tenantId?.trim() || DEFAULT_TENANT_ID;
    this.embedOne = options.embedText ?? embedText;
    this.embedMany = options.embedTexts ?? embedTexts;
    this.hasSingleEmbedder = options.embedText !== undefined;
    this.hasBatchEmbedder = options.embedTexts !== undefined;
    this.ownsPool = options.ownsPool ?? false;
  }

  async addChunk(
    chunk: KnowledgeChunk,
    documentTitle: string,
    type: KnowledgeType,
    services: string[]
  ): Promise<void> {
    this.assertEmbedderConfigured(this.hasSingleEmbedder);
    const text = [documentTitle, chunk.sectionTitle, chunk.content].filter(Boolean).join('\n\n');
    const embedding = await this.embedOne(text);
    this.validateEmbedding(embedding);
    await this.writeRows([{ chunk, documentTitle, type, services, embedding }]);
  }

  async addChunks(
    chunks: Array<{
      chunk: KnowledgeChunk;
      documentTitle: string;
      type: KnowledgeType;
      services: string[];
    }>
  ): Promise<void> {
    if (chunks.length === 0) return;
    this.assertEmbedderConfigured(this.hasBatchEmbedder || this.hasSingleEmbedder);
    const texts = chunks.map(({ chunk, documentTitle }) =>
      [documentTitle, chunk.sectionTitle, chunk.content].filter(Boolean).join('\n\n')
    );
    const embeddings = this.hasBatchEmbedder
      ? await this.embedMany(texts)
      : this.hasSingleEmbedder
        ? await Promise.all(texts.map((text) => this.embedOne(text)))
        : await this.embedMany(texts);
    if (embeddings.length !== chunks.length)
      throw new Error('Embedder returned an unexpected number of vectors.');
    chunks.forEach((_, i) => this.validateEmbedding(embeddings[i]));
    await this.writeRows(chunks.map((entry, i) => ({ ...entry, embedding: embeddings[i] })));
  }

  async search(
    query: string,
    options: {
      topK?: number;
      typeFilter?: KnowledgeType[];
      serviceFilter?: string[];
      minScore?: number;
    } = {}
  ): Promise<RetrievedChunk[]> {
    this.assertEmbedderConfigured(this.hasSingleEmbedder);
    const queryEmbedding = await this.embedOne(query);
    this.validateEmbedding(queryEmbedding);
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0.5;
    if (topK <= 0) return [];

    // Portable exact search: no extension is required. Filter by tenant and
    // metadata in SQL before pulling vectors into application memory.
    const params: unknown[] = [this.tenantId];
    let sql = `SELECT id, chunk_id, document_id, embedding, content, title, type, services
      FROM knowledge_vector_embeddings WHERE tenant_id = $1`;
    if (options.typeFilter?.length) {
      params.push(options.typeFilter);
      sql += ` AND type = ANY($${params.length}::text[])`;
    }
    if (options.serviceFilter?.length) {
      params.push(options.serviceFilter);
      sql += ` AND services ?| $${params.length}::text[]`;
    }
    const rows = (await queryForTenant<VectorRow>(this.pool, this.tenantId, sql, params)).rows;
    return rows
      .map((row) => {
        const embedding = this.parseJsonArray(row.embedding, 'embedding');
        const services = this.parseJsonArray(row.services ?? [], 'services') as string[];
        return {
          id: row.chunk_id,
          documentId: row.document_id,
          title: row.title ?? '',
          content: row.content,
          type: row.type as KnowledgeType,
          services,
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      })
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteDocument(documentId: string): Promise<void> {
    await queryForTenant(this.pool, this.tenantId,
      'DELETE FROM knowledge_vector_embeddings WHERE tenant_id = $1 AND document_id = $2',
      [this.tenantId, documentId]
    );
  }

  async getCount(): Promise<number> {
    const result = await queryForTenant<{ count: string }>(this.pool, this.tenantId,
      'SELECT COUNT(*)::text AS count FROM knowledge_vector_embeddings WHERE tenant_id = $1',
      [this.tenantId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async hasDocument(documentId: string): Promise<boolean> {
    const result = await queryForTenant(this.pool, this.tenantId,
      'SELECT 1 FROM knowledge_vector_embeddings WHERE tenant_id = $1 AND document_id = $2 LIMIT 1',
      [this.tenantId, documentId]
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async clear(): Promise<void> {
    await queryForTenant(this.pool, this.tenantId, 'DELETE FROM knowledge_vector_embeddings WHERE tenant_id = $1', [
      this.tenantId,
    ]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private assertEmbedderConfigured(injected = false): void {
    // Injected embedders are an explicit configuration and need not rely on env.
    if (injected) return;
    if (!isEmbedderConfigured()) throw new Error('Embedder not configured. Set OPENAI_API_KEY.');
  }

  private validateEmbedding(embedding: number[] | undefined): asserts embedding is number[] {
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error('Embedding must be a non-empty array of finite numbers.');
    }
  }

  private parseJsonArray<T>(value: T[] | string, field: string): T[] {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error(`Stored vector ${field} is not a JSON array.`);
    return parsed as T[];
  }

  private async writeRows(
    rows: Array<{
      chunk: KnowledgeChunk;
      documentTitle: string;
      type: KnowledgeType;
      services: string[];
      embedding: number[];
    }>
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [this.tenantId]);
      for (const { chunk, documentTitle, type, services, embedding } of rows) {
        await client.query(
          `INSERT INTO knowledge_vector_embeddings
            (tenant_id, id, chunk_id, document_id, embedding, content, title, type, services, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, NOW())
           ON CONFLICT (tenant_id, id) DO UPDATE SET
             chunk_id = EXCLUDED.chunk_id, document_id = EXCLUDED.document_id,
             embedding = EXCLUDED.embedding, content = EXCLUDED.content, title = EXCLUDED.title,
             type = EXCLUDED.type, services = EXCLUDED.services, updated_at = NOW()`,
          [
            this.tenantId,
            `vec_${chunk.id}`,
            chunk.id,
            chunk.documentId,
            JSON.stringify(embedding),
            chunk.content,
            chunk.sectionTitle || documentTitle,
            type,
            JSON.stringify(services),
          ]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
