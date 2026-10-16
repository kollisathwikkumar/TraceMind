import { useCallback, useEffect, useState } from 'react';
import type { AdminApi, Incident, IncidentEvent } from '../api';

const SEVERITIES = ['SEV-1', 'SEV-2', 'SEV-3', 'SEV-4'] as const;
const STATUSES = ['open', 'investigating', 'mitigated', 'resolved'] as const;
const date = (value: string) => new Date(value).toLocaleString();

export function Incidents({ api }: { api: AdminApi }) {
  const [items, setItems] = useState<Incident[]>([]);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [events, setEvents] = useState<IncidentEvent[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Incident['severity']>('SEV-3');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => { setItems(await api.getIncidents()); }, [api]);
  useEffect(() => { void refresh().catch((e: Error) => setError(e.message)); }, [refresh]);
  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    void api.getIncidentEvents(selected.id).then(setEvents).catch((e: Error) => setError(e.message));
  }, [api, selected]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    try {
      const incident = await api.createIncident({ title, description, severity });
      setTitle(''); setDescription(''); setSelected(incident); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create incident'); }
  };
  const update = async (patch: Partial<Pick<Incident, 'status' | 'severity' | 'assignee'>>) => {
    if (!selected) return;
    try { const result = await api.updateIncident(selected.id, patch); setSelected(result); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update incident'); }
  };

  return <section className="incidents-page">
    <header className="incident-heading"><div><p className="eyebrow">OPERATIONS</p><h1 className="page-title">Incidents</h1><p className="muted">Create, assign, investigate, and resolve incidents with a persistent timeline.</p></div><span className="incident-count">{items.length} total</span></header>
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="incident-workspace">
      <div className="incident-column">
        <form className="incident-create card" onSubmit={create}>
          <h2 className="section-title">New incident</h2>
          <input className="input" required maxLength={180} placeholder="Incident title" value={title} onChange={e => setTitle(e.target.value)} />
          <textarea className="input" rows={3} maxLength={4000} placeholder="What is happening?" value={description} onChange={e => setDescription(e.target.value)} />
          <div className="create-row"><select className="input" value={severity} onChange={e => setSeverity(e.target.value as Incident['severity'])}>{SEVERITIES.map(s => <option key={s}>{s}</option>)}</select><button className="btn btn-primary" type="submit">Create incident</button></div>
        </form>
        <div className="incident-list card" aria-label="Incident list">
          <div className="list-heading"><h2 className="section-title">Active & recent</h2><button className="btn btn-ghost" onClick={() => void refresh()}>Refresh</button></div>
          {items.length === 0 ? <p className="empty-state">No incidents yet. Create one to start the timeline.</p> : items.map(item => <button key={item.id} className={`incident-row ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => setSelected(item)}>
            <span className={`severity-dot ${item.severity.toLowerCase()}`} /><span className="incident-row-copy"><strong>{item.title}</strong><small>{item.assignee || 'Unassigned'} · {date(item.updatedAt)}</small></span><span className={`status-pill ${item.status}`}>{item.status}</span>
          </button>)}
        </div>
      </div>
      <div className="incident-detail card">
        {!selected ? <div className="empty-state detail-empty"><span className="detail-icon">◎</span><h2>Select an incident</h2><p>Updates and investigation events will appear here.</p></div> : <>
          <div className="detail-header"><div><span className={`status-pill ${selected.status}`}>{selected.status}</span><span className={`severity-label ${selected.severity.toLowerCase()}`}>{selected.severity}</span><h2>{selected.title}</h2></div></div>
          <p className="incident-description">{selected.description || 'No description provided.'}</p>
          <div className="incident-controls"><label>Owner<input className="input" aria-label="Assignee" placeholder="Unassigned" defaultValue={selected.assignee || ''} onBlur={e => { const value = e.target.value.trim() || null; if (value !== selected.assignee) void update({ assignee: value }); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label><label>Severity<select className="input" value={selected.severity} onChange={e => void update({ severity: e.target.value as Incident['severity'] })}>{SEVERITIES.map(s => <option key={s}>{s}</option>)}</select></label><label>Status<select className="input" value={selected.status} onChange={e => void update({ status: e.target.value as Incident['status'] })}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></label></div>
          <div className="timeline-heading"><h3>Timeline</h3><span>Created {date(selected.createdAt)}</span></div>
          <ol className="incident-timeline">{events.map(event => <li key={event.id}><span className="timeline-marker"/><div><strong>{event.detail}</strong><p>{event.actor} · {date(event.createdAt)}</p></div></li>)}</ol>
        </>}
      </div>
    </div>
  </section>;
}
