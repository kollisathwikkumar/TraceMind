/**
 * PostgreSQL-backed knowledge document and chunk storage.
 *
 * Unlike the SQLite implementation, operations are asynchronous and every
 * query is scoped to a tenant. The caller owns the shared Pool; close() is a
 * no-op so closing this store cannot disrupt other repositories.
 */
import type { Pool, PoolClient } from 'pg';
import { grantRuntimeTenantTables, queryForTenant } from '../../server/postgres-tenant-context';
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeType, RetrievedChunk } from '../types';

const TYPE_COUNTS: KnowledgeType[] = [
  'runbook',
  'postmortem',
  'architecture',
  'ownership',
  'known_issue',
  'environment',
  'playbook',
  'faq',
];

/** Create the knowledge schema and indexes. Safe to run repeatedly. */
export async function migratePostgresKnowledge(pool: Pool, runtimeRole?: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      services JSONB NOT NULL DEFAULT '[]'::jsonb,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      symptoms JSONB NOT NULL DEFAULT '[]'::jsonb,
      severity_relevance JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_url TEXT,
      author TEXT,
      source JSONB,
      created_at TEXT,
      updated_at TEXT,
      last_validated TEXT,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      content TEXT NOT NULL,
      section_title TEXT,
      chunk_type TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(section_title, ''))
      ) STORED,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, document_id)
        REFERENCES knowledge_documents(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS knowledge_documents_tenant_type_idx
      ON knowledge_documents(tenant_id, type);
    CREATE INDEX IF NOT EXISTS knowledge_documents_services_idx
      ON knowledge_documents USING GIN(services);
    CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
      ON knowledge_chunks(tenant_id, document_id);
    CREATE INDEX IF NOT EXISTS knowledge_chunks_search_idx
      ON knowledge_chunks USING GIN(search_vector);
  `);
  const client = await pool.connect();
  try {
    await grantRuntimeTenantTables(client, runtimeRole, ['knowledge_documents','knowledge_chunks']);
  } finally {
    client.release();
  }
  await pool.query(`
    ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tracemind_tenant_isolation ON knowledge_documents;
    CREATE POLICY tracemind_tenant_isolation ON knowledge_documents
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tracemind_tenant_isolation ON knowledge_chunks;
    CREATE POLICY tracemind_tenant_isolation ON knowledge_chunks
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
  `);
}

/**
 * Async PostgreSQL equivalent of KnowledgeStore. It deliberately receives a
 * Pool instead of creating one, allowing application services to share a
 * connection pool and migrations.
 */
export class PostgresKnowledgeStore {
  private readyPromise?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly tenantId = 'default',
    private readonly initializeSchema = true
  ) {
    if (!tenantId.trim()) throw new Error('Knowledge store tenant ID must not be empty');
  }

  private ready(): Promise<void> {
    this.readyPromise ??= this.initializeSchema
      ? migratePostgresKnowledge(this.pool)
      : Promise.resolve();
    return this.readyPromise;
  }

  async upsertDocument(doc: KnowledgeDocument): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [this.tenantId]);
      await client.query(
        `INSERT INTO knowledge_documents
          (tenant_id,id,type,title,content,services,tags,symptoms,severity_relevance,
           source_url,author,source,created_at,updated_at,last_validated)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15)
         ON CONFLICT (tenant_id,id) DO UPDATE SET
          type=EXCLUDED.type,title=EXCLUDED.title,content=EXCLUDED.content,
          services=EXCLUDED.services,tags=EXCLUDED.tags,symptoms=EXCLUDED.symptoms,
          severity_relevance=EXCLUDED.severity_relevance,source_url=EXCLUDED.source_url,
          author=EXCLUDED.author,source=EXCLUDED.source,created_at=EXCLUDED.created_at,
          updated_at=EXCLUDED.updated_at,last_validated=EXCLUDED.last_validated`,
        [
          this.tenantId,
          doc.id,
          doc.type,
          doc.title,
          doc.content,
          JSON.stringify(doc.services ?? []),
          JSON.stringify(doc.tags ?? []),
          JSON.stringify(doc.symptoms ?? []),
          JSON.stringify(doc.severityRelevance ?? []),
          doc.sourceUrl ?? null,
          doc.author ?? null,
          JSON.stringify(doc.source ?? null),
          doc.createdAt ?? null,
          doc.updatedAt ?? null,
          doc.lastValidated ?? null,
        ]
      );
      await client.query('DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2', [
        this.tenantId,
        doc.id,
      ]);
      for (const chunk of doc.chunks ?? []) {
        await insertChunk(client, this.tenantId, doc.id, chunk);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async search(
    query: string,
    options: { typeFilter?: KnowledgeType[]; serviceFilter?: string[]; limit?: number } = {}
  ): Promise<RetrievedChunk[]> {
    await this.ready();
    const terms =
      (typeof query === 'string' ? query : String(query ?? '')).match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
    const uniqueTerms = [...new Set(terms.map((term) => term.toLocaleLowerCase()))];
    if (!uniqueTerms.length) return [];
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 10)));
    const params: unknown[] = [this.tenantId, uniqueTerms.join(' ')];
    let filters = '';
    if (options.typeFilter?.length) {
      params.push(options.typeFilter);
      filters += ` AND d.type = ANY($${params.length}::text[])`;
    }
    if (options.serviceFilter?.length) {
      params.push(JSON.stringify(options.serviceFilter));
      filters += ` AND d.services ?| ARRAY(SELECT jsonb_array_elements_text($${params.length}::jsonb))`;
    }
    params.push(limit);
    const { rows } = await queryForTenant<{
      id: string;
      document_id: string;
      content: string;
      section_title: string | null;
      title: string;
      type: KnowledgeType;
      services: string[];
      source_url: string | null;
      score: number;
    }>(this.pool, this.tenantId,
      `SELECT c.id,c.document_id,c.content,c.section_title,d.title,d.type,d.services,
              d.source_url, ts_rank_cd(c.search_vector, plainto_tsquery('simple',$2)) AS score
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.tenant_id=c.tenant_id AND d.id=c.document_id
       WHERE c.tenant_id=$1 AND c.search_vector @@ plainto_tsquery('simple',$2)${filters}
       ORDER BY score DESC,c.id LIMIT $${params.length}`,
      params
    );
    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      title: row.section_title || row.title,
      content: row.content,
      type: row.type,
      services: parseJsonArray(row.services),
      // A higher score means a stronger match in PostgreSQL FTS.
      score: Number(row.score),
      sourceUrl: row.source_url ?? undefined,
    }));
  }

  async getDocumentsByType(type: KnowledgeType): Promise<KnowledgeDocument[]> {
    await this.ready();
    const { rows } = await queryForTenant(this.pool, this.tenantId,
      'SELECT * FROM knowledge_documents WHERE tenant_id=$1 AND type=$2 ORDER BY id',
      [this.tenantId, type]
    );
    return rows.map((row) => mapDocument(row));
  }

  async getAllDocuments(): Promise<KnowledgeDocument[]> {
    await this.ready();
    const { rows } = await queryForTenant(this.pool, this.tenantId,
      'SELECT * FROM knowledge_documents WHERE tenant_id=$1 ORDER BY id',
      [this.tenantId]
    );
    return rows.map((row) => mapDocument(row));
  }

  async getDocumentCountsByType(): Promise<Record<KnowledgeType, number>> {
    await this.ready();
    const counts = Object.fromEntries(TYPE_COUNTS.map((type) => [type, 0])) as Record<
      KnowledgeType,
      number
    >;
    const { rows } = await queryForTenant<{ type: string; count: string }>(this.pool, this.tenantId,
      'SELECT type,COUNT(*)::text AS count FROM knowledge_documents WHERE tenant_id=$1 GROUP BY type',
      [this.tenantId]
    );
    for (const row of rows)
      if (row.type in counts) counts[row.type as KnowledgeType] = Number(row.count);
    return counts;
  }

  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    await this.ready();
    const { rows } = await queryForTenant(this.pool, this.tenantId,
      'SELECT * FROM knowledge_documents WHERE tenant_id=$1 AND id=$2',
      [this.tenantId, id]
    );
    if (!rows[0]) return null;
    const doc = mapDocument(rows[0]);
    const chunks = await queryForTenant(this.pool, this.tenantId,
      'SELECT id,document_id,content,section_title,chunk_type,line_start,line_end FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2 ORDER BY id',
      [this.tenantId, id]
    );
    doc.chunks = chunks.rows.map(mapChunk);
    return doc;
  }

  async getDocumentCount(): Promise<number> {
    await this.ready();
    const { rows } = await queryForTenant<{ count: string }>(this.pool, this.tenantId,
      'SELECT COUNT(*)::text AS count FROM knowledge_documents WHERE tenant_id=$1',
      [this.tenantId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async deleteDocument(id: string): Promise<void> {
    await this.ready();
    await queryForTenant(this.pool, this.tenantId, 'DELETE FROM knowledge_documents WHERE tenant_id=$1 AND id=$2', [
      this.tenantId,
      id,
    ]);
  }

  async clear(): Promise<void> {
    await this.ready();
    await queryForTenant(this.pool, this.tenantId, 'DELETE FROM knowledge_documents WHERE tenant_id=$1', [this.tenantId]);
  }

  /** The caller owns the pool, so this method intentionally does not end it. */
  async close(): Promise<void> {}
}

async function insertChunk(
  client: PoolClient,
  tenantId: string,
  documentId: string,
  chunk: KnowledgeChunk
) {
  await client.query(
    `INSERT INTO knowledge_chunks(tenant_id,id,document_id,content,section_title,chunk_type,line_start,line_end)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tenantId,
      chunk.id,
      documentId,
      chunk.content,
      chunk.sectionTitle ?? null,
      chunk.chunkType,
      chunk.lineStart ?? null,
      chunk.lineEnd ?? null,
    ]
  );
}

