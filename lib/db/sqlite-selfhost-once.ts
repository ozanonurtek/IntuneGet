import type BetterSqlite3 from 'better-sqlite3';

/**
 * One-time data tasks for the SQLite self-host fork. They are tracked in their
 * own table instead of PRAGMA user_version so that upstream's numbered schema
 * migrations never collide with fork-only steps.
 */
export interface SelfHostOnceTask {
  name: string;
  run: (db: BetterSqlite3.Database, now: string) => void;
}

export const SELFHOST_QA_HOLD_CANCELLED_BY = 'system:selfhost-qa-gate-bypass';

export const SELFHOST_ONCE_TASKS: SelfHostOnceTask[] = [
  {
    // Jobs held by the QA/reputation gate before it was bypassed would never
    // resume (the resume cron is Supabase-only). Cancel them once; users
    // redeploy and the job packages straight away.
    name: '2026-11-03-cancel-qa-held-jobs',
    run: (db, now) => {
      db.prepare(`UPDATE packaging_jobs
        SET status = 'cancelled', cancelled_at = @now, cancelled_by = @by, updated_at = @now,
            error_message = 'Cancelled when installation validation was disabled for this self-hosted instance. Deploy the app again to package it.'
        WHERE status IN ('awaiting_qa', 'blocked_upstream')`).run({ now, by: SELFHOST_QA_HOLD_CANCELLED_BY });
    },
  },
];

/** Run every task not yet recorded; each task and its record share one transaction. */
export function runSelfHostOnceTasks(
  db: BetterSqlite3.Database,
  tasks: SelfHostOnceTask[] = SELFHOST_ONCE_TASKS,
  now: () => string = () => new Date().toISOString()
): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS selfhost_once_tasks (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set((db.prepare('SELECT name FROM selfhost_once_tasks').all() as { name: string }[]).map(row => row.name));
  const applied: string[] = [];
  for (const task of tasks) {
    if (done.has(task.name)) continue;
    db.transaction(() => {
      const at = now();
      task.run(db, at);
      db.prepare('INSERT INTO selfhost_once_tasks (name, applied_at) VALUES (?, ?)').run(task.name, at);
    })();
    applied.push(task.name);
  }
  return applied;
}
