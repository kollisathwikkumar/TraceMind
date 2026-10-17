import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { grantRuntimeTenantTables, queryForTenant, transactionForTenant } from './postgres-tenant-context';

export interface GraphServiceInput {
  orgId: string;
  id: string;
  name: string;
  serviceType?: string;
  owner?: string;
  aggregateVersion?: number;
}

export interface GraphDependencyInput {
  orgId: string;
  dependentId: string;
  dependencyId: string;
  criticality?: 'critical' | 'degraded' | 'optional';
  aggregateVersion?: number;
}

export interface IncidentServiceLinkInput {
  orgId: string;
  incidentId: string;
  title: string;
  serviceId: string;
  aggregateVersion?: number;
}

export type GraphCatalogEvent =
  | {
      type: 'service.upsert';
      orgId: string;
      data: Omit<GraphServiceInput, 'orgId'>;
      aggregateId: string;
      aggregateVersion: number;
    }
  | {
      type: 'dependency.link';
      orgId: string;
      data: Omit<GraphDependencyInput, 'orgId'>;
      aggregateId: string;
      aggregateVersion: number;
    }
  | {
      type: 'incident.service.link';
      orgId: string;
      data: Omit<IncidentServiceLinkInput, 'orgId'>;
      aggregateId: string;
      aggregateVersion: number;
    };

export interface GraphCatalogProjectionPort {
  upsertService(input: GraphServiceInput): Promise<void>;
  linkDependency(input: GraphDependencyInput): Promise<void>;
  linkIncidentToService(input: IncidentServiceLinkInput): Promise<void>;
}

/**
 * Bootstraps the canonical PostgreSQL graph catalog and its independent outbox.
 * Call after the application's core PostgreSQL tables have been migrated.
 */
