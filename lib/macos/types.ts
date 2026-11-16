/**
 * Shared types for the macOS (IntuneBrew catalog) module of the self-hosted fork.
 * Kept free of server-only imports so client components can use them.
 */

export type MacosAssignmentIntent = 'required' | 'available' | 'uninstall';

export interface MacosAssignment {
  groupId: string;
  groupName: string;
  intent: MacosAssignmentIntent;
}

export interface MacosCatalogApp {
  id: string;
  name: string;
  version: string;
  bundleId: string;
  publisher: string | null;
  category: string | null;
  description: string | null;
  homepage: string | null;
  url: string;
  fileName: string;
  sha256: string;
  fetchedAt: string;
}

/** Prefix of custom app ids; IntuneBrew ids never start with it (see validateManifest). */
export const MACOS_CUSTOM_ID_PREFIX = 'custom-';

export function isCustomAppId(id: string): boolean {
  return id.startsWith(MACOS_CUSTOM_ID_PREFIX);
}

/** An app an admin defined for one tenant, outside the IntuneBrew catalog. */
export interface MacosCustomApp {
  id: string;
  tenantId: string;
  name: string;
  publisher: string;
  version: string;
  bundleId: string;
  url: string;
  fileName: string;
  sha256: string;
  description: string | null;
  homepage: string | null;
  iconUrl: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The uploader's view of a custom app. */
export function customAppToCatalogApp(app: MacosCustomApp): MacosCatalogApp {
  return {
    id: app.id,
    name: app.name,
    version: app.version,
    bundleId: app.bundleId,
    publisher: app.publisher,
    category: null,
    description: app.description,
    homepage: app.homepage,
    url: app.url,
    fileName: app.fileName,
    sha256: app.sha256,
    fetchedAt: app.updatedAt,
  };
}

export interface MacosCatalogMeta {
  lastRefreshedAt: string | null;
  appCount: number;
  invalidCount: number;
  lastError: string | null;
  refreshing: boolean;
}

export type MacosJobMode = 'new' | 'update';

export type MacosJobStatus =
  | 'queued'
  | 'downloading'
  | 'uploading'
  | 'committing'
  | 'assigning'
  | 'completed'
  | 'failed';

export const MACOS_ACTIVE_JOB_STATUSES: readonly MacosJobStatus[] = [
  'queued',
  'downloading',
  'uploading',
  'committing',
  'assigning',
];

export interface MacosJob {
  id: string;
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
  status: MacosJobStatus;
  progressPercent: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type MacosIntuneAppType = 'macOSPkgApp' | 'macOSDmgApp' | 'macOSLobApp';

export interface MacosTenantApp {
  intuneAppId: string;
  displayName: string;
  appType: MacosIntuneAppType;
  bundleId: string | null;
  installedVersion: string | null;
  catalogId: string | null;
  catalogName: string | null;
  catalogVersion: string | null;
  /** The match is one of the tenant's custom apps, not an IntuneBrew entry. */
  catalogCustom: boolean;
  updateAvailable: boolean;
  /** PKG/DMG apps can take a new content version; LOB apps cannot. */
  updateSupported: boolean;
}
