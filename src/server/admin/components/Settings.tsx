import { useCallback, useEffect, useState } from 'react';
import type { AdminApi, ProviderKeyStatus } from '../api';

export function Settings({ api }: { api: AdminApi }) {
  const [status, setStatus] = useState<ProviderKeyStatus | null>(null);
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setStatus(await api.getProviderKeyStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load API key settings');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const updated = await api.saveProviderKey(provider, apiKey.trim());
      setStatus(updated);
      setApiKey('');
      setNotice('API key saved securely. The secret is not shown again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save API key');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.deleteProviderKey();
      setStatus({ configured: false });
      setNotice('Saved API key removed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove API key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Manage the model provider credential for your account.</p>
      <div className="settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>Provider API key</h2>
            <p>Your key is sent directly to TraceMind and is never displayed after saving.</p>
          </div>
          {!loading && (
            <span className={`auth-badge ${status?.configured ? 'auth-configured' : 'auth-missing'}`}>
              {status?.configured ? 'Configured' : 'Not configured'}
            </span>
          )}
        </div>
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="settings-notice" role="status">{notice}</div>}
        {loading ? (
          <div className="loading">Loading settings…</div>
        ) : (
          <>
            {status?.updatedAt && (
              <p className="settings-updated">Last updated {new Date(status.updatedAt).toLocaleString()}</p>
            )}
            <form className="settings-form" onSubmit={save}>
              <label className="form-label">
                Provider
                <select className="select" value={provider} onChange={(event) => setProvider(event.target.value)}>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google AI</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
              <label className="form-label">
                {status?.configured ? 'Replace API key' : 'API key'}
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={status?.configured ? 'Enter a new key to replace the saved key' : 'Paste your provider API key'}
                  required
                />
              </label>
              <div className="form-actions">
                <button className="btn btn-primary" type="submit" disabled={saving || !apiKey.trim()}>
                  {saving ? 'Saving…' : 'Save API key'}
                </button>
                {status?.configured && (
                  <button className="btn btn-secondary" type="button" onClick={remove} disabled={saving}>
                    Remove key
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
