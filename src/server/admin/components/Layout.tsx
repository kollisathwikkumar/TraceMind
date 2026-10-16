import { useEffect, useState } from 'react';
import type { AdminApi, HealthData } from '../api';

const GROUPS = [
  {
    title: 'Command',
    items: [
      { page: 'dashboard', label: 'Overview', icon: '⌂', hash: '#/' },
      { page: 'incidents', label: 'Incidents', icon: '◉', hash: '#/incidents' },
    ],
  },
  {
    title: 'Investigation',
    items: [
      { page: 'graph', label: 'Evidence graph', icon: '⌘', hash: '#/graph' },
      { page: 'search', label: 'Knowledge search', icon: '⌕', hash: '#/search' },
      { page: 'documents', label: 'Knowledge base', icon: '▤', hash: '#/documents' },
    ],
  },
  {
    title: 'Resolve & Learn',
    items: [
      { page: 'remediations', label: 'Remediations', icon: '↗', hash: '#/remediations' },
      { page: 'analytics', label: 'Evaluation lab', icon: '▥', hash: '#/analytics' },
    ],
  },
  {
    title: 'Configure',
    items: [
      { page: 'sources', label: 'Connected sources', icon: '⛓', hash: '#/sources' },
      { page: 'settings', label: 'Settings & API key', icon: '⚙', hash: '#/settings' },
    ],
  },
];

export function Layout({
  currentPage,
  onLogout,
  api,
  children,
}: {
  currentPage: string;
  onLogout?: () => void;
  api: AdminApi;
  children: React.ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .getHealth()
      .then((result) => {
        if (live) setHealth(result);
      })
      .catch(() => {
        if (live) setHealth(null);
      });
    return () => {
      live = false;
    };
  }, [api]);
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim()) window.location.hash = `#/search?q=${encodeURIComponent(search.trim())}`;
  };
  return (
    <div className="app-frame">
      <main className="main-frame">
        <header className="topbar">
          <a href="#/" className="home-mark" aria-label="TraceMind overview" title="TraceMind">
            <span className="home-wordmark">TraceMind</span>
          </a>
          <nav className="primary-nav" aria-label="Dashboard navigation">
            {GROUPS.map((group) => {
              const menuId = `nav-dropdown-${group.title.replaceAll(/[^a-z0-9]/gi, '-').toLowerCase()}`;
              const groupIsActive = group.items.some(
                (item) =>
                  currentPage === item.page ||
                  (item.page === 'documents' && currentPage.startsWith('document'))
              );
              return (
                <div
                  className={`nav-menu ${openGroup === group.title ? 'is-open' : ''}`}
                  key={group.title}
                  onMouseEnter={() => setOpenGroup(group.title)}
                  onMouseLeave={() => setOpenGroup(null)}
                  onFocus={() => setOpenGroup(group.title)}
                >
                  <button
                    type="button"
                    className={`nav-menu-trigger ${groupIsActive ? 'active' : ''}`}
                    aria-expanded={openGroup === group.title}
                    aria-controls={menuId}
                    onClick={() => setOpenGroup(openGroup === group.title ? null : group.title)}
                  >
                    {group.title}
                    <svg
                      className="nav-chevron"
                      aria-hidden="true"
                      viewBox="0 0 12 12"
                      focusable="false"
                    >
                      <path d="m3 4.5 3 3 3-3" />
                    </svg>
                  </button>
                  <div className="nav-dropdown" id={menuId} aria-label={`${group.title} pages`}>
                    {group.items.map((item) => (
                      <a
                        key={item.page}
                        href={item.hash}
                        className={`nav-dropdown-link ${currentPage === item.page || (item.page === 'documents' && currentPage.startsWith('document')) ? 'active' : ''}`}
                        onClick={() => setOpenGroup(null)}
                      >
                        <span className="nav-icon" aria-hidden="true">
                          {item.icon}
                        </span>
                        <span>{item.label}</span>
                        {item.page === 'incidents' && (
                          <span className="nav-count" id="incident-nav-count" />
                        )}
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>
          <form className="global-search" onSubmit={submitSearch}>
            <span>⌕</span>
            <input
              aria-label="Search incidents and knowledge"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>⌘ K</kbd>
          </form>
          <div className="topbar-actions">
            <span
              className={`system-state ${health?.status === 'ready' ? 'status-ready' : health ? 'status-degraded' : 'status-unknown'}`}
            >
              <i />{' '}
              {health?.status === 'ready' ? 'API READY' : health ? 'API DEGRADED' : 'CHECKING API'}
            </span>
            {onLogout && (
              <button
                type="button"
                className="signout-button"
                onClick={onLogout}
                title="Sign out"
                aria-label="Sign out"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
                  <path d="M6.5 2.5h-3A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5h3" />
                  <path d="M8 11.5 11.5 8 8 4.5M11 8H5.5" />
                </svg>
                <span>Sign out</span>
              </button>
            )}
          </div>
        </header>
        <div className="page-content">{children}</div>
        <footer className="app-footer">
          <span>INCIDENT OPERATIONS</span>
          <span>
            <i
              className={
                health?.status === 'ready'
                  ? 'status-ready'
                  : health
                    ? 'status-degraded'
                    : 'status-unknown'
              }
            />{' '}
            {health?.status === 'ready'
              ? 'API READY'
              : health
                ? 'API DEGRADED'
                : 'API STATUS UNKNOWN'}{' '}
            · <a href="#/sources">SOURCE SETTINGS</a>
          </span>
        </footer>
      </main>
    </div>
  );
}
