/**
 * IntuneBrew macOS catalog: fetch, validate and cache in SQLite.
 *
 * Source: https://github.com/ugurkocde/IntuneBrew. `supported_apps.json` maps a
 * catalog id to its manifest (`Apps/<id>.json`); logos live at `Logos/<id>.png`.
 * Manifest URLs are always rebuilt from the configured base and the id, so the
 * ref in MACOS_CATALOG_REF applies to manifests and logos alike and the index
 * cannot point the server at an arbitrary host.
 */

import type { MacosCatalogMeta } from './types';
import {
  getCatalogMeta,
  listCatalogIds,
  saveCatalogRefresh,
  saveCatalogRefreshError,
  searchCatalog,
  type CatalogPage,
  type CatalogQuery,
  type CatalogUpsert,
} from './store';

export const CATALOG_STALE_MS = 12 * 60 * 60 * 1000;
const MANIFEST_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20_000;

export const CATALOG_ID_PATTERN = /^[a-z0-9_-]+$/;

export function getCatalogBaseUrl(): string {
  const ref = (process.env.MACOS_CATALOG_REF || 'main').trim() || 'main';
  return `https://raw.githubusercontent.com/ugurkocde/IntuneBrew/${encodeURIComponent(ref)}/`;
}

export function manifestUrl(id: string): string {
  return `${getCatalogBaseUrl()}Apps/${id}.json`;
}

export function logoUrl(id: string): string {
  return `${getCatalogBaseUrl()}Logos/${id}.png`;
}

export type ManifestValidation =
  | { kind: 'valid'; app: CatalogUpsert }
  | { kind: 'deprecated' }
  | { kind: 'invalid'; reason: string };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  return nonEmptyString(value);
}

/** Validate one manifest. Exported for tests. */
export function validateManifest(id: string, manifest: unknown): ManifestValidation {
  if (!CATALOG_ID_PATTERN.test(id)) return { kind: 'invalid', reason: 'catalog id has unsupported characters' };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { kind: 'invalid', reason: 'manifest is not an object' };
  }
  const m = manifest as Record<string, unknown>;
  if (m.deprecated === true) return { kind: 'deprecated' };

  const name = nonEmptyString(m.name);
  const version = nonEmptyString(m.version);
  const bundleId = nonEmptyString(m.bundleId);
  const fileName = nonEmptyString(m.fileName);
  const url = nonEmptyString(m.url);
  const sha = nonEmptyString(m.sha);
  if (!name || !version || !bundleId) return { kind: 'invalid', reason: 'name, version or bundleId missing' };
  if (!fileName || !/\.(pkg|dmg)$/i.test(fileName) || /[\\/]/.test(fileName)) {
    return { kind: 'invalid', reason: 'fileName is not a .pkg or .dmg' };
  }
  if (!sha || !/^[0-9a-f]{64}$/i.test(sha)) return { kind: 'invalid', reason: 'sha is not a SHA-256 hex digest' };
  if (!url) return { kind: 'invalid', reason: 'url missing' };
  try {
    if (new URL(url).protocol !== 'https:') return { kind: 'invalid', reason: 'url is not https' };
  } catch {
    return { kind: 'invalid', reason: 'url is not valid' };
  }
  let homepage = optionalString(m.homepage);
  if (homepage) {
    try {
      const protocol = new URL(homepage).protocol;
      if (protocol !== 'https:' && protocol !== 'http:') homepage = null;
    } catch {
      homepage = null;
    }
  }

  return {
    kind: 'valid',
    app: {
      id,
      name,
      version,
      bundleId,
      publisher: optionalString(m.publisher),
      category: optionalString(m.category),
      description: optionalString(m.description),
      homepage,
      url,
      fileName,
      sha256: sha.toLowerCase(),
      rawJson: JSON.stringify(manifest),
    },
  };
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

export interface CatalogRefreshResult {
  appCount: number;
  invalidCount: number;
  deprecatedCount: number;
  fetchFailures: number;
  removed: number;
}

/**
 * Fetch the index and every manifest, validate and store them.
 * Manifests that could not be fetched keep their stored row; ids that left the
 * index, turned deprecated or no longer validate are removed.
 */
