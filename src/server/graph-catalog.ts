import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import {
  grantRuntimeTenantTables,
  queryForTenant,
  transactionForTenant,
} from './postgres-tenant-context';

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
    }
  | {
      type: 'service.delete';
      orgId: string;
      data: { id: string };
      aggregateId: string;
      aggregateVersion: number;
    }
  | {
      type: 'dependency.unlink';
      orgId: string;
      data: { dependentId: string; dependencyId: string };
      aggregateId: string;
      aggregateVersion: number;
    }
  | {
      type: 'incident.service.unlink';
      orgId: string;
      data: { incidentId: string; serviceId: string };
      aggregateId: string;
      aggregateVersion: number;
    };

export interface GraphCatalogProjectionPort {
  upsertService(input: GraphServiceInput): Promise<void>;
  linkDependency(input: GraphDependencyInput): Promise<void>;
  linkIncidentToService(input: IncidentServiceLinkInput): Promise<void>;
  deleteService?(input: { orgId: string; id: string; aggregateVersion?: number }): Promise<void>;
  unlinkDependency?(input: {
    orgId: string;
    dependentId: string;
    dependencyId: string;
    aggregateVersion?: number;
  }): Promise<void>;
  unlinkIncidentFromService?(input: {
    orgId: string;
    incidentId: string;
    serviceId: string;
    aggregateVersion?: number;
  }): Promise<void>;
  deleteOrganization?(orgId: string): Promise<void>;
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
      'graph_catalog_schema_migrations',
      'graph_catalog_services',
      'graph_catalog_dependencies',
      'graph_catalog_incident_services',
      'graph_catalog_outbox',
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
      CREATE INDEX IF NOT EXISTS graph_catalog_outbox_service_identity
        ON graph_catalog_outbox(org_id, (payload->>'id'), aggregate_version DESC)
        WHERE aggregate_type='service';
      CREATE INDEX IF NOT EXISTS graph_catalog_outbox_dependency_identity
        ON graph_catalog_outbox(org_id, (payload->>'dependentId'), (payload->>'dependencyId'), aggregate_version DESC)
        WHERE aggregate_type='dependency';
      CREATE INDEX IF NOT EXISTS graph_catalog_outbox_incident_service_identity
        ON graph_catalog_outbox(org_id, (payload->>'incidentId'), (payload->>'serviceId'), aggregate_version DESC)
        WHERE aggregate_type='incident-service';
    `);
    await client.query(
      'ALTER TABLE graph_catalog_outbox ADD COLUMN IF NOT EXISTS lease_token TEXT'
    );
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
  constructor(
    private readonly pool: Pool,
    private readonly defaultOrgId = 'default'
  ) {}

  async checkHealth(orgId = this.defaultOrgId): Promise<number> {
    const result = await queryForTenant<{ pending: string | number }>(
      this.pool,
      orgId,
      'SELECT count(*) AS pending FROM graph_catalog_outbox WHERE processed_at IS NULL'
    );
    return Number(result.rows[0]?.pending || 0);
  }

  async upsertService(input: GraphServiceInput): Promise<void> {
    validateScopeAndId(input.orgId, input.id);
    if (!input.name.trim()) throw new Error('Service name is required');
    await inTransaction(this.pool, input.orgId, async (client) => {
      await lockCatalogWrite(client, input.orgId);
      await client.query(
        `INSERT INTO graph_catalog_services(org_id,id,name,service_type,owner)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(org_id,id) DO UPDATE SET
           name=EXCLUDED.name, service_type=EXCLUDED.service_type,
           owner=EXCLUDED.owner, version=graph_catalog_services.version+1,
           updated_at=NOW()
         `,
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
        aggregateVersion: await nextAggregateVersion(client, input.orgId, 'service', [input.id]),
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
      await lockCatalogWrite(client, input.orgId);
      await ensureService(client, input.orgId, input.dependentId);
      await ensureService(client, input.orgId, input.dependencyId);
      await client.query(
        `INSERT INTO graph_catalog_dependencies(org_id,dependent_id,dependency_id,criticality)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(org_id,dependent_id,dependency_id) DO UPDATE SET
           criticality=EXCLUDED.criticality,
           version=graph_catalog_dependencies.version+1, updated_at=NOW()
         `,
        [input.orgId, input.dependentId, input.dependencyId, criticality]
      );
      await appendOutbox(client, {
        orgId: input.orgId,
        aggregateType: 'dependency',
        aggregateId: encodeAggregateTuple(input.dependentId, input.dependencyId),
        aggregateVersion: await nextAggregateVersion(client, input.orgId, 'dependency', [
          input.dependentId,
          input.dependencyId,
        ]),
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
      await lockCatalogWrite(client, input.orgId);
      await ensureService(client, input.orgId, input.serviceId);
      await client.query(
        `INSERT INTO graph_catalog_incident_services(org_id,incident_id,service_id,incident_title)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(org_id,incident_id,service_id) DO UPDATE SET
           incident_title=EXCLUDED.incident_title,
           version=graph_catalog_incident_services.version+1, updated_at=NOW()
         `,
        [input.orgId, input.incidentId, input.serviceId, input.title.trim()]
      );
      await appendOutbox(client, {
        orgId: input.orgId,
        aggregateType: 'incident-service',
        aggregateId: encodeAggregateTuple(input.incidentId, input.serviceId),
        aggregateVersion: await nextAggregateVersion(client, input.orgId, 'incident-service', [
          input.incidentId,
          input.serviceId,
        ]),
        eventType: 'incident.service.link',
        payload: {
          incidentId: input.incidentId,
          title: input.title.trim(),
          serviceId: input.serviceId,
        },
      });
    });
  }

  /** Atomically records a set of incident/service links and their outbox events. */
  async linkIncidentToServices(
    input: Omit<IncidentServiceLinkInput, 'serviceId'> & { serviceIds: string[] }
  ): Promise<void> {
    validateScopeAndId(input.orgId, input.incidentId);
    if (!input.title.trim()) throw new Error('Incident title is required');
    const serviceIds = [...new Set(input.serviceIds.map((id) => id.trim()))].sort();
    if (serviceIds.length < 1 || serviceIds.some((id) => !id))
      throw new Error('At least one valid service ID is required');
    await inTransaction(this.pool, input.orgId, async (client) => {
      await lockCatalogWrite(client, input.orgId);
      for (const serviceId of serviceIds) {
        validateScopeAndId(input.orgId, serviceId);
        await ensureService(client, input.orgId, serviceId);
        await upsertIncidentService(client, {
          orgId: input.orgId,
          incidentId: input.incidentId,
          title: input.title,
          serviceId,
        });
      }
    });
  }

  async unlinkDependency(input: GraphDependencyInput): Promise<boolean> {
    validateScopeAndId(input.orgId, input.dependentId);
    validateScopeAndId(input.orgId, input.dependencyId);
    const aggregateId = encodeAggregateTuple(input.dependentId, input.dependencyId);
    return inTransaction(this.pool, input.orgId, async (client) => {
      await lockCatalogWrite(client, input.orgId);
      const deleted = await client.query(
        `DELETE FROM graph_catalog_dependencies
         WHERE org_id=$1 AND dependent_id=$2 AND dependency_id=$3`,
        [input.orgId, input.dependentId, input.dependencyId]
      );
      if (!deleted.rowCount) return false;
      await appendOutbox(client, {
        orgId: input.orgId,
        aggregateType: 'dependency',
        aggregateId,
        aggregateVersion: await nextAggregateVersion(client, input.orgId, 'dependency', [
          input.dependentId,
          input.dependencyId,
        ]),
        eventType: 'dependency.unlink',
        payload: { dependentId: input.dependentId, dependencyId: input.dependencyId },
      });
      return true;
    });
  }

  async unlinkIncidentFromService(input: IncidentServiceLinkInput): Promise<boolean> {
    validateScopeAndId(input.orgId, input.incidentId);
    validateScopeAndId(input.orgId, input.serviceId);
    const aggregateId = encodeAggregateTuple(input.incidentId, input.serviceId);
    return inTransaction(this.pool, input.orgId, async (client) => {
      await lockCatalogWrite(client, input.orgId);
      const deleted = await client.query(
        `DELETE FROM graph_catalog_incident_services
         WHERE org_id=$1 AND incident_id=$2 AND service_id=$3`,
        [input.orgId, input.incidentId, input.serviceId]
      );
      if (!deleted.rowCount) return false;
      await appendOutbox(client, {
        orgId: input.orgId,
        aggregateType: 'incident-service',
        aggregateId,
        aggregateVersion: await nextAggregateVersion(client, input.orgId, 'incident-service', [
          input.incidentId,
          input.serviceId,
        ]),
        eventType: 'incident.service.unlink',
        payload: { incidentId: input.incidentId, serviceId: input.serviceId },
      });
      return true;
    });
  }

  /** Deletes a service and all cataloged edges in one transaction. */
  async deleteService(orgId: string, id: string): Promise<boolean> {
    validateScopeAndId(orgId, id);
    return inTransaction(this.pool, orgId, async (client) => {
      await lockCatalogWrite(client, orgId);
      const service = await client.query(
        'SELECT id FROM graph_catalog_services WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [orgId, id]
      );
      if (!service.rowCount) return false;

      const dependencies = await client.query<{ dependent_id: string; dependency_id: string }>(
        `SELECT dependent_id,dependency_id FROM graph_catalog_dependencies
         WHERE org_id=$1 AND (dependent_id=$2 OR dependency_id=$2)
         ORDER BY dependent_id,dependency_id FOR UPDATE`,
        [orgId, id]
      );
      for (const edge of dependencies.rows) {
        const aggregateId = encodeAggregateTuple(edge.dependent_id, edge.dependency_id);
        await client.query(
          'DELETE FROM graph_catalog_dependencies WHERE org_id=$1 AND dependent_id=$2 AND dependency_id=$3',
          [orgId, edge.dependent_id, edge.dependency_id]
        );
        await appendOutbox(client, {
          orgId,
          aggregateType: 'dependency',
          aggregateId,
          aggregateVersion: await nextAggregateVersion(client, orgId, 'dependency', [
            edge.dependent_id,
            edge.dependency_id,
          ]),
          eventType: 'dependency.unlink',
          payload: { dependentId: edge.dependent_id, dependencyId: edge.dependency_id },
        });
      }

      const incidentLinks = await client.query<{ incident_id: string; service_id: string }>(
        'SELECT incident_id,service_id FROM graph_catalog_incident_services WHERE org_id=$1 AND service_id=$2 ORDER BY incident_id FOR UPDATE',
        [orgId, id]
      );
      for (const link of incidentLinks.rows) {
        const aggregateId = encodeAggregateTuple(link.incident_id, link.service_id);
        await client.query(
          'DELETE FROM graph_catalog_incident_services WHERE org_id=$1 AND incident_id=$2 AND service_id=$3',
          [orgId, link.incident_id, link.service_id]
        );
        await appendOutbox(client, {
          orgId,
          aggregateType: 'incident-service',
          aggregateId,
          aggregateVersion: await nextAggregateVersion(client, orgId, 'incident-service', [
            link.incident_id,
            link.service_id,
          ]),
          eventType: 'incident.service.unlink',
          payload: { incidentId: link.incident_id, serviceId: link.service_id },
        });
      }

      await client.query('DELETE FROM graph_catalog_services WHERE org_id=$1 AND id=$2', [
        orgId,
        id,
      ]);
      await appendOutbox(client, {
        orgId,
        aggregateType: 'service',
        aggregateId: id,
        aggregateVersion: await nextAggregateVersion(client, orgId, 'service', [id]),
        eventType: 'service.delete',
        payload: { id },
      });
      return true;
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
    return withProjectionLock(this.pool, orgId, false, async () => {
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
          const released = await queryForTenant(
            this.pool,
            orgId,
            `UPDATE graph_catalog_outbox
             SET lease_until=NULL,
                 lease_token=NULL,
                 available_at=NOW()+LEAST(INTERVAL '5 minutes', INTERVAL '2 seconds' * POWER(2, LEAST(attempts,7))),
                 last_error=$2
            WHERE id=$1 AND org_id=$3 AND lease_token=$4 AND processed_at IS NULL`,
            [
              event.id,
              error instanceof Error ? error.message.slice(0, 1000) : 'Projection failed',
              orgId,
              event.lease_token,
            ]
          );
          if (released.rowCount) failed++;
        }
      }
      return { processed, failed };
    });
  }

  /** Rebuilds only one tenant's projection from the authoritative catalog. */
  async reconcile(
    graph: GraphCatalogProjectionPort,
    orgId = this.defaultOrgId,
    limit = 1000
  ): Promise<{ services: number; dependencies: number; incidentLinks: number }> {
    validateScopeAndId(orgId, 'reconcile');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Graph reconciliation limit must be 1..1000');
    if (!graph.deleteOrganization) throw new Error('Graph projector does not support tenant reset');
    const deleteOrganization = graph.deleteOrganization.bind(graph);
    return withProjectionLock(this.pool, orgId, true, async () => {
      const snapshot = await inTransaction(this.pool, orgId, async (client) => {
        const services = await client.query<{
          id: string;
          name: string;
          service_type: string;
          owner: string;
          catalog_version: number | null;
        }>(
          `SELECT s.id,s.name,s.service_type,s.owner,
             (SELECT max(e.aggregate_version) FROM graph_catalog_outbox e
              WHERE e.org_id=s.org_id AND e.aggregate_type='service' AND e.payload->>'id'=s.id) AS catalog_version
           FROM graph_catalog_services s WHERE s.org_id=$1 ORDER BY s.id LIMIT $2`,
          [orgId, limit + 1]
        );
        const dependencies = await client.query<{
          dependent_id: string;
          dependency_id: string;
          criticality: GraphDependencyInput['criticality'];
          catalog_version: number | null;
        }>(
          `SELECT d.dependent_id,d.dependency_id,d.criticality,
             (SELECT max(e.aggregate_version) FROM graph_catalog_outbox e
              WHERE e.org_id=d.org_id AND e.aggregate_type='dependency'
                AND e.payload->>'dependentId'=d.dependent_id AND e.payload->>'dependencyId'=d.dependency_id) AS catalog_version
           FROM graph_catalog_dependencies d WHERE d.org_id=$1 ORDER BY d.dependent_id,d.dependency_id LIMIT $2`,
          [orgId, limit + 1]
        );
        const incidentLinks = await client.query<{
          incident_id: string;
          incident_title: string;
          service_id: string;
          catalog_version: number | null;
        }>(
          `SELECT l.incident_id,l.incident_title,l.service_id,
             (SELECT max(e.aggregate_version) FROM graph_catalog_outbox e
              WHERE e.org_id=l.org_id AND e.aggregate_type='incident-service'
                AND e.payload->>'incidentId'=l.incident_id AND e.payload->>'serviceId'=l.service_id) AS catalog_version
           FROM graph_catalog_incident_services l WHERE l.org_id=$1 ORDER BY l.incident_id,l.service_id LIMIT $2`,
          [orgId, limit + 1]
        );
        const total = services.rows.length + dependencies.rows.length + incidentLinks.rows.length;
        if (total > limit)
          throw new Error(`Graph reconciliation exceeds the ${limit} record limit`);
        return {
          services: services.rows,
          dependencies: dependencies.rows,
          incidentLinks: incidentLinks.rows,
        };
      });

      await deleteOrganization(orgId);
      for (const service of snapshot.services)
        await graph.upsertService({
          orgId,
          id: service.id,
          name: service.name,
          serviceType: service.service_type,
          owner: service.owner,
          aggregateVersion: service.catalog_version ?? undefined,
        });
      for (const edge of snapshot.dependencies)
        await graph.linkDependency({
          orgId,
          dependentId: edge.dependent_id,
          dependencyId: edge.dependency_id,
          criticality: edge.criticality || 'degraded',
          aggregateVersion: edge.catalog_version ?? undefined,
        });
      for (const link of snapshot.incidentLinks)
        await graph.linkIncidentToService({
          orgId,
          incidentId: link.incident_id,
          title: link.incident_title,
          serviceId: link.service_id,
          aggregateVersion: link.catalog_version ?? undefined,
        });
      return {
        services: snapshot.services.length,
        dependencies: snapshot.dependencies.length,
        incidentLinks: snapshot.incidentLinks.length,
      };
    });
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
               AND older.aggregate_version<e.aggregate_version
               AND older.processed_at IS NULL
               -- Compare the aggregate's structured identity, not its historical delimiter key.
               -- This also preserves order across rows written before tuple IDs were introduced.
               AND (
                 (e.aggregate_type='service' AND older.payload->>'id'=e.payload->>'id')
                 OR (e.aggregate_type='dependency'
                   AND older.payload->>'dependentId'=e.payload->>'dependentId'
                   AND older.payload->>'dependencyId'=e.payload->>'dependencyId')
                 OR (e.aggregate_type='incident-service'
                   AND older.payload->>'incidentId'=e.payload->>'incidentId'
                   AND older.payload->>'serviceId'=e.payload->>'serviceId')
               )
           )
         ORDER BY e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`,
        [orgId]
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
  } else if (event.event_type === 'service.delete') {
    if (!graph.deleteService) throw new Error('Graph projector does not support service deletion');
    await graph.deleteService({
      orgId: event.org_id,
      id: requiredString(payload.id),
      aggregateVersion: Number(event.aggregate_version),
    });
  } else if (event.event_type === 'dependency.unlink') {
    if (!graph.unlinkDependency)
      throw new Error('Graph projector does not support dependency unlink');
    await graph.unlinkDependency({
      orgId: event.org_id,
      dependentId: requiredString(payload.dependentId),
      dependencyId: requiredString(payload.dependencyId),
      aggregateVersion: Number(event.aggregate_version),
    });
  } else if (event.event_type === 'incident.service.unlink') {
    if (!graph.unlinkIncidentFromService)
      throw new Error('Graph projector does not support incident unlink');
    await graph.unlinkIncidentFromService({
      orgId: event.org_id,
      incidentId: requiredString(payload.incidentId),
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

async function upsertIncidentService(
  client: PoolClient,
  input: IncidentServiceLinkInput
): Promise<void> {
  const aggregateId = encodeAggregateTuple(input.incidentId, input.serviceId);
  await client.query(
    `INSERT INTO graph_catalog_incident_services(org_id,incident_id,service_id,incident_title)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(org_id,incident_id,service_id) DO UPDATE SET
       incident_title=EXCLUDED.incident_title,
       version=graph_catalog_incident_services.version+1, updated_at=NOW()`,
    [input.orgId, input.incidentId, input.serviceId, input.title.trim()]
  );
  await appendOutbox(client, {
    orgId: input.orgId,
    aggregateType: 'incident-service',
    aggregateId,
    aggregateVersion: await nextAggregateVersion(client, input.orgId, 'incident-service', [
      input.incidentId,
      input.serviceId,
    ]),
    eventType: 'incident.service.link',
    payload: {
      incidentId: input.incidentId,
      title: input.title.trim(),
      serviceId: input.serviceId,
    },
  });
}

async function nextAggregateVersion(
  client: PoolClient,
  orgId: string,
  aggregateType: string,
  identity: string[]
): Promise<number> {
  // Use structured payload identity, not aggregate_id: older outbox rows used
  // delimiter IDs while newer rows use tuple-v1, but both represent one aggregate.
  const key = JSON.stringify([orgId, aggregateType, ...identity]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  let identityPredicate: string;
  if (aggregateType === 'service' && identity.length === 1) {
    identityPredicate = "payload->>'id'=$3";
  } else if (aggregateType === 'dependency' && identity.length === 2) {
    identityPredicate = "payload->>'dependentId'=$3 AND payload->>'dependencyId'=$4";
  } else if (aggregateType === 'incident-service' && identity.length === 2) {
    identityPredicate = "payload->>'incidentId'=$3 AND payload->>'serviceId'=$4";
  } else {
    throw new Error('Unsupported graph aggregate identity');
  }
  const result = await client.query<{ version: string | number | null }>(
    `SELECT max(aggregate_version) AS version FROM graph_catalog_outbox
     WHERE org_id=$1 AND aggregate_type=$2 AND ${identityPredicate}`,
    [orgId, aggregateType, ...identity]
  );
  return Number(result.rows[0]?.version || 0) + 1;
}

async function lockCatalogWrite(client: PoolClient, orgId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `tracemind-graph-projection:${orgId}`,
  ]);
}

async function withProjectionLock<T>(
  pool: Pool,
  orgId: string,
  exclusive: boolean,
  callback: () => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const key = `tracemind-graph-projection:${orgId}`;
  const lock = exclusive ? 'pg_advisory_lock' : 'pg_advisory_lock_shared';
  const unlock = exclusive ? 'pg_advisory_unlock' : 'pg_advisory_unlock_shared';
  try {
    await client.query(`SELECT ${lock}(hashtextextended($1,0))`, [key]);
    return await callback();
  } finally {
    try {
      await client.query(`SELECT ${unlock}(hashtextextended($1,0))`, [key]);
    } finally {
      client.release();
    }
  }
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

/**
 * Encodes a tuple without delimiter ambiguity. JSON arrays preserve tuple
 * boundaries, and base64url makes the result safe as a compact SQL key.
 */
function encodeAggregateTuple(...parts: string[]): string {
  return `tuple-v1:${Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url')}`;
}
