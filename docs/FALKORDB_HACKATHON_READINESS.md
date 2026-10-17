# FalkorDB hackathon readiness

**Assessment date:** 2026-10-17  
**Primary fit:** WeMakeDevs × FalkorDB **Track 1 — Agents That Act on Connected Data**.  
**Scope:** repository implementation and local integration test path only. This is not a check of the hosted FalkorDB Cloud instance or deployed Render service.

## Why FalkorDB is central to this project

TraceMind investigates operational incidents by combining service topology with historical incident evidence. FalkorDB is the relationship/query engine for that topology: a bounded graph traversal can return the service path connecting related incidents, including relationship type and criticality. The CLI investigation flow now resolves graph URL, graph name, and organization from environment/configuration, then adds those paths as traceable context. It labels them as topology correlation, not proof of root cause. PostgreSQL (or local SQLite) remains the system of record for incidents and workflow audit data; it is not a substitute graph store.

This maps most directly to Track 1’s graph-informed agent actions and explainable reasoning. Track 2 (persistent operational memory) and Track 3 (connected operational knowledge) are adjacent extensions, not claims of fully implemented tracks. See [the official hackathon tracks](https://www.wemakedevs.org/hackathons/falkordb#tracks).

## Implemented graph path

- `src/knowledge/store/falkordb-store.ts` uses the FalkorDB Node client and parameterized Cypher for service upserts, `DEPENDS_ON` edges, incident `AFFECTS` edges, service neighborhoods, related incidents, and bounded evidence paths.
- Graph lookups scope nodes by `org_id`; evidence-path depth is limited to 1–4, and output includes oriented edges, criticality, and a rationale.
- When PostgreSQL graph catalog/outbox support is configured, catalog changes are durably queued and replayed into the graph projection. Replay is version-guarded and idempotent. The graph remains a projection, rather than the canonical incident/audit store.
- The registered `falkordb_incident_impact` agent tool performs read-only, bounded multi-hop queries using the organization from trusted runtime configuration. It caps depth/results and returns source graph, tenant, path edges, and a correlation-not-causation note.
- Authenticated incident creation accepts `serviceIds` (up to 50 IDs) and transactionally queues all incident/service links through the PostgreSQL graph catalog. Existing explicit graph-link routes remain available.
- Authenticated graph API supports service/dependency writes, graph link deletion, service deletion, evidence-path reads, and tenant reconciliation. Reconciliation requires `graph:admin`; tenant identity comes from the authenticated request, and the operation is bounded and serialized against catalog writes/replay.
- The CLI investigation context also consumes multi-hop paths when FalkorDB is configured; graph-offline behavior remains available for local workflows.
- Store bootstrap creates lookup indexes for tenant-scoped Service and Incident lookups, and the integration test exercises a fresh graph, indexes, organization separation, and stale-event replay behavior.

For the API contract and configuration details, see [backend workflows](TRACEMIND_BACKEND_WORKFLOWS.md). The [official Cypher reference](https://docs.falkordb.com/cypher) and [graph-algorithm documentation](https://docs.falkordb.com/algorithms) describe additional graph capabilities that could extend this investigation workflow.

## Local real-server verification

Run against a disposable local FalkorDB server, not a production graph. The checked-in integration test is opt-in through `RUNBOOK_TEST_FALKORDB_URL`; it creates a uniquely named graph and deletes that graph after the run.

```sh
# Start the repository's local FalkorDB service (the compose setup may also start PostgreSQL).
docker compose up -d falkordb

# Point the integration test at the local server; no Cloud endpoint is needed.
RUNBOOK_TEST_FALKORDB_URL=redis://127.0.0.1:6379 \
  npm test -- src/knowledge/store/__tests__/falkordb-store.integration.test.ts

npm run typecheck
```

Expected integration coverage includes: fresh empty graph readiness/bootstrap; idempotent writes; tenant-separated neighborhoods and incident matches; malformed cross-tenant edges; stale catalog versions; deletion/unlink; and lookup indexes. A skipped test means the environment variable was not set, not that FalkorDB passed. For the agent tool and CLI path, set `TRACEMIND_FALKORDB_URL`, `TRACEMIND_FALKORDB_GRAPH_NAME`, and `TRACEMIND_ORG_ID` in a local test environment, then run an investigation against a fixture incident and graph.

## Implemented completion items

The five code gaps previously identified are now implemented in this branch: an agent-callable graph query, lifecycle/reconciliation APIs, incident service-ID ingestion, authenticated route tests, and a pinned FalkorDB CI job. Remaining demo/release work is operational: run the demo against the intended hosted graph, show the agent invoking the graph tool, seed the topology and incident links, and record the tested deployment commit.

## Remaining external verification

- The local real-server suite does not verify FalkorDB Cloud connectivity, cloud credentials, backups, HA, or the Render runtime. The supplied screenshot showed HA and backups disabled; treat it as context, not proof of application connectivity. Rotate the credential visible in the image before reusing that instance and keep replacement credentials in the deployment secret manager.
- The real FalkorDB integration suite is now a dedicated CI job against the pinned `v4.22.1` image. Route-level tests cover Auth0 tenant/scope boundaries and graph failure/backlog reporting; hosted Auth0/Render behavior still needs production test identities and configuration.

## Demo acceptance checklist

- [x] Start a fresh, pinned local FalkorDB instance and run the real-server integration test successfully.
- [ ] Seed a small service graph and two incidents linked through a shared dependency path.
- [ ] Run an investigation and show the FalkorDB path, source graph/organization, edge criticality, and explicit correlation-not-causation note.
- [x] Verify that a second organization’s identically named service/incident does not appear in the route/store tests.
- [ ] Disconnect FalkorDB and show health/readiness behavior and a clear graph-unavailable result; reconnect and replay pending projection events.
- [ ] Record a short demo and document the exact tested commit and FalkorDB server version.

The hackathon requires FalkorDB to be the primary graph database and central to the product. The code now has an agent-callable, bounded FalkorDB action and explainable path results, with repair and ingestion workflows around the projection. A live hosted demo still needs to demonstrate that graph-driven action end to end.
