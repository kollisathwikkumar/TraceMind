# Backend release audit — 2026-10-17

## Scope and result

This is the implementation and verification record for the release branch based
on the currently deployed TraceMind commit `3e3c31c1ee38d15312e026bdceadc110cfd5c942`.
The source checkout at `75f8ba52012f79e5c40b8e98ed4480416c2a8c65` was not used as
the release base because it is dirty and does not share history with the
TraceMind deployment repository. No production database mutation, push, or
deployment was performed.

## Implemented

- PostgreSQL tenant context and forced RLS for incident, remediation,
  evaluation, graph catalog/outbox, and knowledge/vector tables; runtime role
  must be non-superuser and `NOBYPASSRLS`.
- Separate migration connection and explicit, reviewed legacy tenant-mapping
  utility. Mapping and knowledge migration have dry-run modes; no production
  mapping or copy was applied.
- Auth0 issuer/audience/RS256 verification, organization allowlist, route scopes,
  and tenant-scoped persistence/retrieval. Multi-organization operation fails
  closed if tenant-backed storage is unavailable.
- `/livez` and `/readyz`; readiness reports database, graph, knowledge, vector,
  executor, and projection status, with required PostgreSQL/FalkorDB settings.
- Durable PostgreSQL graph outbox/catalog replay for every configured tenant,
  lease-token fencing, ordering, and FalkorDB aggregate-version protection.
- Remediation proposer/approver/executor separation, lease fencing,
  idempotency, rollback approval/execution separation, ambiguous
  execution/rollback/verification states, and scope-gated audited reconciliation.
- HTTP broker origin allowlisting, HTTPS enforcement (except loopback), and
  redirect rejection. Executor remains optional and unconfigured until a broker
  is exercised and configured.
- PostgreSQL-backed knowledge/vector stores and SQLite-to-PostgreSQL migration
  utility for replacing ephemeral local knowledge storage.
- Replaced vulnerable `gray-matter` dependency path with a bounded local
  frontmatter parser.

## Verification

Run from `/tmp/tracemind-backend-release`, with local PostgreSQL and FalkorDB
available and Node 24.11.1 (native SQLite ABI 137):

| Check | Result |
|---|---|
| Full tests | `npm test -- --pool=forks --maxWorkers=1 --reporter=dot` — 54 files, 494 tests passed |
| Typecheck | `npm run typecheck` — passed |
| Lint | `npm run lint` — exit 0; 56 pre-existing warnings, 0 errors |
| Build | `npm run build` — passed |
| Runtime dependency audit | `npm audit --omit=dev` — 0 vulnerabilities |
| Diff whitespace | `git diff --check` — passed |
| Database/RLS | Restricted-role PostgreSQL integration tests passed |
| Graph | Local FalkorDB health passed; stale-version and legacy-event ordering probe passed; temporary probe graph deleted |

The full suite uses `RUNBOOK_TEST_DATABASE_URL` and
`RUNBOOK_TEST_FALKORDB_URL` set to the local integration services. Never copy
those local credentials into deployment configuration.

## Security review

Security-sensitive changes were independently reviewed. The review covered
authorization/tenant isolation, parameterized SQL and migration role use,
credential handling, executor SSRF controls, workflow separation of duties,
lease/idempotency handling, and graph outbox replay/versioning. The findings
were corrected and verified by tests. Ambiguous broker or verification
responses remain unknown until an operator with `remediations:reconcile`
checks the external idempotency key, performs any required independent check,
and records bounded evidence. The broker contract has no status lookup endpoint,
so automatic reconciliation is not implemented.

## Production gates still open

1. The Render service still runs the old commit; this branch has not been
   deployed. Live `/readyz` and `/livez` therefore remain unverified.
2. Render-to-Neon connection linkage remains unconfirmed. The active Neon branch
   and current service datasource must be verified before any production
   migration.
3. The runtime and migration database credentials/roles must be configured and
   verified in Render; production backup/snapshot policy is not verified.
4. The existing legacy records still need an authoritative organization map.
   Review and dry-run `npm run db:tenant-map`; apply only after record ownership
   has been confirmed. Existing `default` tenant rows are not automatically
   assigned to real organizations.
5. Ephemeral knowledge/vector content must be enumerated, backed up, and copied
   to PostgreSQL with the tenant mapping before relying on persistent storage.
6. An Auth0 test identity and production organization mapping are still being
   prepared; authenticated production CRUD/restart has not been run.
7. The external remediation broker exercise/configuration is not ready. The
   executor remains disabled (`TRACEMIND_REMEDIATION_EXECUTOR_REQUIRED=false`).
8. After these gates close: push/review the clean branch, verify the approved
   migration plan, deploy, and test production readiness, authenticated CRUD,
   persistence across restart, graph projection, and remediation health.

No production claim in this report should be inferred from the local test
results.
