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
- The authenticated graph API supports service/dependency/incident-service writes and evidence-path reads. The CLI investigation context consumes multi-hop paths when FalkorDB is configured; graph-offline behavior remains available for local workflows.
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

Expected integration coverage includes: fresh empty graph readiness/bootstrap; idempotent writes; tenant-separated neighborhoods and incident matches; stale catalog versions not overwriting newer graph state; and lookup indexes. A skipped test means the environment variable was not set, not that FalkorDB passed. For the CLI path, set `TRACEMIND_FALKORDB_URL`, `TRACEMIND_FALKORDB_GRAPH_NAME`, and `TRACEMIND_ORG_ID` in a local test environment and run `npm run dev -- investigate <incident-id>` against a fixture incident and graph.

## Gaps to close for a convincing demo/release

1. **Turn graph evidence into an observable agent action.** The CLI currently adds graph paths to investigation context; the agent/MCP surface does not yet expose a dedicated bounded graph-query/algorithm tool. Add one only with explicit tenant scoping, strict depth/row limits, and provenance in results. A bounded BFS/impact traversal is a better first demo than an unbounded centrality job; FalkorDB’s [BFS reference](https://docs.falkordb.com/algorithms/bfs) emphasizes bounding traversal work.
2. **Make graph lifecycle and repair complete.** The current write/read path does not provide a full graph delete/unlink/rebuild-and-reconcile workflow. Define behavior for service/incident deletion and projection drift, then test replay/rebuild from PostgreSQL catalog state.
3. **Automate incident topology linking.** Incident-service association is currently an explicit graph API operation; the incident record itself does not automatically supply affected service IDs. Demonstrate the association source and ingestion path, or add a validated source-to-graph mapping.
4. **Exercise graph isolation and failure behavior at API level.** Store-level organization filtering is present, but release confidence should include authenticated route tests for two organizations, empty graph bootstrap, unavailable graph, and outbox backlog/replay.
5. **Use reproducible graph infrastructure.** Keep the local FalkorDB server version pinned and document the tested server/module version. Run the integration suite in CI against that pinned image; mocked tests alone do not validate Cypher compatibility.
6. **Treat hosted operations separately.** A screenshot of a healthy cloud instance is not an application connectivity test. The supplied screenshot showed cloud HA and backups disabled; no hosted endpoint connectivity, backup restore, or production query was tested for this audit. Rotate the credential visible in the screenshot before using that instance again, and supply credentials only through the deployment secret manager.

## Demo acceptance checklist

- [ ] Start a fresh, pinned local FalkorDB instance and run the real-server integration test successfully.
- [ ] Seed a small service graph and two incidents linked through a shared dependency path.
- [ ] Run an investigation and show the FalkorDB path, source graph/organization, edge criticality, and explicit correlation-not-causation note.
- [ ] Show that a second organization’s identically named service/incident does not appear in the result.
- [ ] Disconnect FalkorDB and show health/readiness behavior and a clear graph-unavailable result; reconnect and replay pending projection events.
- [ ] Record a short demo and document the exact tested commit and FalkorDB server version.

The hackathon’s **primary-graph-database** requirement makes the FalkorDB-powered relationship reasoning the product’s main differentiator, not an optional screenshot. The current repository has the core graph model and bounded retrieval path; the checklist above separates implemented behavior from the work still needed to present it as a robust, reproducible end-to-end feature.
