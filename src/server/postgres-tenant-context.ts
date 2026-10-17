import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Run one statement under a transaction-local RLS tenant context. The GUC and
 * statement share the same checked-out client and cannot leak across pool use.
 */
export async function queryForTenant<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  tenantId: string,
  sql: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  return transactionForTenant(pool, tenantId, (client) => client.query<T>(sql, values));
}

/** Run an atomic operation after setting the transaction-local tenant GUC. */
export async function transactionForTenant<T>(
  pool: Pool,
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (typeof tenantId !== 'string' || !tenantId.trim())
    throw new Error('PostgreSQL tenant context must not be empty');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const value = await callback(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Grant ordinary DML access to the configured runtime role after DDL. */
export async function grantRuntimeTenantTables(
  client: PoolClient,
  runtimeRole: string | undefined,
  tables: readonly string[]
): Promise<void> {
  if (!runtimeRole) return;
  const schemaResult = await client.query<{ schema_name: string }>('SELECT current_schema() AS schema_name');
  const schemaName = schemaResult.rows[0]?.schema_name;
  if (!schemaName) throw new Error('Cannot resolve schema for PostgreSQL runtime grants');
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const role = quote(runtimeRole);
  const schema = quote(schemaName);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${tables.map((table) => `${schema}.${quote(table)}`).join(',')} TO ${role}`);
  await client.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
}
