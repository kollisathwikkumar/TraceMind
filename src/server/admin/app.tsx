import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { AdminApi } from './api';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { DocumentList } from './components/DocumentList';
import { DocumentView } from './components/DocumentView';
import { DocumentEdit } from './components/DocumentEdit';
import { Search } from './components/Search';
import { Sources } from './components/Sources';
import { Incidents } from './components/Incidents';
import { GraphEvidence } from './components/GraphEvidence';
import { Remediations } from './components/Remediations';
import { EvaluationAnalyticsPage } from './components/EvaluationAnalytics';
import { Settings } from './components/Settings';
import {
  DASHBOARD_AUTHORIZATION_SCOPE,
  authReturnToWithoutInvitation,
  organizationLoginAuthorizationParams,
  safeAuthReturnTarget,
} from './auth-routing';
import { RedirectFirstAuth0Client } from './redirect-first-auth0-client';

interface AuthConfig {
  enabled: boolean;
  localAccess?: boolean;
  domain: string;
  clientId: string;
  audience: string;
  organizations?: string[];
}

function parseHash(): { page: string; id?: string } {
  const hash = window.location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'documents' && parts[1] && parts[2] === 'edit') {
    return { page: 'document-edit', id: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'documents' && parts[1]) {
    return { page: 'document-view', id: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'documents') return { page: 'documents' };
  if (parts[0] === 'search') return { page: 'search' };
  if (parts[0] === 'sources') return { page: 'sources' };
  if (parts[0] === 'incidents') return { page: 'incidents' };
  if (parts[0] === 'graph') return { page: 'graph' };
  if (parts[0] === 'remediations') return { page: 'remediations' };
  if (parts[0] === 'analytics') return { page: 'analytics' };
  if (parts[0] === 'settings') return { page: 'settings' };
  return { page: 'dashboard' };
}

function renderPage(route: ReturnType<typeof parseHash>, api: AdminApi): React.ReactNode {
  switch (route.page) {
    case 'documents':
      return <DocumentList api={api} />;
    case 'document-view':
      return <DocumentView api={api} id={route.id!} />;
    case 'document-edit':
      return <DocumentEdit api={api} id={route.id!} />;
    case 'search':
      return <Search api={api} />;
    case 'sources':
      return <Sources api={api} />;
    case 'incidents':
      return <Incidents api={api} />;
    case 'graph':
      return <GraphEvidence api={api} />;
    case 'remediations':
      return <Remediations api={api} />;
    case 'analytics':
      return <EvaluationAnalyticsPage api={api} />;
    case 'settings':
      return <Settings api={api} />;
    default:
      return <Dashboard api={api} />;
  }
}

function Auth0LoginScreen({
  authError,
  organizationId,
}: {
  authError?: Error;
  organizationId: string;
}) {
  const { loginWithRedirect } = useAuth0();
  const [redirectError, setRedirectError] = useState<Error | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (authError || started.current) return;
    started.current = true;
    const authorizationParams = organizationLoginAuthorizationParams(
      organizationId,
      window.location.search
    );
    if (!authorizationParams) {
      started.current = false;
      setRedirectError(
        new Error('This invitation link is invalid or belongs to a different organization.')
      );
      return;
    }
    const returnTo = authReturnToWithoutInvitation(window.location);
    void loginWithRedirect({ authorizationParams, appState: { returnTo } }).catch(
      (reason: unknown) => {
        started.current = false;
        setRedirectError(
          reason instanceof Error ? reason : new Error('Could not start Auth0 sign-in')
        );
      }
    );
  }, [authError, loginWithRedirect, organizationId]);

  const error = authError ?? redirectError;
  if (error) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1 className="login-title">Sign-in could not start</h1>
          <p className="login-subtitle">{error.message}</p>
          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 12 }}
            onClick={() => window.location.assign(`${window.location.origin}/admin`)}
          >
            Try sign-in again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">TraceMind</h1>
        <p className="login-subtitle" role="status" aria-live="polite">
          Redirecting to secure sign-in…
        </p>
      </div>
    </div>
  );
}

function AuthInitializationScreen() {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => setTimedOut(true), 12_000);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!timedOut) return <div className="loading">Checking sign-in…</div>;
  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">Sign-in is taking longer than expected</h1>
        <p className="login-subtitle">
          The secure identity check has not finished yet. Retry to restart sign-in.
        </p>
        <button
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 12 }}
          onClick={() => window.location.assign(`${window.location.origin}/admin`)}
        >
          Retry sign-in
        </button>
      </div>
    </div>
  );
}

function LocalDashboardApp() {
  const [route, setRoute] = useState(parseHash);
  const handleHashChange = useCallback(() => setRoute(parseHash()), []);
  useEffect(() => {
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [handleHashChange]);
  useEffect(() => {
    // Discard keys from older dashboard builds; local browser requests are
    // authorized by the server's loopback + same-origin check instead.
    sessionStorage.removeItem('admin_api_key');
  }, []);
  const api = new AdminApi();
  return (
    <Layout currentPage={route.page} api={api}>
      {renderPage(route, api)}
    </Layout>
  );
}

function RemoteAuthRequiredScreen() {
  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">TraceMind</h1>
        <p className="login-subtitle">Remote dashboard sign-in is not configured.</p>
        <p className="auth-login-options">
          Configure Auth0 Universal Login for browser access. The server API key remains available
          to CLI clients.
        </p>
      </div>
    </div>
  );
}

