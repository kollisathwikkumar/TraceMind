import type { Pool } from 'pg';
import {
  grantRuntimeTenantTables,
  queryForTenant,
  transactionForTenant,
} from './postgres-tenant-context';

/** Investigation history is retained for at most 30 days. */
export const INCIDENT_MEMORY_RETENTION_DAYS = 30;

export interface IncidentMemoryRecord {
  tenantId: string;
  incidentId: string;
  investigationId: string;
  summary: string;
  result: Record<string, unknown>;
  createdAt: string;
}

export interface IncidentMemoryInput {
  tenantId: string;
  incidentId: string;
  investigationId: string;
  summary: string;
  result: Record<string, unknown>;
}

/** Add durable tenant-scoped investigation history using the app's migration role. */
export async function migrateIncidentMemory(pool: Pool, runtimeRole?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS incident_investigation_memory (
        tenant_id TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        summary TEXT NOT NULL CHECK (length(btrim(summary)) > 0 AND length(summary) <= 100000),
        result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, incident_id, investigation_id),
        FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id) ON DELETE CASCADE
      );
      ALTER TABLE incident_investigation_memory
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      UPDATE incident_investigation_memory
        SET expires_at = created_at + INTERVAL '30 days'
        WHERE expires_at IS NULL;
      ALTER TABLE incident_investigation_memory
        ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '30 days'),
        ALTER COLUMN expires_at SET NOT NULL;
      UPDATE incident_investigation_memory
        SET result = jsonb_strip_nulls(jsonb_build_object(
          'rootCause', result->'rootCause',
          'affectedServices', result->'affectedServices',
          'confidence', result->'confidence'
        ))
        WHERE result - 'rootCause' - 'affectedServices' - 'confidence' <> '{}'::jsonb;
      CREATE INDEX IF NOT EXISTS incident_investigation_memory_latest
        ON incident_investigation_memory (tenant_id, incident_id, created_at DESC, investigation_id DESC);
      CREATE INDEX IF NOT EXISTS incident_investigation_memory_expiry
        ON incident_investigation_memory (tenant_id, expires_at);
      CREATE INDEX IF NOT EXISTS incident_investigation_memory_search
        ON incident_investigation_memory USING GIN
        (to_tsvector('english', summary || ' ' || result::text));
      ALTER TABLE incident_investigation_memory ENABLE ROW LEVEL SECURITY;
      ALTER TABLE incident_investigation_memory FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS incident_investigation_memory_tenant_policy
        ON incident_investigation_memory;
      CREATE POLICY incident_investigation_memory_tenant_policy
        ON incident_investigation_memory
        USING (tenant_id = current_setting('app.tenant_id', true))
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    `);
    await grantRuntimeTenantTables(client, runtimeRole, ['incident_investigation_memory']);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresIncidentMemoryStore {
  constructor(private readonly pool: Pool) {}

  async save(input: IncidentMemoryInput): Promise<IncidentMemoryRecord> {
    validateInput(input);
    const safeResult = minimizeResult(input.result);
    const result = await queryForTenant<MemoryRow>(
      this.pool,
      input.tenantId,
      `INSERT INTO incident_investigation_memory
         (tenant_id, incident_id, investigation_id, summary, result, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + INTERVAL '30 days')
       ON CONFLICT (tenant_id, incident_id, investigation_id) DO UPDATE SET
         summary = EXCLUDED.summary, result = EXCLUDED.result,
         created_at = NOW(), expires_at = NOW() + INTERVAL '30 days'
       RETURNING tenant_id, incident_id, investigation_id, summary, result, created_at`,
      [
        input.tenantId,
        input.incidentId,
        input.investigationId,
        input.summary,
        JSON.stringify(safeResult),
      ]
    );
    await this.deleteExpired(input.tenantId);
    return mapRow(result.rows[0]);
  }

  async getHistory(
    tenantId: string,
    incidentId: string,
    limit = 20
  ): Promise<IncidentMemoryRecord[]> {
    await this.deleteExpired(tenantId);
    const result = await queryForTenant<MemoryRow>(
      this.pool,
      tenantId,
      `SELECT tenant_id, incident_id, investigation_id, summary, result, created_at
       FROM incident_investigation_memory WHERE tenant_id = $1 AND incident_id = $2 AND expires_at > NOW()
       ORDER BY created_at DESC, investigation_id DESC LIMIT $3`,
      [tenantId, incidentId, clampLimit(limit)]
    );
    return result.rows.map(mapRow);
  }

  async findRelevant(tenantId: string, query: string, limit = 5): Promise<IncidentMemoryRecord[]> {
    await this.deleteExpired(tenantId);
    const trimmed = query.trim().slice(0, 10_000);
    if (!trimmed) return [];
    const result = await queryForTenant<MemoryRow>(
      this.pool,
      tenantId,
      `SELECT tenant_id, incident_id, investigation_id, summary, result, created_at
       FROM incident_investigation_memory
       WHERE tenant_id = $1 AND expires_at > NOW()
         AND to_tsvector('english', summary || ' ' || result::text)
         @@ websearch_to_tsquery('english', $2)
       ORDER BY ts_rank(to_tsvector('english', summary || ' ' || result::text),
         websearch_to_tsquery('english', $2)) DESC, created_at DESC
       LIMIT $3`,
      [tenantId, trimmed, clampLimit(limit)]
    );
    return result.rows.map(mapRow);
  }

  /** Physically remove expired rows within the caller's RLS tenant context. */
  async deleteExpired(tenantId: string): Promise<number> {
    return transactionForTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        'DELETE FROM incident_investigation_memory WHERE tenant_id=$1 AND expires_at<=NOW()',
        [tenantId]
      );
      return result.rowCount ?? 0;
    });
  }
}

type MemoryRow = {
  tenant_id: string;
  incident_id: string;
  investigation_id: string;
  summary: string;
  result: Record<string, unknown> | string;
  created_at: Date | string;
};

function mapRow(row: MemoryRow): IncidentMemoryRecord {
  if (!row) throw new Error('Investigation memory write returned no row');
  const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
  return {
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    investigationId: row.investigation_id,
    summary: row.summary,
    result,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(Math.floor(limit), 50));
}

function validateInput(input: IncidentMemoryInput): void {
  for (const [name, value, max] of [
    ['tenantId', input.tenantId, 120],
    ['incidentId', input.incidentId, 200],
    ['investigationId', input.investigationId, 255],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      throw new Error(`Invalid investigation memory ${name}`);
    }
  }
  if (!input.summary.trim() || input.summary.length > 100_000) {
    throw new Error('Invalid investigation memory summary');
  }
  if (!input.result || typeof input.result !== 'object' || Array.isArray(input.result)) {
    throw new Error('Investigation memory result must be an object');
  }
}

/** Persist only concise conclusion fields; never store query or evidence/provider payloads. */
export function minimizeResult(result: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (typeof result.rootCause === 'string' && result.rootCause.trim()) {
    safe.rootCause = result.rootCause.trim().slice(0, 2_000);
  }
  if (Array.isArray(result.affectedServices)) {
    safe.affectedServices = result.affectedServices
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .slice(0, 50)
      .map((item) => item.trim().slice(0, 200));
  }
  if (
    result.confidence === 'high' ||
    result.confidence === 'medium' ||
    result.confidence === 'low'
  ) {
    safe.confidence = result.confidence;
  }
  return safe;
}
