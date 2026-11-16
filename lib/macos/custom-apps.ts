/**
 * Custom macOS apps: PKG/DMG installers an admin defines for one tenant,
 * outside the IntuneBrew catalog. Stored in macos_custom_apps (created by
 * ensureMacosSchema); catalog refreshes never touch the table.
 */

import { randomUUID } from 'crypto';
import { getActiveJobForApp, getCatalogApp, getMacosDb } from './store';
import type { MacosCatalogApp, MacosCustomApp, MacosJob } from './types';
import { MACOS_CUSTOM_ID_PREFIX, customAppToCatalogApp, isCustomAppId } from './types';
import { fileNameFromInstallerUrl, type MacosCustomAppInput } from './validators';

export const CUSTOM_APP_ID_PATTERN = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CustomAppRow {
  id: string;
  tenant_id: string;
  name: string;
  publisher: string;
  version: string;
  bundle_id: string;
  url: string;
  file_name: string;
  sha256: string;
  description: string | null;
  homepage: string | null;
  icon_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: CustomAppRow): MacosCustomApp {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    publisher: row.publisher,
    version: row.version,
    bundleId: row.bundle_id,
    url: row.url,
    fileName: row.file_name,
    sha256: row.sha256,
    description: row.description,
    homepage: row.homepage,
    iconUrl: row.icon_url,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DuplicateBundleIdError extends Error {
  constructor(bundleId: string) {
    super(`A custom app with bundle ID ${bundleId} already exists for this tenant.`);
    this.name = 'DuplicateBundleIdError';
  }
}

export class CustomAppBusyError extends Error {
  constructor(public readonly job: MacosJob) {
    super(`${job.appName} has a deployment in progress; wait for it to finish.`);
    this.name = 'CustomAppBusyError';
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function listCustomApps(tenantId: string, search?: string): MacosCustomApp[] {
  const q = search?.trim();
  const db = getMacosDb();
  const rows = q
    ? (db
        .prepare(
          `SELECT * FROM macos_custom_apps WHERE tenant_id = @tenantId AND
             (name LIKE @q ESCAPE '\\' OR publisher LIKE @q ESCAPE '\\' OR bundle_id LIKE @q ESCAPE '\\')
           ORDER BY name COLLATE NOCASE`
        )
        .all({ tenantId, q: `%${escapeLike(q)}%` }) as CustomAppRow[])
    : (db
        .prepare('SELECT * FROM macos_custom_apps WHERE tenant_id = ? ORDER BY name COLLATE NOCASE')
        .all(tenantId) as CustomAppRow[]);
  return rows.map(fromRow);
}

export function getCustomApp(id: string, tenantId: string): MacosCustomApp | null {
  const row = getMacosDb()
    .prepare('SELECT * FROM macos_custom_apps WHERE id = ? AND tenant_id = ?')
    .get(id, tenantId) as CustomAppRow | undefined;
  return row ? fromRow(row) : null;
}

/** Unscoped lookup for the icon proxy, which carries no bearer token. */
export function getCustomAppIconUrl(id: string): string | null {
  const row = getMacosDb().prepare('SELECT icon_url FROM macos_custom_apps WHERE id = ?').get(id) as
    | { icon_url: string | null }
    | undefined;
  return row?.icon_url ?? null;
}

function bundleTaken(tenantId: string, bundleId: string, exceptId: string | null): boolean {
  return Boolean(
    getMacosDb()
      .prepare(
        'SELECT 1 FROM macos_custom_apps WHERE tenant_id = ? AND bundle_id = ? COLLATE NOCASE AND id != ? LIMIT 1'
      )
      .get(tenantId, bundleId, exceptId ?? '')
  );
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE');
}

function columns(input: MacosCustomAppInput) {
  return {
    name: input.name,
    publisher: input.publisher,
    version: input.version,
    bundleId: input.bundleId,
    url: input.url,
    fileName: fileNameFromInstallerUrl(input.url),
    sha256: input.sha256.toLowerCase(),
    description: input.description ?? null,
    homepage: input.homepage ?? null,
    iconUrl: input.iconUrl ?? null,
  };
}

export function createCustomApp(
  tenantId: string,
  createdBy: string,
  input: MacosCustomAppInput,
  now: string = new Date().toISOString()
): MacosCustomApp {
  const db = getMacosDb();
  const id = `${MACOS_CUSTOM_ID_PREFIX}${randomUUID()}`;
  try {
    db.transaction(() => {
      if (bundleTaken(tenantId, input.bundleId, null)) throw new DuplicateBundleIdError(input.bundleId);
      db.prepare(`INSERT INTO macos_custom_apps
          (id, tenant_id, name, publisher, version, bundle_id, url, file_name, sha256, description, homepage, icon_url,
           created_by, created_at, updated_at)
        VALUES (@id, @tenantId, @name, @publisher, @version, @bundleId, @url, @fileName, @sha256, @description, @homepage,
          @iconUrl, @createdBy, @now, @now)`).run({ ...columns(input), id, tenantId, createdBy, now });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateBundleIdError(input.bundleId);
    throw error;
  }
  return getCustomApp(id, tenantId)!;
}

/**
 * Replace a custom app's fields. Null when the id is not the tenant's.
 * Refused (CustomAppBusyError) while a job for the app is queued or running,
 * since the job reads the app's URL and hash when it starts.
 */
export function updateCustomApp(
  id: string,
  tenantId: string,
  input: MacosCustomAppInput,
  now: string = new Date().toISOString()
): MacosCustomApp | null {
  const db = getMacosDb();
  try {
    const found = db.transaction(() => {
      if (!getCustomApp(id, tenantId)) return false;
      const active = getActiveJobForApp(tenantId, id);
      if (active) throw new CustomAppBusyError(active);
      if (bundleTaken(tenantId, input.bundleId, id)) throw new DuplicateBundleIdError(input.bundleId);
      db.prepare(`UPDATE macos_custom_apps SET name = @name, publisher = @publisher, version = @version,
          bundle_id = @bundleId, url = @url, file_name = @fileName, sha256 = @sha256, description = @description,
          homepage = @homepage, icon_url = @iconUrl, updated_at = @now
        WHERE id = @id AND tenant_id = @tenantId`).run({ ...columns(input), id, tenantId, now });
      return true;
    })();
    return found ? getCustomApp(id, tenantId) : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateBundleIdError(input.bundleId);
    throw error;
  }
}

/** False when the id is not the tenant's; CustomAppBusyError while a job is active. */
export function deleteCustomApp(id: string, tenantId: string): boolean {
  const db = getMacosDb();
  return db.transaction(() => {
    if (!getCustomApp(id, tenantId)) return false;
    const active = getActiveJobForApp(tenantId, id);
    if (active) throw new CustomAppBusyError(active);
    db.prepare('DELETE FROM macos_custom_apps WHERE id = ? AND tenant_id = ?').run(id, tenantId);
    return true;
  })();
}

export interface DeployableApp {
  app: MacosCatalogApp;
  custom: boolean;
  /** Logo to set on a new Intune app. */
  logoUrl: string | null;
}

/**
 * Resolve a job's catalogId: custom ids from macos_custom_apps scoped to the
 * tenant, anything else from the IntuneBrew catalog. Null when not found.
 */
export function resolveDeployableApp(
  catalogId: string,
  tenantId: string,
  catalogLogoUrl: (id: string) => string
): DeployableApp | null {
  if (isCustomAppId(catalogId)) {
    const custom = getCustomApp(catalogId, tenantId);
    return custom ? { app: customAppToCatalogApp(custom), custom: true, logoUrl: custom.iconUrl } : null;
  }
  const app = getCatalogApp(catalogId);
  return app ? { app, custom: false, logoUrl: catalogLogoUrl(app.id) } : null;
}