export async function migrateGraphCatalog(pool: Pool, runtimeRole?: string): Promise<void> {
  await inTransaction(pool, undefined, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS graph_catalog_schema_migrations (
        version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await grantRuntimeTenantTables(client, runtimeRole, [
      'graph_catalog_schema_migrations','graph_catalog_services','graph_catalog_dependencies',
      'graph_catalog_incident_services','graph_catalog_outbox',
    ]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS graph_catalog_services (
        org_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 255),
        service_type TEXT NOT NULL DEFAULT 'service',
        owner TEXT NOT NULL DEFAULT '',
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (org_id, id)
      );
      CREATE TABLE IF NOT EXISTS graph_catalog_dependencies (
        org_id TEXT NOT NULL,
        dependent_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        criticality TEXT NOT NULL CHECK (criticality IN ('critical','degraded','optional')),
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (org_id, dependent_id, dependency_id),
        FOREIGN KEY (org_id, dependent_id) REFERENCES graph_catalog_services(org_id, id),
        FOREIGN KEY (org_id, dependency_id) REFERENCES graph_catalog_services(org_id, id),
        CHECK (dependent_id <> dependency_id)
      );
      CREATE TABLE IF NOT EXISTS graph_catalog_incident_services (
        org_id TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        incident_title TEXT NOT NULL CHECK (length(btrim(incident_title)) > 0),
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (org_id, incident_id, service_id),
        FOREIGN KEY (org_id, service_id) REFERENCES graph_catalog_services(org_id, id)
      );
      CREATE INDEX IF NOT EXISTS graph_catalog_incident_services_by_service
        ON graph_catalog_incident_services(org_id, service_id, incident_id);
      CREATE TABLE IF NOT EXISTS graph_catalog_outbox (
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_until TIMESTAMPTZ,
        lease_token TEXT,
        processed_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS graph_catalog_outbox_ready
        ON graph_catalog_outbox(available_at, id) WHERE processed_at IS NULL;
      CREATE INDEX IF NOT EXISTS graph_catalog_outbox_aggregate_order
        ON graph_catalog_outbox(org_id, aggregate_type, aggregate_id, aggregate_version)
        WHERE processed_at IS NULL;
    `);
    await client.query('ALTER TABLE graph_catalog_outbox ADD COLUMN IF NOT EXISTS lease_token TEXT');
    await client.query(
      'INSERT INTO graph_catalog_schema_migrations(version) VALUES(1) ON CONFLICT(version) DO NOTHING'
    );
    await client.query(`
      DO $$ DECLARE tbl TEXT; BEGIN
        FOREACH tbl IN ARRAY ARRAY['graph_catalog_services','graph_catalog_dependencies','graph_catalog_incident_services','graph_catalog_outbox'] LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
          EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
          EXECUTE format('DROP POLICY IF EXISTS tracemind_tenant_isolation ON %I', tbl);
          EXECUTE format('CREATE POLICY tracemind_tenant_isolation ON %I USING (org_id = current_setting(''app.tenant_id'', true)) WITH CHECK (org_id = current_setting(''app.tenant_id'', true))', tbl);
        END LOOP;
      END $$;
    `);
  });
}

/**
 * PostgreSQL is authoritative for topology. Each mutation and its projection
 * event commit atomically; FalkorDB is updated asynchronously by replay().
 */
export class PostgresGraphCatalogStore {
  constructor(private readonly pool: Pool, private readonly defaultOrgId = 'default') {}

  async checkHealth(orgId = this.defaultOrgId): Promise<number> {
    const result = await queryForTenant<{ pending: string | number }>(this.pool, orgId,
      'SELECT count(*) AS pending FROM graph_catalog_outbox WHERE processed_at IS NULL'
    );
    return Number(result.rows[0]?.pending || 0);
  }

  async upsertService(input: GraphServiceInput): Promise<void> {
    validateScopeAndId(input.orgId, input.id);
    if (!input.name.trim()) throw new Error('Service name is required');
    await inTransaction(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ version: string | number }>(
        `INSERT INTO graph_catalog_services(org_id,id,name,service_type,owner)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(org_id,id) DO UPDATE SET
           name=EXCLUDED.name, service_type=EXCLUDED.service_type,
           owner=EXCLUDED.owner, version=graph_catalog_services.version+1,
           updated_at=NOW()
         RETURNING version`,
        [
          input.orgId,
          input.id,
          input.name.trim(),
          input.serviceType?.trim() || 'service',
          input.owner?.trim() || '',
        ]
      );
      await appendOutbox(client, {
        orgId: input.orgId,
        aggregateType: 'service',
        aggregateId: input.id,
        aggregateVersion: Number(result.rows[0].version),
        eventType: 'service.upsert',
        payload: {
          id: input.id,
          name: input.name.trim(),
          serviceType: input.serviceType || 'service',
          owner: input.owner || '',
        },
      });
    });
  }

  async linkDependency(input: GraphDependencyInput): Promise<void> {
    validateScopeAndId(input.orgId, input.dependentId);
    validateScopeAndId(input.orgId, input.dependencyId);
    if (input.dependentId === input.dependencyId)
      throw new Error('A service cannot depend on itself');
    const criticality = input.criticality || 'degraded';
    await inTransaction(this.pool, input.orgId, async (client) => {
      await ensureService(client, input.orgId, input.dependentId);
      await ensureService(client, input.orgId, input.dependencyId);
      const result = await client.query<{ version: string | number }>(
        `INSERT INTO graph_catalog_dependencies(org_id,dependent_id,dependency_id,criticality)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(org_id,dependent_id,dependency_id) DO UPDATE SET
           criticality=EXCLUDED.criticality,
           version=graph_catalog_dependencies.version+1, updated_at=NOW()
         RETURNING version`,
        [input.orgId, input.dependentId, input.dependencyId, criticality]
      );
      await appendOutbox(client, {
        orgId: input.orgId,
        aggregateType: 'dependency',
        aggregateId: `${input.dependentId}->${input.dependencyId}`,
        aggregateVersion: Number(result.rows[0].version),
        eventType: 'dependency.link',
        payload: { dependentId: input.dependentId, dependencyId: input.dependencyId, criticality },
      });
    });
  }

  async linkIncidentToService(input: IncidentServiceLinkInput): Promise<void> {
    validateScopeAndId(input.orgId, input.incidentId);
    validateScopeAndId(input.orgId, input.serviceId);
    if (!input.title.trim()) throw new Error('Incident title is required');
    await inTransaction(this.pool, input.orgId, async (client) => {
      await ensureService(client, input.orgId, input.serviceId);
      const result = await client.query<{ version: string | number }>(
        `INSERT INTO graph_catalog_incident_services(org_id,incident_id,service_id,incident_title)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(org_id,incident_id,service_id) DO UPDATE SET
           incident_title=EXCLUDED.incident_title,
           version=graph_catalog_incident_services.version+1, updated_at=NOW()
         RETURNING version`,
        [input.orgId, input.incidentId, input.serviceId, input.title.trim()]
      );
      await appendOutbox(client, {
        orgId: input.orgId,
        aggregateType: 'incident-service',
        aggregateId: `${input.incidentId}->${input.serviceId}`,
        aggregateVersion: Number(result.rows[0].version),
        eventType: 'incident.service.link',
        payload: {
          incidentId: input.incidentId,
          title: input.title.trim(),
          serviceId: input.serviceId,
        },
      });
    });
  }

  /** At-least-once replay; graph operations must be idempotent MERGEs. */
  async replay(
    graph: GraphCatalogProjectionPort,
    orgId = this.defaultOrgId,
    limit = 50
  ): Promise<{ processed: number; failed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Outbox replay limit must be 1..500');
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      const event = await this.claim(orgId);
      if (!event) break;
      try {
        await project(graph, event);
        const completed = await queryForTenant(
          this.pool,
          orgId,
          'UPDATE graph_catalog_outbox SET processed_at=NOW(),lease_until=NULL,lease_token=NULL,last_error=NULL WHERE id=$1 AND org_id=$2 AND lease_token=$3 AND processed_at IS NULL',
          [event.id, orgId, event.lease_token]
        );
        if (completed.rowCount) processed++;
      } catch (error) {
        const released = await queryForTenant(this.pool, orgId,
          `UPDATE graph_catalog_outbox
           SET lease_until=NULL,
               lease_token=NULL,
               available_at=NOW()+LEAST(INTERVAL '5 minutes', INTERVAL '2 seconds' * POWER(2, LEAST(attempts,7))),
               last_error=$2
          WHERE id=$1 AND org_id=$3 AND lease_token=$4 AND processed_at IS NULL`,
          [event.id, error instanceof Error ? error.message.slice(0, 1000) : 'Projection failed', orgId, event.lease_token]
        );
        if (released.rowCount) failed++;
      }
    }
    return { processed, failed };
  }

  private async claim(orgId: string): Promise<ClaimedEvent | undefined> {
    return inTransaction(this.pool, orgId, async (client) => {
      const selected = await client.query<Omit<ClaimedEvent, 'lease_token'>>(
        `SELECT e.id,e.org_id,e.aggregate_type,e.aggregate_id,e.aggregate_version,e.event_type,e.payload
         FROM graph_catalog_outbox e
         WHERE e.org_id=$1 AND e.processed_at IS NULL AND e.available_at <= NOW()
           AND (e.lease_until IS NULL OR e.lease_until < NOW())
           AND NOT EXISTS (
             SELECT 1 FROM graph_catalog_outbox older
             WHERE older.org_id=e.org_id AND older.aggregate_type=e.aggregate_type
               AND older.aggregate_id=e.aggregate_id AND older.aggregate_version<e.aggregate_version
               AND older.processed_at IS NULL
           )
         ORDER BY e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`, [orgId]
      );
      const row = selected.rows[0];
      if (!row) return undefined;
      const leaseToken = randomUUID();
      await client.query(
        "UPDATE graph_catalog_outbox SET lease_until=NOW()+INTERVAL '60 seconds',lease_token=$3,attempts=attempts+1 WHERE id=$1 AND org_id=$2",
        [row.id, orgId, leaseToken]
      );
      return { ...row, lease_token: leaseToken };
    });
  }
}

interface ClaimedEvent {
  id: string;
  org_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string | number;
  event_type: string;
  payload: Record<string, unknown>;
  lease_token: string;
}

async function project(graph: GraphCatalogProjectionPort, event: ClaimedEvent): Promise<void> {
  const payload = event.payload;
  if (event.event_type === 'service.upsert') {
    await graph.upsertService({
      orgId: event.org_id,
      id: requiredString(payload.id),
      name: requiredString(payload.name),
      serviceType: optionalString(payload.serviceType),
      owner: optionalString(payload.owner),
        aggregateVersion: Number(event.aggregate_version),
    });
  } else if (event.event_type === 'dependency.link') {
    const criticality = payload.criticality;
    if (
      criticality !== undefined &&
      criticality !== 'critical' &&
      criticality !== 'degraded' &&
      criticality !== 'optional'
    ) {
      throw new Error('Invalid dependency criticality in outbox payload');
    }
    await graph.linkDependency({
      orgId: event.org_id,
      dependentId: requiredString(payload.dependentId),
      dependencyId: requiredString(payload.dependencyId),
      criticality,
      aggregateVersion: Number(event.aggregate_version),
    });
  } else if (event.event_type === 'incident.service.link') {
    await graph.linkIncidentToService({
      orgId: event.org_id,
      incidentId: requiredString(payload.incidentId),
      title: requiredString(payload.title),
      serviceId: requiredString(payload.serviceId),
      aggregateVersion: Number(event.aggregate_version),
    });
  } else {
    throw new Error(`Unknown graph catalog event type: ${event.event_type}`);
  }
}

async function ensureService(client: PoolClient, orgId: string, id: string): Promise<void> {
  await client.query(
    `INSERT INTO graph_catalog_services(org_id,id,name,service_type)
     VALUES($1,$2,$2,'service') ON CONFLICT(org_id,id) DO NOTHING`,
    [orgId, id]
  );
}

async function appendOutbox(
  client: PoolClient,
  input: {
    orgId: string;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    eventType: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO graph_catalog_outbox(org_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      input.orgId,
      input.aggregateType,
      input.aggregateId,
      input.aggregateVersion,
      input.eventType,
      JSON.stringify(input.payload),
    ]
  );
}

async function inTransaction<T>(
  pool: Pool,
  tenantId: string | undefined,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (tenantId) return transactionForTenant(pool, tenantId, callback);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function validateScopeAndId(orgId: string, id: string): void {
  if (!orgId.trim() || !id.trim())
    throw new Error('Organization and record identifiers are required');
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Invalid string in graph catalog outbox payload');
  return value;
}
function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new Error('Invalid optional string in graph catalog outbox payload');
  return value;
}