function mapDocument(row: Record<string, unknown>): KnowledgeDocument {
  const source = parseJson(row.source) as KnowledgeDocument['source'] | undefined;
  return {
    id: String(row.id),
    source: source ?? {
      type: 'filesystem',
      name: 'postgres',
      config: { type: 'filesystem', path: '', filePatterns: [] },
    },
    type: row.type as KnowledgeType,
    title: String(row.title),
    content: String(row.content),
    chunks: [],
    services: parseJsonArray(row.services),
    tags: parseJsonArray(row.tags),
    symptoms: parseJsonArray(row.symptoms),
    severityRelevance: parseJsonArray(
      row.severity_relevance
    ) as KnowledgeDocument['severityRelevance'],
    createdAt: row.created_at == null ? '' : String(row.created_at),
    updatedAt: row.updated_at == null ? '' : String(row.updated_at),
    author: row.author == null ? undefined : String(row.author),
    sourceUrl: row.source_url == null ? undefined : String(row.source_url),
    lastValidated: row.last_validated == null ? undefined : String(row.last_validated),
  };
}

function mapChunk(row: Record<string, unknown>): KnowledgeChunk {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    content: String(row.content),
    sectionTitle: row.section_title == null ? undefined : String(row.section_title),
    chunkType: row.chunk_type as KnowledgeChunk['chunkType'],
    lineStart: row.line_start == null ? undefined : Number(row.line_start),
    lineEnd: row.line_end == null ? undefined : Number(row.line_end),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}
