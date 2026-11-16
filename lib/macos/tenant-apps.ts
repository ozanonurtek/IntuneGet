/**
 * The tenant's macOS apps in Intune, matched to the IntuneBrew catalog.
 */

import { compareVersions } from '@/lib/version-compare';
import type { MacosGraphClient } from './graph';
import type { MacosCatalogApp, MacosIntuneAppType, MacosTenantApp } from './types';

const TYPE_BY_ODATA: Record<string, MacosIntuneAppType> = {
  '#microsoft.graph.macOSPkgApp': 'macOSPkgApp',
  '#microsoft.graph.macOSDmgApp': 'macOSDmgApp',
  '#microsoft.graph.macOSLobApp': 'macOSLobApp',
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface IntuneMacApp {
  id: string;
  displayName: string;
  appType: MacosIntuneAppType;
  bundleId: string | null;
  version: string | null;
}

/** Normalise a Graph mobileApp record; null for anything that is not a macOS PKG/DMG/LOB app. */
export function parseIntuneMacApp(raw: Record<string, unknown>): IntuneMacApp | null {
  const appType = TYPE_BY_ODATA[String(raw['@odata.type'] || '')];
  const id = str(raw.id);
  if (!appType || !id) return null;
  const bundleId = appType === 'macOSLobApp' ? str(raw.bundleId) : str(raw.primaryBundleId);
  const version =
    appType === 'macOSLobApp'
      ? str(raw.versionNumber) || str(raw.buildNumber)
      : str(raw.primaryBundleVersion);
  return { id, displayName: str(raw.displayName) || id, appType, bundleId, version };
}

/** Match by bundle id (case-insensitive), falling back to the display name. */
export function matchTenantApps(intuneApps: IntuneMacApp[], catalog: MacosCatalogApp[]): MacosTenantApp[] {
  const byBundle = new Map<string, MacosCatalogApp>();
  const byName = new Map<string, MacosCatalogApp>();
  for (const entry of catalog) {
    const bundle = entry.bundleId.toLowerCase();
    if (!byBundle.has(bundle)) byBundle.set(bundle, entry);
    const name = entry.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, entry);
  }
  return intuneApps
    .map((app) => {
      const match =
        (app.bundleId && byBundle.get(app.bundleId.toLowerCase())) || byName.get(app.displayName.toLowerCase()) || null;
      const updateAvailable = Boolean(
        match && (!app.version || compareVersions(match.version, app.version) > 0)
      );
      return {
        intuneAppId: app.id,
        displayName: app.displayName,
        appType: app.appType,
        bundleId: app.bundleId,
        installedVersion: app.version,
        catalogId: match?.id ?? null,
        catalogName: match?.name ?? null,
        catalogVersion: match?.version ?? null,
        updateAvailable,
        updateSupported: app.appType !== 'macOSLobApp',
      };
    })
    .sort((a, b) => Number(b.updateAvailable) - Number(a.updateAvailable) || a.displayName.localeCompare(b.displayName));
}

export async function listIntuneMacApps(graph: MacosGraphClient): Promise<IntuneMacApp[]> {
  const raw = await graph.listMacApps();
  return raw.map(parseIntuneMacApp).filter((app): app is IntuneMacApp => app !== null);
}
