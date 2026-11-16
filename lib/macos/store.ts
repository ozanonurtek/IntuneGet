/**
 * SQLite persistence for the macOS module.
 *
 * The tables are fork-only state: they are created here with
 * CREATE TABLE IF NOT EXISTS on first use instead of through upstream's
 * numbered migrations (same idea as lib/db/sqlite-selfhost-once.ts), so the
 * daily upstream merge never conflicts with them.
 *
 * Always uses the process-wide connection from lib/db/sqlite: the database can
 * sit on an SMB share mounted without byte-range locks, where a second
 * better-sqlite3 connection in the same process is unsafe.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type {
  MacosAssignment,
  MacosCatalogApp,
  MacosJob,
  MacosJobMode,
  MacosJobStatus,
} from './types';
import { MACOS_ACTIVE_JOB_STATUSES } from './types';

export const INTERRUPTED_JOB_MESSAGE = 'Interrupted by an application restart; deploy again.';

interface StoreState {
  override: BetterSqlite3.Database | null;
  initialised: WeakSet<BetterSqlite3.Database>;
}

// Kept on globalThis so every route bundle shares one view of the init state.
const STATE_KEY = Symbol.for('intuneget.macos.store');
function state(): StoreState {
  const g = globalThis as unknown as Record<symbol, StoreState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { override: null, initialised: new WeakSet() };
  return g[STATE_KEY]!;
}

/** Tests inject an in-memory database; pass null to restore the default. */
export function setMacosDatabaseForTests(db: BetterSqlite3.Database | null): void {
  state().override = db;
}

function connection(): BetterSqlite3.Database {
  const s = state();
  if (s.override) return s.override;
  const { getSqliteConnection } = require('../db/sqlite') as typeof import('../db/sqlite');
  return getSqliteConnection();
}

/** The connection with the module's schema applied (once per connection). */
export function getMacosDb(): BetterSqlite3.Database {
  const db = connection();
  const s = state();
  if (!s.initialised.has(db)) {
    ensureMacosSchema(db);
    s.initialised.add(db);
  }
  return db;
}

