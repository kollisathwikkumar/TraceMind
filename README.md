# TraceMind

**TraceMind** is an incident-intelligence workspace for on-call and platform teams. It connects operational events to service dependencies, evidence, historical knowledge, controlled remediation, and measured outcomes.

> **Graph intelligence powered by FalkorDB**
>
> TraceMind can use **FalkorDB** to represent service dependencies and incident relationships, traverse bounded evidence paths, and show the graph context behind an investigation. The graph is an optional, independently configured projection; the relational database remains the source of truth for incident and remediation records.

## Key features

- **Incident operations:** create and update incidents, assign owners, track severity and status, and inspect an auditable event timeline.
- **FalkorDB evidence graph:** model services and dependency edges; inspect neighborhoods and bounded multi-hop evidence paths with relationship context and rationale.
- **Knowledge search and memory:** index operational procedures and service notes, search records by query and service, and connect retrieved evidence to an investigation.
- **AI-assisted investigation:** combine incident context, service information, and retrieved knowledge to present evidence separately from hypotheses, compare alternatives, and suggest a verification step.
- **Approval-gated remediation:** create registered remediation plans, record approval or rejection, execute only through a configured server-side executor, perform a separate post-check, and keep rollback approval and results auditable.
- **Evaluation analytics:** store paired baseline and graph-assisted case results and compare root-cause accuracy, evidence precision/recall, retrieval quality, and fix outcomes.
- **Dashboard:** Overview, Incidents, Evidence graph, Knowledge search, Knowledge base, Remediations, Evaluation lab, Connected sources, and Settings.
- **CLI and MCP:** use TraceMind commands for investigation, knowledge operations, integrations, checkpoint workflows, and MCP server operation.
- **Integrations:** Auth0 Universal Login for remote dashboard access; filesystem and GitHub knowledge sources; Slack gateway/webhooks; model providers using compatible chat APIs.

## Backend architecture

```text
┌────────────────────────────── Clients ──────────────────────────────┐
│ React dashboard │ TraceMind CLI │ MCP clients │ Slack / integrations │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTP / JSON, MCP, CLI adapters
┌───────────────────────────────▼─────────────────────────────────────┐
│                         TraceMind server                             │
│ Auth0 JWT or local loopback access · API key for CLI/remote API      │
│ Incident API · Knowledge API · Graph API · Workflow API · MCP        │
└──────────────┬────────────────────┬──────────────────┬───────────────┘
               │                    │                  │
       ┌───────▼────────┐   ┌───────▼────────┐  ┌─────▼────────────┐
       │ PostgreSQL or  │   │ FalkorDB graph │  │ Knowledge search │
       │ local SQLite   │   │ dependencies & │  │ and retrieval    │
       │ incidents,     │   │ evidence paths │  │ docs and vectors │
       │ workflows,     │   └────────────────┘  └──────────────────┘
       │ audit, evals   │
       └────────────────┘
                                │
                         ┌──────▼───────┐
                         │ LLM provider │
                         └──────────────┘
```

### Storage responsibilities

| Component | Stores / provides | Configuration |
| --- | --- | --- |
| **PostgreSQL** | Shared durable incidents, timelines, remediation plans and events, approvals, and evaluation cases/results. | `TRACEMIND_DATABASE_URL`; without it, local SQLite is used. |
| **SQLite** | Local incident/workflow persistence for development and single-host use. | `<server-base-dir>/incidents.sqlite`. |
| **FalkorDB** | Service dependency graph, incident/service relationships, and graph evidence traversals. | `TRACEMIND_FALKORDB_URL`, graph name, and organization ID. Optional; graph routes report unavailable until connected. |
| **Knowledge store** | Indexed documents, chunks, and retrieval data for runbooks, notes, and other knowledge sources. | Configured knowledge store path and sources in `.runbook/config.yaml`. |
| **Model provider** | Investigation and response generation. | Provider, model, endpoint, and credential in server configuration/environment. |

PostgreSQL and FalkorDB are configured independently. PostgreSQL may be used without a graph; graph features can be enabled separately. `GET /api/v1/health` reports process and configured component health. A healthy API does not imply that optional integrations such as FalkorDB are configured.

