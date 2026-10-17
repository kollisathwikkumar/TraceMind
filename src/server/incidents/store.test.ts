import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IncidentStore } from './store';

const dirs: string[] = [];
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tracemind-incidents-'));
  dirs.push(dir);
  return new IncidentStore(join(dir, 'incidents.sqlite'));
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('IncidentStore', () => {
  it('persists incident creation and an audit timeline across reopen', () => {
    const store = makeStore();
    const incident = store.create({ title: 'API latency', severity: 'SEV-1', assignee: 'SRE' });
    store.close();
    const reopened = new IncidentStore(join(dirs[0], 'incidents.sqlite'));
    expect(reopened.list()).toMatchObject([{ id: incident.id, title: 'API latency', status: 'open' }]);
    expect(reopened.events(incident.id)[0]).toMatchObject({ action: 'created', actor: 'system' });
    reopened.close();
  });

  it('records field changes as events and rejects invalid transitions', () => {
    const store = makeStore();
    const incident = store.create({ title: 'DB pool exhausted', severity: 'SEV-2' });
    const changed = store.update(incident.id, { status: 'investigating', assignee: 'on-call' }, 'operator');
    expect(changed).toMatchObject({ status: 'investigating', assignee: 'on-call' });
    expect(store.events(incident.id).map((event) => event.action)).toEqual([
      'created', 'status_changed', 'assignee_changed',
    ]);
    expect(() => store.update(incident.id, { severity: 'urgent' as never }, 'operator')).toThrow();
    store.close();
  });

  it('isolates incident rows, updates, and events by tenant', () => {
    const store = makeStore();
    const incident = store.create({ title: 'Tenant A only', severity: 'SEV-2' }, 'operator-a', 'org-a');
    expect(store.get(incident.id, 'org-b')).toBeUndefined();
    expect(store.list('org-b')).toEqual([]);
    expect(store.events(incident.id, 'org-b')).toEqual([]);
    expect(store.update(incident.id, { title: 'overwritten' }, 'operator-b', 'org-b')).toBeUndefined();
    expect(store.get(incident.id, 'org-a')?.title).toBe('Tenant A only');
    expect(store.events(incident.id, 'org-a')).toHaveLength(1);
  });
});
