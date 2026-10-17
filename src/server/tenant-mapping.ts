import type { Pool, PoolClient } from 'pg';

export type LegacyTenantMapping = {
  /** Explicit mapping for each legacy incident currently assigned to tenant `default`. */
  incidents: Record<string, string>;
  /** Evaluations have no incident parent, so every legacy case must be mapped explicitly. */
  evaluationCases: Array<{ dataset: string; caseId: string; tenantId: string }>;
};

type CountRow = { tenant_id: string; row_count: string };
export type TenantInventory = Record<string, Array<{ tenantId: string; count: number }>>;

const TABLES = [
  'incidents',
  'incident_events',
  'remediation_plans',
  'remediation_steps',
  'remediation_events',
  'evaluation_cases',
] as const;

/** Return aggregate counts only; this deliberately never selects record contents or identifiers. */
export async function inventoryLegacyTenants(pool: Pool): Promise<TenantInventory> {
  const inventory: TenantInventory = {};
  for (const table of TABLES) {
    const { rows } = await pool.query<CountRow>(
      `SELECT tenant_id, COUNT(*)::text AS row_count FROM ${table} GROUP BY tenant_id ORDER BY tenant_id`
    );
    inventory[table] = rows.map((row) => ({
      tenantId: row.tenant_id,
      count: Number(row.row_count),
    }));
  }
  return inventory;
}

/** Reassign legacy `default` rows only from a caller-supplied, reviewed mapping. */
export async function applyLegacyTenantMapping(
  pool: Pool,
  mapping: LegacyTenantMapping
): Promise<TenantInventory> {
  validateMappingShape(mapping);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [905142]);
    // Prevent writes from racing the inventory, mapping validation, and re-parenting operation.
    await client.query(
      `LOCK TABLE incidents, incident_events, remediation_plans, remediation_steps, remediation_events, evaluation_cases IN SHARE ROW EXCLUSIVE MODE`
    );
    await validateCompleteMappings(client, mapping);

    // Tenant reassignment updates both sides of composite tenant FKs in one transaction.
    // Making these constraints deferred is persistent and safe: they still enforce consistency
    // at commit, while allowing parent/child rows to change tenant atomically.
    await client.query(`
      ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_events_tenant_fk;
      ALTER TABLE remediation_plans DROP CONSTRAINT IF EXISTS remediation_plans_tenant_incident_fk;
      ALTER TABLE remediation_steps DROP CONSTRAINT IF EXISTS remediation_steps_tenant_plan_fk;
      ALTER TABLE remediation_events DROP CONSTRAINT IF EXISTS remediation_events_tenant_plan_fk;
      ALTER TABLE incident_events ADD CONSTRAINT incident_events_tenant_fk
        FOREIGN KEY(tenant_id,incident_id) REFERENCES incidents(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE remediation_plans ADD CONSTRAINT remediation_plans_tenant_incident_fk
        FOREIGN KEY(tenant_id,incident_id) REFERENCES incidents(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE remediation_steps ADD CONSTRAINT remediation_steps_tenant_plan_fk
        FOREIGN KEY(tenant_id,plan_id) REFERENCES remediation_plans(tenant_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE remediation_events ADD CONSTRAINT remediation_events_tenant_plan_fk
        FOREIGN KEY(tenant_id,plan_id) REFERENCES remediation_plans(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
      SET CONSTRAINTS incident_events_tenant_fk, remediation_plans_tenant_incident_fk,
        remediation_steps_tenant_plan_fk, remediation_events_tenant_plan_fk DEFERRED;
    `);

    await client.query(
      'CREATE TEMP TABLE tenant_map_incidents(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL) ON COMMIT DROP'
    );
    await client.query(
      'CREATE TEMP TABLE tenant_map_evaluations(dataset TEXT NOT NULL, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY(dataset,case_id)) ON COMMIT DROP'
    );
    const incidentPairs = Object.entries(mapping.incidents);
    if (incidentPairs.length) {
      const values = incidentPairs
        .map((_, i) => `($${2 * i + 1}::text,$${2 * i + 2}::text)`)
        .join(',');
      await client.query(
        `INSERT INTO tenant_map_incidents VALUES ${values}`,
        incidentPairs.flatMap(([id, tenant]) => [id, tenant])
      );
    }
    if (mapping.evaluationCases.length) {
      const values = mapping.evaluationCases
        .map((_, i) => `($${3 * i + 1}::text,$${3 * i + 2}::text,$${3 * i + 3}::text)`)
        .join(',');
      await client.query(
        `INSERT INTO tenant_map_evaluations VALUES ${values}`,
        mapping.evaluationCases.flatMap(({ dataset, caseId, tenantId }) => [
          dataset,
          caseId,
          tenantId,
        ])
      );
    }

    await client.query(
      `UPDATE incident_events e SET tenant_id=m.tenant_id FROM tenant_map_incidents m WHERE e.incident_id=m.id AND e.tenant_id='default'`
    );
    await client.query(
      `UPDATE remediation_plans p SET tenant_id=m.tenant_id FROM tenant_map_incidents m WHERE p.incident_id=m.id AND p.tenant_id='default'`
    );
    await client.query(
      `UPDATE remediation_steps s SET tenant_id=p.tenant_id FROM remediation_plans p WHERE s.plan_id=p.id AND s.tenant_id='default'`
    );
    await client.query(
      `UPDATE remediation_events e SET tenant_id=p.tenant_id FROM remediation_plans p WHERE e.plan_id=p.id AND e.tenant_id='default'`
    );
    await client.query(
      `UPDATE incidents i SET tenant_id=m.tenant_id FROM tenant_map_incidents m WHERE i.id=m.id AND i.tenant_id='default'`
    );
    await client.query(
      `UPDATE evaluation_cases e SET tenant_id=m.tenant_id FROM tenant_map_evaluations m WHERE e.dataset=m.dataset AND e.case_id=m.case_id AND e.tenant_id='default'`
    );

    const remaining = await inventoryWithClient(client);
    const defaultCounts = Object.entries(remaining).flatMap(([table, entries]) =>
      entries
        .filter((entry) => entry.tenantId === 'default' && entry.count > 0)
        .map((entry) => `${table}:${entry.count}`)
    );
    if (defaultCounts.length)
      throw new Error(
        `Tenant mapping incomplete; legacy default rows remain (${defaultCounts.join(', ')})`
      );
    await client.query('COMMIT');
    return remaining;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function validateCompleteMappings(
  client: PoolClient,
  mapping: LegacyTenantMapping
): Promise<void> {
  const incidentIds = Object.keys(mapping.incidents);
  const listedIncidents = await client.query<{ id: string; tenant_id: string }>(
    `SELECT id,tenant_id FROM incidents WHERE tenant_id='default' OR id=ANY($1::text[])`,
    [incidentIds]
  );
  const expectedIds = new Set(
    listedIncidents.rows.filter((row) => row.tenant_id === 'default').map((row) => row.id)
  );
  for (const id of incidentIds)
    if (!expectedIds.has(id))
      throw new Error(`Incident mapping references unknown or non-default record: ${id}`);
  for (const id of expectedIds)
    if (!Object.hasOwn(mapping.incidents, id))
      throw new Error(`Missing explicit tenant mapping for legacy incident: ${id}`);

  const cases = await client.query<{ dataset: string; case_id: string; tenant_id: string }>(
    `SELECT dataset,case_id,tenant_id FROM evaluation_cases WHERE tenant_id='default'`
  );
  const mappingKeys = new Set(
    mapping.evaluationCases.map((row) => `${row.dataset}\0${row.caseId}`)
  );
  for (const row of cases.rows) {
    const key = `${row.dataset}\0${row.case_id}`;
    if (!mappingKeys.has(key))
      throw new Error(
        `Missing explicit tenant mapping for legacy evaluation case: ${row.dataset}/${row.case_id}`
      );
  }
  if (mappingKeys.size !== cases.rows.length)
    throw new Error('Evaluation mapping contains unknown, duplicate, or non-default cases');
}