### Incident-to-verification flow

1. Create an incident and record its timeline events.
2. Gather affected services, symptoms, and incident context.
3. Traverse relevant **FalkorDB** dependency paths and retrieve related knowledge or incident memory.
4. Return graph paths and retrieved records as evidence, keeping evidence distinct from root-cause hypotheses.
5. Create a remediation proposal using registered action/check/rollback identifiers.
6. Record an explicit approval decision before execution.
7. Execute through an application-provided, server-side allowlisted executor; record execution separately from the post-action verification result.
8. If needed, require a separate rollback approval and record the rollback outcome.
9. Submit actual observations to paired evaluations to compare baseline and graph-assisted results.

Remediation execution is not enabled by default. A successful action is not treated as proof of recovery; the post-check determines verification status.

## Quick start

Requirements: Node.js 20–24 (Node 24 is the tested local version), npm, and a supported operating system for `better-sqlite3`.

```sh
git clone https://github.com/kollisathwikkumar/TraceMind.git
cd TraceMind
npm ci
npm run build:admin
export TRACEMIND_SERVER_API_KEY="$(openssl rand -hex 32)"
npm run dev -- server --port 3000 --host 127.0.0.1
```

Open <http://localhost:3000/admin>. Same-origin browser access on loopback does not require entering the server API key. Keep the key in the server environment for CLI and remote API clients. The local server uses SQLite unless PostgreSQL is configured. FalkorDB is optional and must be configured before graph-backed evidence operations are available.

The repository includes example knowledge documents for development. Treat them as sample content, not live operational data. Connect your own sources and run a knowledge sync before relying on dashboard counts or search results.

## Configure the backend

Create `.runbook/config.yaml` or set environment variables. Example:

```yaml
server:
  port: 3000
  host: 127.0.0.1
  databaseUrl: ${TRACEMIND_DATABASE_URL}

graph:
  falkordbUrl: ${TRACEMIND_FALKORDB_URL}
  graphName: tracemind
  orgId: acme

llm:
  provider: openai-compatible
  model: <provider-model-id>
  apiBaseUrl: https://<provider-host>/v1
  apiKey: ${TRACEMIND_LLM_API_KEY}
```

Environment variables take precedence over file values:

| Variable | Purpose |
| --- | --- |
| `TRACEMIND_SERVER_API_KEY` | Required server key for CLI and remote API/MCP access. |
| `TRACEMIND_DATABASE_URL` | PostgreSQL connection string for shared incident/workflow storage. |
| `TRACEMIND_FALKORDB_URL` | **FalkorDB** connection string for graph-backed evidence. |
| `TRACEMIND_LLM_API_KEY` | Model-provider credential; `NVIDIA_API_KEY` is also recognized for compatible NVIDIA endpoints. |
| `AUTH0_DOMAIN` | Auth0 tenant for remote dashboard authentication. |
| `AUTH0_CLIENT_ID` | Auth0 SPA client identifier. |
| `AUTH0_AUDIENCE` | Identifier of the Auth0 API that issues dashboard access tokens. |
| `TRACEMIND_ORG_ID` | Auth0 `org_...` organization ID for a single-organization deployment. |
| `TRACEMIND_ORG_IDS` | Comma-separated Auth0 `org_...` organization allowlist for a multi-organization deployment; takes precedence over `TRACEMIND_ORG_ID`. |
| `TRACEMIND_CREDENTIAL_ENCRYPTION_KEY` | Stable encryption key required to store personal provider keys in PostgreSQL. |

For remote Auth0 login, configure at least one real Auth0 organization ID in `TRACEMIND_ORG_ID` or `TRACEMIND_ORG_IDS`; the dashboard cannot complete organization-scoped login when both are empty. Set the Auth0 SPA callback, logout URL, and allowed web origin to the dashboard origin. Configure Google and database/email-password login connections in Auth0. The browser uses Authorization Code with PKCE; the API validates JWT issuer, audience, expiry, and signature. Provider API keys are encrypted server-side and scoped to the authenticated subject when PostgreSQL and the encryption key are configured.

