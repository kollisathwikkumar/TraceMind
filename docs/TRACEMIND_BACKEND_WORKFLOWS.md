# TraceMind backend workflows

The TraceMind server exposes backend contracts for TraceMind's incident-to-verification loop. Every route below requires the configured bearer API key. FalkorDB stores the service/dependency/incident graph; the relational adapter stores incidents, audit events, remediation plans/results, and evaluation cases. PostgreSQL is used when configured; SQLite remains the default for local development.

## Storage architecture and configuration

`GET /api/v1/health` performs `SELECT 1` against configured incident/workflow storage and a read-only query against configured FalkorDB. It returns `200` with `ready` only when required relational storage and any configured graph are reachable; otherwise it returns `503` with component-level states. An unconfigured graph remains optional.

Configure `server.databaseUrl` in `.runbook/config.yaml` or set `TRACEMIND_DATABASE_URL`. The TraceMind environment variable takes precedence; `RUNBOOK_DATABASE_URL` remains a migration alias. If neither is set, the server uses `<server-base-dir>/incidents.sqlite`. PostgreSQL startup applies idempotent schema creation for `incidents`, `incident_events`, `remediation_plans`, `remediation_steps`, `remediation_events`, and `evaluation_cases`; all writes use parameterized SQL and multi-row audit updates use a single-client transaction. SQLite and PostgreSQL implement the same `IncidentRepository` and `WorkflowRepository` contracts, so the HTTP and remediation layers do not depend on the database dialect.

Run the PostgreSQL integration test against an available disposable database with `RUNBOOK_TEST_DATABASE_URL=postgresql://... npm test -- src/server/postgres-stores.test.ts`. The test creates and drops a uniquely named temporary schema and exercises the real database adapter.

FalkorDB remains a separate graph projection configured through `graph.falkordbUrl` or `TRACEMIND_FALKORDB_URL` (`RUNBOOK_FALKORDB_URL` remains an alias), `graph.graphName`, and `graph.orgId`. `orgId` defaults to `default` for single-organization development; configure a distinct value per deployed organization. Evidence paths are read from the graph and returned with traversed relationships; the operational incident and remediation source of truth is the selected relational adapter. Configure both stores to enable the full flow. Example:

```yaml
server:
  databaseUrl: ${TRACEMIND_DATABASE_URL}
graph:
  falkordbUrl: ${TRACEMIND_FALKORDB_URL}
  graphName: tracemind
  orgId: acme
```

The backend flow is: create incident and audit entry → traverse bounded dependency paths → retrieve related incident memory → return evidence and path rationale → create pending registered remediation → record approval → execute the allowlisted action → record execution and separate post-check result → separately approve/execute rollback if needed → use observed outcome for evaluation and future incident memory. Current authenticated HTTP requests use the shared API key as the audit actor; user identity and role-based requester/approver separation remain future identity integration work.

## FalkorDB evidence paths

`GET /api/v1/graph/incidents/:incidentId/evidence-paths?depth=3` returns up to 50 related incidents found over a bounded `DEPENDS_ON` path. `depth` is an integer in `[1,4]`. Each response includes service nodes, oriented relationship endpoints, relationship criticality, and a human-readable rationale. The query scopes every node on a path to the server organization. Responses are evidence paths, not root-cause confirmations.

## Controlled remediation

1. `POST /api/v1/incidents/:incidentId/remediations` creates a pending plan with registered `actionId`, `postCheckId`, and `rollbackActionId` values. The request contains action identifiers, never shell text.
2. `POST /api/v1/remediations/:planId/steps/:stepId/approval` accepts `{ "decision": "approve"|"reject", "reason": "..." }`.
3. `POST /api/v1/remediations/:planId/steps/:stepId/execute` runs only an approved step through the injected `RemediationExecutor`. The executor is an application-supplied registry/adapter; no executor is configured by default. Execution success and post-check success are stored separately. A successful command with a failed check is `verification_failed`, not resolved.
4. `POST /api/v1/remediations/:planId/steps/:stepId/rollback-approval` requires a separate reasoned decision; `POST .../rollback` invokes the registered rollback action only after that approval.
5. `GET /api/v1/remediations/:planId` returns the persisted plan and ordered audit events.

Events record proposal, approval/rejection, execution start/result, post-check result, and rollback approval/start/result. The current server uses one shared API key, so audit actor identity is currently `api-key-user`; per-user identity and role-based separation of requester/approver are follow-up work.

## Paired evaluation analytics

`POST /api/v1/evaluations/cases` records one caller-submitted known-case comparison with `dataset`, `caseId`, ground-truth root cause, relevant evidence IDs, expected fix outcome, and paired `baseline` / `graph` observations. Each observation contains predicted root cause, retrieved evidence IDs, and a caller-asserted observed fix outcome (`succeeded`, `failed`, or `not_run`). Scores are computed server-side and upserted by `(dataset, caseId)`. This endpoint is a results store, not an independently verified benchmark runner; do not treat submitted outcomes as attested evidence.

`GET /api/v1/evaluations/cases?dataset=...` lists per-case scores; `GET /api/v1/evaluations/analytics?dataset=...` returns paired means for root-cause accuracy, evidence precision/recall, retrieval F1, and fix-outcome accuracy. The endpoint measures submitted benchmark runs; the caller must supply outputs and fix outcomes from actual executions. It does not infer that a remediation succeeded merely because execution returned successfully.

## Executor integration

When embedding `startServer`, provide `ServerOptions.remediationExecutor` with trusted handlers for execution, post-checks, and rollback. `RegisteredRemediationExecutor` maps action, check, and rollback IDs through separate server-owned allowlists; it never evaluates client-supplied shell text. Handlers should emit bounded/redacted outputs and perform read-back verification against the affected system. When omitted, plans and approvals can be recorded but execution returns `503 executor_unavailable`.