function validateMappingShape(mapping: LegacyTenantMapping): void {
  if (
    !mapping ||
    typeof mapping !== 'object' ||
    !mapping.incidents ||
    !Array.isArray(mapping.evaluationCases)
  ) {
    throw new Error('Mapping must contain incidents object and evaluationCases array');
  }
  for (const [id, tenant] of Object.entries(mapping.incidents)) {
    if (!id.trim() || !tenant.trim() || tenant === 'default')
      throw new Error('Every incident mapping needs a non-empty target tenant other than default');
  }
  const seen = new Set<string>();
  for (const row of mapping.evaluationCases) {
    if (
      !row.dataset?.trim() ||
      !row.caseId?.trim() ||
      !row.tenantId?.trim() ||
      row.tenantId === 'default'
    )
      throw new Error(
        'Every evaluation mapping needs dataset, caseId, and a target tenant other than default'
      );
    const key = `${row.dataset}\0${row.caseId}`;
    if (seen.has(key))
      throw new Error(`Duplicate evaluation mapping: ${row.dataset}/${row.caseId}`);
    seen.add(key);
  }
}

async function inventoryWithClient(client: PoolClient): Promise<TenantInventory> {
  const inventory: TenantInventory = {};
  for (const table of TABLES) {
    const { rows } = await client.query<CountRow>(
      `SELECT tenant_id, COUNT(*)::text AS row_count FROM ${table} GROUP BY tenant_id ORDER BY tenant_id`
    );
    inventory[table] = rows.map((row) => ({
      tenantId: row.tenant_id,
      count: Number(row.row_count),
    }));
  }
  return inventory;
}