Do not commit `.env` files, API keys, database credentials, or production data.

### FalkorDB hackathon path

TraceMind’s strongest FalkorDB fit is **Track 1: Agents That Act on Connected Data**: the investigation CLI can use bounded, tenant-scoped FalkorDB paths as cited topology evidence rather than treating the graph as a passive visualization. The graph stores services, dependency relationships, and incident-to-service links; it does not independently prove causation. See the [FalkorDB hackathon readiness audit](docs/FALKORDB_HACKATHON_READINESS.md) for the current implementation map, local integration-test steps, demo flow, and remaining gaps.

## Use the dashboard

1. Start the server and open `/admin`.
2. Add knowledge sources from **Configure → Connected sources**, then sync the knowledge base.
3. Add a model provider and run **Test model connection** from Settings or Overview.
4. Create or open an incident in **Command → Incidents**.
5. Review service relationships and evidence in **Investigation → Evidence graph**; inspect supporting records in Knowledge search/base.
6. Draft a remediation, capture the required approval, and execute only after a trusted executor is configured.
7. Record the post-check result and review paired measurements in **Resolve & Learn → Evaluation lab**.

## CLI usage

```sh
npm run dev -- --help
npm run dev -- init
npm run dev -- status
npm run dev -- ask "Why is checkout timing out?"
npm run dev -- investigate <incident-id>
npm run dev -- knowledge sync
npm run dev -- knowledge search "database connection timeout"
npm run dev -- server --port 3000 --host 127.0.0.1
npm run dev -- mcp serve
```

After building, the executable is `dist/cli.js` and the package exposes the `tracemind` command. Use `npm run dev -- <command> --help` for command-specific options.

## API overview

The HTTP API is versioned under `/api/v1`. Authenticated routes include:

- `/incidents` — incident lifecycle and event timeline.
- `/graph` — service graph and bounded incident evidence paths.
- `/knowledge` — documents, search, source status, statistics, and sync.
- `/remediations` — plans, approvals, execution, verification, and rollback.
- `/evaluations` — case submissions and paired analytics.
- `/settings` — model/provider configuration and provider-key status.
- `/health` — process and configured component health.

The MCP endpoint is `/mcp`; CLI MCP stdio mode is available with `tracemind mcp serve`. See [backend workflow and API details](docs/TRACEMIND_BACKEND_WORKFLOWS.md) and [dashboard authentication setup](docs/AUTH0_SETUP.md).

## Development and implementation

The project is implemented in TypeScript on Node.js. The dashboard is React/TSX bundled by the admin build; the backend is an HTTP server with separate API modules and repository interfaces. PostgreSQL and SQLite implement the same incident/workflow contracts. Knowledge retrieval is separate from incident persistence, and the FalkorDB adapter supplies graph projections independently. The CLI, HTTP server, and MCP interface share the agent, knowledge, and integration layers.

```sh
npm ci
npm run build:admin
npm run build
npm run typecheck
npm test
npm run lint
```

For PostgreSQL adapter integration tests, set `RUNBOOK_TEST_DATABASE_URL` to a disposable database and run:

```sh
npm test -- src/server/postgres-stores.test.ts
```

The test uses a temporary schema and removes it after the run. For a local environment without PostgreSQL, use the default unit and integration suite.

### Source map

- `src/server/` — HTTP server, authentication, routes, database repositories, incident/workflow APIs.
- `src/server/admin/` — dashboard application and client API.
- `src/knowledge/` — knowledge sources, retrieval, local stores, and **FalkorDB** graph adapter.
- `src/agent/` — investigation orchestration, reasoning state, tools, and prompts.
- `src/cli/` and `src/cli.tsx` — terminal workflows and command entry point.
- `src/mcp/` — Model Context Protocol server and transports.
- `src/integrations/`, `src/slack/`, `src/webhooks/` — external context and event integrations.
- `src/learning/` — learning and evaluation workflows.
- `docs/` — architecture, configuration, security, and operations documentation.