export function ensureMacosSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS macos_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      publisher TEXT,
      category TEXT,
      description TEXT,
      homepage TEXT,
      url TEXT NOT NULL,
      file_name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_macos_catalog_bundle ON macos_catalog (bundle_id COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS macos_catalog_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_refreshed_at TEXT,
      app_count INTEGER NOT NULL DEFAULT 0,
      invalid_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS macos_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_email TEXT,
      catalog_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      version TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('new', 'update')),
      intune_app_id TEXT,
      assignments TEXT NOT NULL DEFAULT '[]',
      ignore_version_detection INTEGER,
      status TEXT NOT NULL,
      progress_percent INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_macos_jobs_tenant ON macos_jobs (tenant_id, created_at DESC);
  `);
  // The job queue lives in this process only, so anything not terminal when the
  // schema is first touched belongs to a previous process and can never finish.
  const now = new Date().toISOString();
  const placeholders = MACOS_ACTIVE_JOB_STATUSES.map(() => '?').join(', ');
  db.prepare(
    `UPDATE macos_jobs SET status = 'failed', error_message = ?, updated_at = ?, completed_at = ?
     WHERE status IN (${placeholders})`
  ).run(INTERRUPTED_JOB_MESSAGE, now, now, ...MACOS_ACTIVE_JOB_STATUSES);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface CatalogRow {
  id: string;
  name: string;
  version: string;
  bundle_id: string;
  publisher: string | null;
  category: string | null;
  description: string | null;
  homepage: string | null;
  url: string;
  file_name: string;
  sha256: string;
  fetched_at: string;
}

function catalogFromRow(row: CatalogRow): MacosCatalogApp {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    bundleId: row.bundle_id,
    publisher: row.publisher,
    category: row.category,
    description: row.description,
    homepage: row.homepage,
    url: row.url,
    fileName: row.file_name,
    sha256: row.sha256,
    fetchedAt: row.fetched_at,
  };
}

export interface CatalogUpsert extends Omit<MacosCatalogApp, 'fetchedAt'> {
  rawJson: string;
}

export interface CatalogReplaceResult {
  upserted: number;
  removed: number;
}

/**
 * Upsert the given apps and remove rows whose id is in `removeIds`, then record
 * the refresh in macos_catalog_meta. One transaction.
 */
export function saveCatalogRefresh(
  apps: CatalogUpsert[],
  removeIds: string[],
  meta: { invalidCount: number; lastError: string | null },
  now: string = new Date().toISOString()
): CatalogReplaceResult {
  const db = getMacosDb();
  const upsert = db.prepare(`INSERT INTO macos_catalog
      (id, name, version, bundle_id, publisher, category, description, homepage, url, file_name, sha256, raw_json, fetched_at)
    VALUES (@id, @name, @version, @bundleId, @publisher, @category, @description, @homepage, @url, @fileName, @sha256, @rawJson, @now)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, version = excluded.version, bundle_id = excluded.bundle_id,
      publisher = excluded.publisher, category = excluded.category, description = excluded.description,
      homepage = excluded.homepage, url = excluded.url, file_name = excluded.file_name,
      sha256 = excluded.sha256, raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`);
  const remove = db.prepare('DELETE FROM macos_catalog WHERE id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const app of apps) upsert.run({ ...app, now });
    for (const id of removeIds) removed += remove.run(id).changes;
    const count = (db.prepare('SELECT COUNT(*) AS n FROM macos_catalog').get() as { n: number }).n;
    db.prepare(`INSERT INTO macos_catalog_meta (id, last_refreshed_at, app_count, invalid_count, last_error)
      VALUES (1, @now, @count, @invalid, @error)
      ON CONFLICT(id) DO UPDATE SET last_refreshed_at = excluded.last_refreshed_at,
        app_count = excluded.app_count, invalid_count = excluded.invalid_count, last_error = excluded.last_error`)
      .run({ now, count, invalid: meta.invalidCount, error: meta.lastError });
  })();
  return { upserted: apps.length, removed };
}

/** Record a failed refresh without touching the stored catalog. */
export function saveCatalogRefreshError(message: string): void {
  const db = getMacosDb();
  db.prepare(`INSERT INTO macos_catalog_meta (id, last_error) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error`).run(message);
}

export function getCatalogMeta(): Omit<import('./types').MacosCatalogMeta, 'refreshing'> {
  const db = getMacosDb();
  const row = db.prepare('SELECT * FROM macos_catalog_meta WHERE id = 1').get() as
    | { last_refreshed_at: string | null; app_count: number; invalid_count: number; last_error: string | null }
    | undefined;
  const count = (db.prepare('SELECT COUNT(*) AS n FROM macos_catalog').get() as { n: number }).n;
  return {
    lastRefreshedAt: row?.last_refreshed_at ?? null,
    appCount: count,
    invalidCount: row?.invalid_count ?? 0,
    lastError: row?.last_error ?? null,
  };
}

export function listCatalogIds(): string[] {
  return (getMacosDb().prepare('SELECT id FROM macos_catalog').all() as { id: string }[]).map((r) => r.id);
}

export function getCatalogApp(id: string): MacosCatalogApp | null {
  const row = getMacosDb().prepare('SELECT * FROM macos_catalog WHERE id = ?').get(id) as CatalogRow | undefined;
  return row ? catalogFromRow(row) : null;
}

export function listAllCatalogApps(): MacosCatalogApp[] {
  return (getMacosDb().prepare('SELECT * FROM macos_catalog ORDER BY name COLLATE NOCASE').all() as CatalogRow[]).map(
    catalogFromRow
  );
}

export interface CatalogQuery {
  search?: string;
  category?: string;
  page?: number;
  pageSize?: number;
}

export interface CatalogPage {
  apps: MacosCatalogApp[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function searchCatalog(query: CatalogQuery): CatalogPage {
  const db = getMacosDb();
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize || 50), 1), 200);
  const page = Math.max(Math.trunc(query.page || 1), 1);
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  const search = query.search?.trim();
  if (search) {
    where.push(`(name LIKE @q ESCAPE '\\' OR id LIKE @q ESCAPE '\\' OR publisher LIKE @q ESCAPE '\\' OR bundle_id LIKE @q ESCAPE '\\')`);
    params.q = `%${escapeLike(search)}%`;
  }
  if (query.category) {
    where.push('category = @category');
    params.category = query.category;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM macos_catalog ${clause}`).get(params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM macos_catalog ${clause} ORDER BY name COLLATE NOCASE LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as CatalogRow[];
  const categories = (
    db
      .prepare(`SELECT DISTINCT category FROM macos_catalog WHERE category IS NOT NULL AND category != '' ORDER BY category`)
      .all() as { category: string }[]
  ).map((r) => r.category);
  return { apps: rows.map(catalogFromRow), total, page, pageSize, categories };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  tenant_id: string;
  user_id: string;
  user_email: string | null;
  catalog_id: string;
  app_name: string;
  version: string;
  mode: MacosJobMode;
  intune_app_id: string | null;
  assignments: string;
  ignore_version_detection: number | null;
  status: MacosJobStatus;
  progress_percent: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function jobFromRow(row: JobRow): MacosJob {
  let assignments: MacosAssignment[] = [];
  try {
    const parsed = JSON.parse(row.assignments);
    if (Array.isArray(parsed)) assignments = parsed;
  } catch {
    assignments = [];
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    userEmail: row.user_email,
    catalogId: row.catalog_id,
    appName: row.app_name,
    version: row.version,
    mode: row.mode,
    intuneAppId: row.intune_app_id,
    assignments,
    ignoreVersionDetection: row.ignore_version_detection === null ? null : row.ignore_version_detection === 1,
    status: row.status,
    progressPercent: row.progress_percent,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface NewJobInput {
  tenantId: string;
  userId: string;
  userEmail: string | null;
  catalogId: string;
  appName: string;
  version: string;
  mode: MacosJobMode;
  intuneAppId: string | null;
  assignments: MacosAssignment[];
  ignoreVersionDetection: boolean | null;
}

export class ActiveJobExistsError extends Error {
  constructor(public readonly job: MacosJob) {
    super(`${job.appName} already has a deployment in progress.`);
    this.name = 'ActiveJobExistsError';
  }
}

/**
 * Insert a queued job, refusing (ActiveJobExistsError) when the same catalog
 * app already has a queued or running job for the tenant. Check and insert run
 * in one transaction.
 */
export function insertJob(input: NewJobInput, now: string = new Date().toISOString()): MacosJob {
  const db = getMacosDb();
  const placeholders = MACOS_ACTIVE_JOB_STATUSES.map(() => '?').join(', ');
  return db.transaction(() => {
    const active = db
      .prepare(
        `SELECT * FROM macos_jobs WHERE tenant_id = ? AND catalog_id = ? AND status IN (${placeholders}) LIMIT 1`
      )
      .get(input.tenantId, input.catalogId, ...MACOS_ACTIVE_JOB_STATUSES) as JobRow | undefined;
    if (active) throw new ActiveJobExistsError(jobFromRow(active));
    const id = randomUUID();
    db.prepare(`INSERT INTO macos_jobs (id, tenant_id, user_id, user_email, catalog_id, app_name, version, mode,
        intune_app_id, assignments, ignore_version_detection, status, progress_percent, created_at, updated_at)
      VALUES (@id, @tenantId, @userId, @userEmail, @catalogId, @appName, @version, @mode,
        @intuneAppId, @assignments, @ignore, 'queued', 0, @now, @now)`).run({
      ...input,
      id,
      assignments: JSON.stringify(input.assignments),
      ignore: input.ignoreVersionDetection === null ? null : input.ignoreVersionDetection ? 1 : 0,
      now,
    });
    return jobFromRow(db.prepare('SELECT * FROM macos_jobs WHERE id = ?').get(id) as JobRow);
  })();
}

export interface JobPatch {
  status?: MacosJobStatus;
  progressPercent?: number;
  errorMessage?: string | null;
  intuneAppId?: string | null;
}

export function updateJob(id: string, patch: JobPatch, now: string = new Date().toISOString()): void {
  const sets: string[] = ['updated_at = @now'];
  const params: Record<string, unknown> = { id, now };
  if (patch.status !== undefined) {
    sets.push('status = @status');
    params.status = patch.status;
    if (patch.status === 'completed' || patch.status === 'failed') sets.push('completed_at = @now');
  }
  if (patch.progressPercent !== undefined) {
    sets.push('progress_percent = @progress');
    params.progress = Math.max(0, Math.min(100, Math.round(patch.progressPercent)));
  }
  if (patch.errorMessage !== undefined) {
    sets.push('error_message = @error');
    params.error = patch.errorMessage;
  }
  if (patch.intuneAppId !== undefined) {
    sets.push('intune_app_id = @appId');
    params.appId = patch.intuneAppId;
  }
  getMacosDb().prepare(`UPDATE macos_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function getJob(id: string): MacosJob | null {
  const row = getMacosDb().prepare('SELECT * FROM macos_jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? jobFromRow(row) : null;
}

export function getJobForTenant(id: string, tenantId: string): MacosJob | null {
  const row = getMacosDb().prepare('SELECT * FROM macos_jobs WHERE id = ? AND tenant_id = ?').get(id, tenantId) as
    | JobRow
    | undefined;
  return row ? jobFromRow(row) : null;
}

export function listJobsForTenant(tenantId: string, limit = 50): MacosJob[] {
  return (
    getMacosDb()
      .prepare('SELECT * FROM macos_jobs WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(tenantId, limit) as JobRow[]
  ).map(jobFromRow);
}
