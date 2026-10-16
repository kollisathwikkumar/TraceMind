import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type IncidentSeverity = 'SEV-1' | 'SEV-2' | 'SEV-3' | 'SEV-4';
export type IncidentStatus = 'open' | 'investigating' | 'mitigated' | 'resolved';
const ALLOWED_INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['investigating', 'resolved'],
  investigating: ['open', 'mitigated', 'resolved'],
  mitigated: ['investigating', 'resolved'],
  resolved: ['open'],
};
export function assertIncidentTransition(from: IncidentStatus, to: IncidentStatus): void {
  if (from !== to && !ALLOWED_INCIDENT_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid incident status transition: ${from} -> ${to}`);
  }
}
export type Awaitable<T> = T | Promise<T>;
export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface IncidentEvent {
  id: number;
  incidentId: string;
  action: string;
  detail: string;
  actor: string;
  createdAt: string;
}
export type IncidentInput = {
  title: string;
  description?: string;
  severity: IncidentSeverity;
  assignee?: string | null;
};
export type IncidentPatch = Partial<
  Pick<Incident, 'title' | 'description' | 'severity' | 'status' | 'assignee'>
>;

/** Persistence contract shared by the local SQLite and hosted PostgreSQL adapters. */
export interface IncidentRepository {
  checkHealth(): Awaitable<void>;
  list(): Awaitable<Incident[]>;
  get(id: string): Awaitable<Incident | undefined>;
  events(id: string): Awaitable<IncidentEvent[]>;
  create(input: IncidentInput, actor?: string): Awaitable<Incident>;
  update(id: string, patch: IncidentPatch, actor: string): Awaitable<Incident | undefined>;
  close(): Awaitable<void>;
}

export class IncidentStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        severity TEXT NOT NULL CHECK(severity IN ('SEV-1','SEV-2','SEV-3','SEV-4')),
        status TEXT NOT NULL CHECK(status IN ('open','investigating','mitigated','resolved')),
        assignee TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incident_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL REFERENCES incidents(id),
        action TEXT NOT NULL, detail TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incident_events_incident_id ON incident_events(incident_id, id);
    `);
  }
  checkHealth(): void {
    this.db.prepare('SELECT 1').get();
  }
  list(): Incident[] {
    return (this.db.prepare('SELECT * FROM incidents ORDER BY updated_at DESC').all() as Row[]).map(
      mapIncident
    );
  }
  get(id: string): Incident | undefined {
    const row = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Row | undefined;
    return row ? mapIncident(row) : undefined;
  }
  events(id: string): IncidentEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM incident_events WHERE incident_id = ? ORDER BY id')
        .all(id) as EventRow[]
    ).map(mapEvent);
  }
  create(input: IncidentInput, actor = 'system'): Incident {
    const now = new Date().toISOString();
    const incident: Incident = {
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description?.trim() || '',
      severity: input.severity,
      status: 'open',
      assignee: input.assignee?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    const transaction = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          incident.id,
          incident.title,
          incident.description,
          incident.severity,
          incident.status,
          incident.assignee,
          incident.createdAt,
          incident.updatedAt
        );
      this.addEvent(incident.id, 'created', `Created ${incident.severity} incident`, actor, now);
      if (incident.assignee)
        this.addEvent(
          incident.id,
          'assignee_changed',
          `Assigned to ${incident.assignee}`,
          actor,
          now
        );
    });
    transaction();
    return incident;
  }
  update(id: string, patch: IncidentPatch, actor: string): Incident | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = {
      ...current,
      ...patch,
      assignee: patch.assignee === undefined ? current.assignee : patch.assignee?.trim() || null,
    };
    assertIncidentTransition(current.status, next.status);
    const now = new Date().toISOString();
    const fields: Array<keyof IncidentPatch> = [
      'title',
      'description',
      'severity',
      'status',
      'assignee',
    ];
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE incidents SET title=?, description=?, severity=?, status=?, assignee=?, updated_at=? WHERE id=?'
        )
        .run(
          next.title.trim(),
          next.description,
          next.severity,
          next.status,
          next.assignee,
          now,
          id
        );
      for (const field of fields) {
        if (next[field] !== current[field]) {
          const action =
            field === 'status'
              ? 'status_changed'
              : field === 'assignee'
                ? 'assignee_changed'
                : `${field}_changed`;
          const value = next[field] || '(unassigned)';
          this.addEvent(id, action, `${field} changed to ${value}`, actor, now);
        }
      }
    });
    transaction();
    return this.get(id);
  }
  close(): void {
    this.db.close();
  }
  private addEvent(
    incidentId: string,
    action: string,
    detail: string,
    actor: string,
    at: string
  ): void {
    this.db
      .prepare(
        'INSERT INTO incident_events (incident_id, action, detail, actor, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(incidentId, action, detail, actor, at);
  }
}
type Row = {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignee: string | null;
  created_at: string;
  updated_at: string;
};
type EventRow = {
  id: number;
  incident_id: string;
  action: string;
  detail: string;
  actor: string;
  created_at: string;
};
function mapIncident(row: Row): Incident {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    assignee: row.assignee,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapEvent(row: EventRow): IncidentEvent {
  return {
    id: row.id,
    incidentId: row.incident_id,
    action: row.action,
    detail: row.detail,
    actor: row.actor,
    createdAt: row.created_at,
  };
}
