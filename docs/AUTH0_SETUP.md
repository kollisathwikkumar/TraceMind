# TraceMind dashboard authentication and storage

## Auth0 Universal Login

Set these server-side environment variables before starting TraceMind:

```sh
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-spa-client-id
AUTH0_AUDIENCE=https://api.your-domain.example
```

In Auth0, create a Single Page Application and an API whose Identifier exactly
matches `AUTH0_AUDIENCE`. Enable **Google** as a Social connection and enable an
Auth0 **Database** connection with email/password signup. Assign both connections
to the SPA. The dashboard uses Universal Login without forcing a connection, so
Auth0 can show both login methods. Configure the SPA callback and logout URL as
`http://localhost:3000/admin` for local use, and add that origin to Allowed Web
Origins. Use your deployed HTTPS dashboard URL in production.

The SPA uses the Auth0 React SDK with Authorization Code + PKCE and requests
access tokens for the configured API audience. The API verifies issuer, audience,
expiry and RS256 signatures against the tenant JWKS. The Google and email/password
credentials remain with Auth0; TraceMind never receives the user's password.

For the remote dashboard, set `TRACEMIND_ORG_ID` to one Auth0 organization ID
(`org_...`) or `TRACEMIND_ORG_IDS` to a comma-separated allowlist of those IDs.
The dashboard requests an Auth0 token with the selected organization parameter;
for multiple organizations it presents a picker. The Auth0 SPA application must
be enabled for Organizations and the signed-in user must belong to the selected
organization. The API independently checks the signed `org_id` claim against its
allowlist before using it as a tenant, so the browser selection does not grant
membership or access by itself.

### Scope and onboarding behavior

The dashboard starts Universal Login with only `openid profile email`. It asks
for API access tokens silently as individual API calls need them, using the
smallest route-specific permission (for example `incidents:read` for incident
reads and `incidents:write` for incident creation). Auth0's API must have RBAC
enabled and the required permissions defined. Assign narrowly scoped roles to
organization members during onboarding; do not give ordinary members write,
admin, or remediation-executor permissions by default. A genuine missing-scope
or tenant error is shown in the dashboard as an actionable message.

The API must define the scopes used by the router before clients request them:
`incidents:read`, `incidents:write`, `knowledge:read`, `knowledge:write`,
`graph:read`, `graph:write`, `graph:admin`, `llm:validate`, `settings:keys`,
`remediations:propose`, `remediations:read`, `remediations:approve`,
`remediations:execute`, `remediations:rollback`, `remediations:reconcile`,
`evaluations:read`, `evaluations:write`, and `mcp:access` when MCP is enabled.
Defining a permission does not grant it: only include permissions in roles for
the users who need them. A new baseline read-only role needs only
`incidents:read`, `knowledge:read`, and `graph:read`.

For first-party dashboard login, inspect the Auth0 Dashboard's API settings for
the TraceMind API and review **Allow Skipping User Consent**. Enable it only if
TraceMind is a first-party application and that matches the organization's
consent policy. This is an Auth0 tenant setting and is not controlled by this
repository; verify it in the tenant before claiming the setting is active.

### Provision a read-only organization member

The onboarding CLI is dry-run by default. It validates that the requested
organization is in `TRACEMIND_ORG_ID` or `TRACEMIND_ORG_IDS`, that the user and
organization exist, and that the configured role is a read-only role containing
only the supported TraceMind read permissions. The baseline role must include
`incidents:read`, `knowledge:read`, and `graph:read`; `remediations:read` and
`evaluations:read` may be added when those screens should be available. It prints
the planned membership and role changes without applying them unless `--apply`
is supplied.

Create or select an Auth0 **Machine to Machine** application authorized for the
Auth0 Management API. Grant only these Management API permissions to that M2M
application:

```text
read:users
read:organizations
read:roles
read:organization_member_roles
create:organization_members
create:organization_member_roles
```

Set these server-side environment variables in a private shell (never commit
them or paste the client secret into the dashboard/browser):

```sh
export AUTH0_DOMAIN='your-tenant.us.auth0.com'
export AUTH0_MGMT_CLIENT_ID='...'
export AUTH0_MGMT_CLIENT_SECRET='...'
export AUTH0_AUDIENCE='https://api.your-domain.example'
export AUTH0_BASELINE_READONLY_ROLE_ID='rol_...'
export TRACEMIND_ORG_ID='org_...'
```

Use the exact Auth0 user ID from the user's profile (for example
`google-oauth2|...`), and review the dry-run output first:

```sh
npm run auth0:org:onboard-member -- --org-id org_... --user-id 'google-oauth2|...'
```

Only after confirming the organization, identity, and role in the plan, apply:

```sh
npm run auth0:org:onboard-member -- --org-id org_... --user-id 'google-oauth2|...' --apply
```

The CLI applies organization membership and the existing read-only role
idempotently. It does not create roles, grant write permissions, or change the
Auth0 consent setting. Configure a separate deliberate role for write actions.

## PostgreSQL and personal provider keys

The backend uses PostgreSQL when `TRACEMIND_DATABASE_URL` (or the existing
`RUNBOOK_DATABASE_URL`/config fallback) is set. Without it, incident and workflow
records use local SQLite. `/api/v1/health` reports the active database driver and
whether FalkorDB is connected.

Personal provider keys require PostgreSQL and a stable encryption key. Generate
one with:

```sh
openssl rand -base64 32
```

Set its output as `TRACEMIND_CREDENTIAL_ENCRYPTION_KEY` in the server environment.
The value must be retained across restarts; replacing it makes previously saved
keys undecryptable. Keys are encrypted with AES-256-GCM and scoped to the Auth0
subject. The browser receives only configured/provider/updated-at metadata.

Configure FalkorDB separately with `TRACEMIND_FALKORDB_URL` (or the existing
`RUNBOOK_FALKORDB_URL`/config fallback). FalkorDB remains optional; graph features
are reported as not configured until a connection is established.