export async function refreshCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogRefreshResult> {
  let index: unknown;
  try {
    index = await fetchJson(`${getCatalogBaseUrl()}supported_apps.json`, fetchImpl);
  } catch (error) {
    const message = `Could not fetch the IntuneBrew catalog index: ${error instanceof Error ? error.message : String(error)}`;
    saveCatalogRefreshError(message);
    throw new Error(message);
  }
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    const message = 'The IntuneBrew catalog index is not a JSON object.';
    saveCatalogRefreshError(message);
    throw new Error(message);
  }

  const ids = Object.keys(index as Record<string, unknown>);
  const valid: CatalogUpsert[] = [];
  const drop = new Set<string>();
  let invalidCount = 0;
  let deprecatedCount = 0;
  let fetchFailures = 0;

  await mapWithConcurrency(ids, MANIFEST_CONCURRENCY, async (id) => {
    if (!CATALOG_ID_PATTERN.test(id)) {
      invalidCount++;
      return;
    }
    let manifest: unknown;
    try {
      manifest = await fetchJson(manifestUrl(id), fetchImpl);
    } catch {
      fetchFailures++;
      return;
    }
    const result = validateManifest(id, manifest);
    if (result.kind === 'valid') valid.push(result.app);
    else {
      drop.add(id);
      if (result.kind === 'deprecated') deprecatedCount++;
      else invalidCount++;
    }
  });

  const indexed = new Set(ids);
  for (const stored of listCatalogIds()) {
    if (!indexed.has(stored)) drop.add(stored);
  }

  const lastError = fetchFailures > 0 ? `${fetchFailures} manifest(s) could not be fetched; their previous entries were kept.` : null;
  const saved = saveCatalogRefresh(valid, [...drop], { invalidCount: invalidCount + fetchFailures, lastError });
  return {
    appCount: getCatalogMeta().appCount,
    invalidCount,
    deprecatedCount,
    fetchFailures,
    removed: saved.removed,
  };
}

// ---------------------------------------------------------------------------
// Single-flight background refresh
// ---------------------------------------------------------------------------

interface RefreshState {
  inflight: Promise<CatalogRefreshResult> | null;
  lastFailureAt: number;
}

/** After a failed refresh, lazy refreshes wait this long before trying again. */
const FAILED_REFRESH_BACKOFF_MS = 10 * 60 * 1000;
const REFRESH_KEY = Symbol.for('intuneget.macos.catalogRefresh');
function refreshState(): RefreshState {
  const g = globalThis as unknown as Record<symbol, RefreshState | undefined>;
  if (!g[REFRESH_KEY]) g[REFRESH_KEY] = { inflight: null, lastFailureAt: 0 };
  return g[REFRESH_KEY]!;
}

/** Test helper: forget a previous failure so the next lazy refresh runs. */
export function resetCatalogRefreshStateForTests(): void {
  const s = refreshState();
  s.inflight = null;
  s.lastFailureAt = 0;
}

export function isCatalogRefreshing(): boolean {
  return refreshState().inflight !== null;
}

/** Start a refresh unless one is running; returns the running/new promise. */
export function startCatalogRefresh(fetchImpl: typeof fetch = fetch): Promise<CatalogRefreshResult> {
  const s = refreshState();
  if (s.inflight) return s.inflight;
  const promise = refreshCatalog(fetchImpl)
    .then(
      (result) => {
        s.lastFailureAt = 0;
        return result;
      },
      (error) => {
        s.lastFailureAt = Date.now();
        throw error;
      }
    )
    .finally(() => {
      s.inflight = null;
    });
  s.inflight = promise;
  return promise;
}

export function isCatalogStale(lastRefreshedAt: string | null, now = Date.now()): boolean {
  if (!lastRefreshedAt) return true;
  const at = Date.parse(lastRefreshedAt);
  return Number.isNaN(at) || now - at > CATALOG_STALE_MS;
}

/** Kick a background refresh when the stored catalog is older than 12h. */
export function refreshCatalogIfStale(fetchImpl: typeof fetch = fetch): void {
  const meta = getCatalogMeta();
  if (!isCatalogStale(meta.lastRefreshedAt) || isCatalogRefreshing()) return;
  if (Date.now() - refreshState().lastFailureAt < FAILED_REFRESH_BACKOFF_MS) return;
  startCatalogRefresh(fetchImpl).catch((error) => {
    console.error('[macos] catalog refresh failed:', error instanceof Error ? error.message : error);
  });
}

export function getCatalogMetaWithState(): MacosCatalogMeta {
  return { ...getCatalogMeta(), refreshing: isCatalogRefreshing() };
}

/** Serve the stored catalog, triggering a lazy refresh when it is stale. */
export function queryCatalog(query: CatalogQuery, fetchImpl: typeof fetch = fetch): CatalogPage & { meta: MacosCatalogMeta } {
  refreshCatalogIfStale(fetchImpl);
  return { ...searchCatalog(query), meta: getCatalogMetaWithState() };
}
