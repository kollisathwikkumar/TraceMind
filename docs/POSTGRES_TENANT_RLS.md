# PostgreSQL tenant RLS

Tenant-owned records use PostgreSQL `ENABLE ROW LEVEL SECURITY` and
`FORCE ROW LEVEL SECURITY`. Policies compare `tenant_id` or `org_id` with the
transaction-local `app.tenant_id` setting. Tenant store operations acquire one
client, begin a transaction, set the context with `set_config(..., true)`, run
all statements on that client, and then commit/rollback. Do not use raw pool
queries against tenant tables.

## Separate migration and runtime credentials

The API runtime role must be a non-superuser with `NOBYPASSRLS`. Use a separate
table-owner/migration credential for schema DDL. Set:

```sh
TRACEMIND_DATABASE_URL='postgresql://tracemind_runtime:...@HOST/DB?sslmode=verify-full'
TRACEMIND_DATABASE_MIGRATION_URL='postgresql://tracemind_migrator:...@HOST/DB?sslmode=verify-full'
TRACEMIND_DATABASE_RUNTIME_ROLE='tracemind_runtime'
```

The migration process grants the runtime role schema usage, DML on migrated
tables, and sequence usage. `createPostgresStores` verifies the API connection
role matches the configured runtime role and rejects SUPERUSER/BYPASSRLS. The
migration role must own the existing application schema/tables or otherwise
have the DDL authority needed for migrations. Keep both credentials in the
deployment secret manager, not source control.

The legacy tenant mapper also requires `TRACEMIND_DATABASE_MIGRATION_URL`; it
rejects the runtime role and verifies that the migration role can bypass forced
RLS to inventory/reassign legacy rows. `--apply` additionally requires the
explicit mapping acknowledgement and database-name confirmation described by
the CLI. Use a reviewed, complete mapping and run its dry-run before apply.

The local `.env` used during development may contain an administrative
connection string for starting ephemeral integration fixtures; that identity
is not valid as the deployed runtime role. Integration coverage creates a
temporary `NOLOGIN NOSUPERUSER NOBYPASSRLS` role and drops it after each run.

## Tenant identity

The database GUC provides a database-enforced row filter, while the API must
derive the tenant value from its verified Auth0 organization context. It is not
a substitute for route authorization: an authenticated application role can
set the custom GUC, so never accept tenant IDs from an untrusted request body
or query parameter. Outbox workers replay one configured organization per
scoped pass; configure every authorized organization in the service settings.

Expired remediation leases are reconciled at startup and every 30 seconds for
each configured organization. An expired execution becomes `execution_unknown`,
an expired rollback becomes `rollback_unknown`, and a timed-out post-check
becomes `verification_unknown`; none are retried or treated as confirmed
failure. An operator with `remediations:reconcile` may resolve an unknown result
using `POST /api/v1/remediations/{plan}/steps/{step}/reconcile` with `operation`
(`execute`, `verify`, or `rollback`), `succeeded`, and nonempty evidence. The
tenant-scoped store allows only the matching unknown state and records actor,
outcome, and bounded evidence in the workflow audit log. Operators must check
the external broker using the persisted idempotency key and, for a successful
execution, perform an independent post-check before recording success.
Broker-side status lookup and automatic reconciliation remain unimplemented.

The pre-catalog `graph_projection_outbox` remains replayable for compatibility.
Its leases are fenced by a per-claim token. Catalog outbox events are ordered
by aggregate version, and FalkorDB service/relationship projections reject
older versions. Legacy events have no aggregate version, so they may initialize
unversioned graph state but are ignored once a canonical catalog version has
been projected.

## Covered tables

`incidents`, `incident_events`, `remediation_plans`, `remediation_steps`,
`remediation_events`, `evaluation_cases`, `graph_projection_outbox`,
`graph_catalog_services`, `graph_catalog_dependencies`,
`graph_catalog_incident_services`, `graph_catalog_outbox`,
`knowledge_documents`, `knowledge_chunks`, and
`knowledge_vector_embeddings`.
