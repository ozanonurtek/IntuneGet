import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runSqliteMigrations } from './sqlite-migrations';
import { runSelfHostOnceTasks, SELFHOST_QA_HOLD_CANCELLED_BY } from './sqlite-selfhost-once';

function seed(db: Database.Database, id: string, status: string) {
  db.prepare(`INSERT INTO packaging_jobs (id, user_id, winget_id, version, display_name, installer_type, installer_url, status)
    VALUES (?, 'u', 'Vendor.App', '1.0', 'App', 'msi', 'https://example.test/a.msi', ?)`).run(id, status);
}

describe('runSelfHostOnceTasks', () => {
  it('cancels QA-held jobs once and leaves every other job alone', () => {
    const db = new Database(':memory:');
    runSqliteMigrations(db);
    seed(db, 'held', 'awaiting_qa');
    seed(db, 'upstream', 'blocked_upstream');
    seed(db, 'queued', 'queued');
    seed(db, 'done', 'deployed');

    expect(runSelfHostOnceTasks(db, undefined, () => '2026-11-03T00:00:00.000Z')).toEqual(['2026-11-03-cancel-qa-held-jobs']);
    const rows = Object.fromEntries((db.prepare('SELECT id, status, cancelled_by, cancelled_at FROM packaging_jobs').all() as
      { id: string; status: string; cancelled_by: string | null; cancelled_at: string | null }[]).map(row => [row.id, row]));
    expect(rows.held).toMatchObject({ status: 'cancelled', cancelled_by: SELFHOST_QA_HOLD_CANCELLED_BY, cancelled_at: '2026-11-03T00:00:00.000Z' });
    expect(rows.upstream.status).toBe('cancelled');
    expect(rows.queued).toMatchObject({ status: 'queued', cancelled_by: null });
    expect(rows.done.status).toBe('deployed');

    // A job held later (gate re-enabled) is not touched by a second start.
    seed(db, 'later', 'awaiting_qa');
    expect(runSelfHostOnceTasks(db)).toEqual([]);
    expect((db.prepare("SELECT status FROM packaging_jobs WHERE id = 'later'").get() as { status: string }).status).toBe('awaiting_qa');
  });
});