function AuthenticatedApp({
  config,
  organizationId,
}: {
  config: AuthConfig;
  organizationId: string;
}) {
  const { isLoading, isAuthenticated, getAccessTokenSilently, logout, error } = useAuth0();
  const [route, setRoute] = useState(parseHash);
  const handleHashChange = useCallback(() => setRoute(parseHash()), []);
  useEffect(() => {
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [handleHashChange]);
  if (isLoading) return <AuthInitializationScreen />;
  if (error) return <Auth0LoginScreen authError={error} organizationId={organizationId} />;
  if (!isAuthenticated) return <Auth0LoginScreen organizationId={organizationId} />;
  const api = new AdminApi(async (scope) => {
    const token = await getAccessTokenSilently({
      authorizationParams: {
        audience: config.audience,
        organization: organizationId,
        scope: scope ? scope : DASHBOARD_AUTHORIZATION_SCOPE,
      },
    });
    if (!token) throw new Error('No access token was returned for the TraceMind API');
    return token;
  });
  return (
    <Layout
      currentPage={route.page}
      onLogout={() =>
        void logout({ logoutParams: { returnTo: `${window.location.origin}/admin` } })
      }
      api={api}
    >
      {renderPage(route, api)}
    </Layout>
  );
}

export function App() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/v1/auth/config', { headers: { 'X-TraceMind-Local-Dashboard': '1' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Auth configuration request failed (${response.status})`);
        return response.json() as Promise<{ data: AuthConfig }>;
      })
      .then((result) => {
        if (active) setConfig(result.data);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Could not load auth configuration');
      });
    return () => {
      active = false;
    };
  }, []);
  if (error) return <div className="error-banner">{error}</div>;
  if (!config) return <div className="loading">Loading TraceMind…</div>;
  if (!config.enabled)
    return config.localAccess ? <LocalDashboardApp /> : <RemoteAuthRequiredScreen />;
  if (!config.domain || !config.clientId || !config.audience) {
    return (
      <div className="error-banner">
        Auth0 is enabled, but the server auth configuration is incomplete.
      </div>
    );
  }

  return <AuthOrganizationGate config={config} />;
}

function AuthOrganizationGate({ config }: { config: AuthConfig }) {
  const organizations = [...new Set(config.organizations || [])].filter(Boolean);
  const [selectedOrganization, setSelectedOrganization] = useState(
    organizations.length === 1 ? organizations[0] : ''
  );

  if (organizations.length === 0) {
    return (
      <div className="error-banner">
        Auth0 is enabled, but no organization is configured. Set TRACEMIND_ORG_ID or
        TRACEMIND_ORG_IDS to the Auth0 organization ID(s).
      </div>
    );
  }

  if (organizations.length > 1 && !organizations.includes(selectedOrganization)) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1 className="login-title">Choose your organization</h1>
          <p className="login-subtitle">Sign in to the TraceMind organization you belong to.</p>
          <label className="auth-login-options" htmlFor="auth0-organization">
            Organization
          </label>
          <select
            id="auth0-organization"
            className="auth-organization-select"
            value={selectedOrganization}
            onChange={(event) => setSelectedOrganization(event.target.value)}
          >
            <option value="">Select an organization</option>
            {organizations.map((organization) => (
              <option key={organization} value={organization}>
                {organization}
              </option>
            ))}
          </select>
          <p className="auth-login-options">
            Auth0 verifies organization membership; API access remains scoped to the selected
            organization.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ConfiguredAuthApp config={config} organizationId={selectedOrganization || organizations[0]} />
  );
}

function ConfiguredAuthApp({
  config,
  organizationId,
}: {
  config: AuthConfig;
  organizationId: string;
}) {
  const client = useMemo(
    () =>
      new RedirectFirstAuth0Client({
        domain: config.domain,
        clientId: config.clientId,
        authorizationParams: {
          redirect_uri: `${window.location.origin}/admin`,
          audience: config.audience,
          organization: organizationId,
          scope: DASHBOARD_AUTHORIZATION_SCOPE,
        },
      }),
    [config, organizationId]
  );
  return (
    <Auth0Provider
      client={client}
      onRedirectCallback={(appState) => {
        const returnTo = (appState as { returnTo?: string } | undefined)?.returnTo;
        const target = safeAuthReturnTarget(returnTo, window.location.origin);
        if (!target) return;
        const previousHash = window.location.hash;
        window.history.replaceState(window.history.state, '', target);
        if (new URL(target, window.location.origin).hash !== previousHash) {
          window.dispatchEvent(new Event('hashchange'));
        }
      }}
    >
      <AuthenticatedApp config={config} organizationId={organizationId} />
    </Auth0Provider>
  );
}
