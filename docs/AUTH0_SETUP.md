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
