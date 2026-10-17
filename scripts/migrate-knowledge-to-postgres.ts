import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateSqliteKnowledgeToPostgres } from '../src/knowledge/store/sqlite-to-postgres';

export async function runMigration(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options.help) {
    console.log(
      'Usage: npm run knowledge:migrate-postgres -- [--source .runbook/knowledge.db] [--vectors .runbook/vectors.db] [--tenant ORG_ID] [--apply]'
    );
  console.log(
      'Without --apply this prints counts only. Set TRACEMIND_DATABASE_URL before applying; optionally set TRACEMIND_DATABASE_MIGRATION_URL for schema DDL.'
    );
    return;
  }
  if (!existsSync(options.source))
    throw new Error(`Source SQLite database does not exist: ${options.source}`);
  const tenantId = options.tenant || process.env.TRACEMIND_ORG_ID || 'default';
  const connectionString = process.env.TRACEMIND_DATABASE_URL || process.env.RUNBOOK_DATABASE_URL;
  if (options.apply && !connectionString) {
    throw new Error(
      'Set TRACEMIND_DATABASE_URL or RUNBOOK_DATABASE_URL before applying the migration.'
    );
  }
  const pool = options.apply ? new Pool({ connectionString }) : undefined;
  const migrationPool = options.apply
    ? new Pool({ connectionString: process.env.TRACEMIND_DATABASE_MIGRATION_URL || connectionString })
    : undefined;
  try {
    const result = await migrateSqliteKnowledgeToPostgres(
      resolve(options.source),
      pool,
      tenantId,
      options.apply,
      resolve(options.vectors),
      migrationPool,
      options.apply
        ? process.env.TRACEMIND_DATABASE_RUNTIME_ROLE || decodeURIComponent(new URL(connectionString!).username)
        : undefined
    );
    console.log(JSON.stringify({ source: resolve(options.source), tenantId, ...result }, null, 2));
  } finally {
    await pool?.end();
    if (migrationPool !== pool) await migrationPool?.end();
  }
}

function parseArgs(args: string[]): {
  source: string;
  vectors: string;
  tenant?: string;
  apply: boolean;
  help: boolean;
} {
  const parsed = {
    source: '.runbook/knowledge.db',
    vectors: '.runbook/vectors.db',
    tenant: undefined as string | undefined,
    apply: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source') parsed.source = args[++i] || '';
    else if (args[i] === '--vectors') parsed.vectors = args[++i] || '';
    else if (args[i] === '--tenant') parsed.tenant = args[++i] || '';
    else if (args[i] === '--apply') parsed.apply = true;
    else if (args[i] === '--help' || args[i] === '-h') parsed.help = true;
    else throw new Error(`Unknown migration option: ${args[i]}`);
  }
  if (!parsed.source.trim()) throw new Error('--source must name a SQLite database file.');
  if (!parsed.vectors.trim()) throw new Error('--vectors must name a SQLite database file.');
  if (parsed.tenant !== undefined && !parsed.tenant.trim())
    throw new Error('--tenant cannot be empty.');
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMigration().catch((error: unknown) => {
    console.error(
      'Knowledge migration failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    process.exitCode = 1;
  });
}
