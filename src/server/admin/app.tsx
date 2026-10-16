import { useState, useEffect, useCallback, useRef } from 'react';
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

interface AuthConfig {
  enabled: boolean;
  localAccess?: boolean;
  domain: string;
  clientId: string;
  audience: string;
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

function Auth0LoginScreen({ authError }: { authError?: Error }) {
  const { loginWithRedirect } = useAuth0();
  const [redirectError, setRedirectError] = useState<Error | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (authError || started.current) return;
    started.current = true;
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    void loginWithRedirect({ appState: { returnTo } }).catch((reason: unknown) => {
      started.current = false;
      setRedirectError(
        reason instanceof Error ? reason : new Error('Could not start Auth0 sign-in'),
      );
    });
  }, [authError, loginWithRedirect]);

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

function AuthenticatedApp({ config }: { config: AuthConfig }) {
  const { isLoading, isAuthenticated, getAccessTokenSilently, logout, error } = useAuth0();
  const [route, setRoute] = useState(parseHash);
  const handleHashChange = useCallback(() => setRoute(parseHash()), []);
  useEffect(() => {
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [handleHashChange]);
  if (isLoading) return <div className="loading">Checking sign-in…</div>;
  if (error) return <Auth0LoginScreen authError={error} />;
  if (!isAuthenticated) return <Auth0LoginScreen />;
  const api = new AdminApi(async () => {
    const token = await getAccessTokenSilently({
      authorizationParams: { audience: config.audience },
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
  return (
    <Auth0Provider
      domain={config.domain}
      clientId={config.clientId}
      authorizationParams={{
        redirect_uri: `${window.location.origin}/admin`,
        audience: config.audience,
        scope: 'openid profile email',
      }}
      onRedirectCallback={(appState) => {
        const returnTo = (appState as { returnTo?: string } | undefined)?.returnTo;
        if (returnTo) window.location.assign(returnTo);
      }}
    >
      <AuthenticatedApp config={config} />
    </Auth0Provider>
  );
}
