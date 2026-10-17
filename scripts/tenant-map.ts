import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Pool } from 'pg';
import {
  applyLegacyTenantMapping,
  inventoryLegacyTenants,
  type LegacyTenantMapping,
} from '../src/server/tenant-mapping';

async function main(): Promise<void> {
  const [mode, mappingPath] = process.argv.slice(2);
  if (!['--dry-run', '--apply'].includes(mode ?? '') || !mappingPath) {
    throw new Error(
      'Usage: npm run db:tenant-map -- --dry-run <mapping.json> | --apply <mapping.json>'
    );
  }
  const connectionString = process.env.TRACEMIND_DATABASE_MIGRATION_URL;
  if (!connectionString)
    throw new Error('Set TRACEMIND_DATABASE_MIGRATION_URL to the intended database using the migration role');
  const mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as LegacyTenantMapping;
  const pool = new Pool({ connectionString, max: 1, application_name: 'tracemind-tenant-map' });
  try {
    const roleResult = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user'
    );
    const role = roleResult.rows[0];
    if (!role || (!role.rolsuper && !role.rolbypassrls)) {
      throw new Error('Tenant mapping requires a privileged migration role that can inspect and reassign FORCE-RLS rows');
    }
    const runtimeUrl = process.env.TRACEMIND_DATABASE_URL ?? process.env.RUNBOOK_DATABASE_URL;
    if (runtimeUrl && new URL(runtimeUrl).username === new URL(connectionString).username) {
      throw new Error('Tenant mapping migration role must be distinct from the runtime application role');
    }
    if (mode === '--dry-run') {
      const inventory = await inventoryLegacyTenants(pool);
      process.stdout.write(
        `${JSON.stringify({ mode: 'dry-run', mappingFile: basename(mappingPath), inventory }, null, 2)}\n`
      );
      process.stdout.write(
        'No data was changed. Review aggregate inventory and obtain an approved complete mapping before --apply.\n'
      );
      return;
    }
    if (process.env.TRACEMIND_TENANT_REMAP_ALLOW !== 'I_HAVE_REVIEWED_THE_MAPPING') {
      throw new Error('Apply requires TRACEMIND_TENANT_REMAP_ALLOW=I_HAVE_REVIEWED_THE_MAPPING');
    }
    const dbName = new URL(connectionString).pathname.replace(/^\//, '');
    if (!dbName || process.env.TRACEMIND_TENANT_REMAP_CONFIRM !== dbName) {
      throw new Error(
        `Apply requires TRACEMIND_TENANT_REMAP_CONFIRM=${dbName || '<database-name>'}`
      );
    }
    const inventory = await applyLegacyTenantMapping(pool, mapping);
    process.stdout.write(
      `${JSON.stringify({ mode: 'apply', mappingFile: basename(mappingPath), inventory }, null, 2)}\n`
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
