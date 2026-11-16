import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCatalogMetaWithState,
  isCatalogStale,
  queryCatalog,
  refreshCatalog,
  resetCatalogRefreshStateForTests,
  startCatalogRefresh,
  validateManifest,
} from '../catalog';
import {
  ActiveJobExistsError,
  INTERRUPTED_JOB_MESSAGE,
  ensureMacosSchema,
  getJob,
  insertJob,
  listJobsForTenant,
  searchCatalog,
  setMacosDatabaseForTests,
  updateJob,
  type NewJobInput,
} from '../store';

const BASE = 'https://raw.githubusercontent.com/ugurkocde/IntuneBrew/main/';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Slack',
    description: 'Team chat',
    version: '4.41.0',
    url: 'https://downloads.slack-edge.com/slack.dmg',
    bundleId: 'com.tinyspeck.slackmacgap',
    homepage: 'https://slack.com',
    fileName: 'Slack-4.41.0.dmg',
    sha: 'A'.repeat(64),
    category: 'Communication',
    publisher: 'Slack Technologies',
    ...overrides,
  };
}

function catalogFetch(index: Record<string, unknown>, manifests: Record<string, unknown>, failing: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${BASE}supported_apps.json`) return Response.json(index);
    const id = url.startsWith(`${BASE}Apps/`) ? url.slice(`${BASE}Apps/`.length, -'.json'.length) : '';
    if (failing.includes(id)) return new Response('boom', { status: 500 });
    if (id in manifests) return Response.json(manifests[id]);
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  setMacosDatabaseForTests(db);
  resetCatalogRefreshStateForTests();
  delete process.env.MACOS_CATALOG_REF;
});

afterEach(() => {
  setMacosDatabaseForTests(null);
  db.close();
});

describe('validateManifest', () => {
  it('accepts a good manifest and lowercases the digest', () => {
    const result = validateManifest('slack', manifest());
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') expect(result.app.sha256).toBe('a'.repeat(64));
  });

  it.each([
    ['http url', { url: 'http://example.com/a.dmg' }],
    ['short sha', { sha: 'abc' }],
    ['zip file', { fileName: 'App.zip' }],
    ['empty version', { version: '' }],
    ['missing bundle id', { bundleId: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(validateManifest('slack', manifest(overrides)).kind).toBe('invalid');
  });

  it('skips deprecated apps and bad ids', () => {
    expect(validateManifest('slack', manifest({ deprecated: true })).kind).toBe('deprecated');
    expect(validateManifest('../etc', manifest()).kind).toBe('invalid');
  });
});

describe('catalog refresh', () => {
  it('stores valid apps, counts invalid ones and removes apps that left the index', async () => {
    const index = { slack: 'x', broken: 'x', old: 'x', flaky: 'x' };
    const manifests = {
      slack: manifest(),
      broken: manifest({ sha: 'nope' }),
      old: manifest({ name: 'Old', bundleId: 'com.old', deprecated: true }),
    };
    const result = await refreshCatalog(catalogFetch(index, manifests, ['flaky']));
    expect(result).toMatchObject({ appCount: 1, invalidCount: 1, deprecatedCount: 1, fetchFailures: 1 });
    const meta = getCatalogMetaWithState();
    expect(meta.appCount).toBe(1);
    expect(meta.invalidCount).toBe(2);
    expect(meta.lastError).toMatch(/1 manifest/);
    expect(meta.lastRefreshedAt).not.toBeNull();

    // Next refresh: slack leaves the index, a new app arrives.
    await refreshCatalog(catalogFetch({ zoom: 'x' }, { zoom: manifest({ name: 'Zoom', bundleId: 'us.zoom.xos', fileName: 'zoom.pkg' }) }));
    expect(searchCatalog({}).apps.map((a) => a.id)).toEqual(['zoom']);
  });

  it('keeps the stored catalog when the index cannot be fetched', async () => {
    await refreshCatalog(catalogFetch({ slack: 'x' }, { slack: manifest() }));
    const failing = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    await expect(refreshCatalog(failing)).rejects.toThrow(/catalog index/);
    expect(searchCatalog({}).total).toBe(1);
    expect(getCatalogMetaWithState().lastError).toMatch(/HTTP 503/);
  });

  it('uses MACOS_CATALOG_REF for every URL', async () => {
    process.env.MACOS_CATALOG_REF = 'abc123';
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return String(input).endsWith('supported_apps.json') ? Response.json({ slack: 'https://evil.test/x.json' }) : Response.json(manifest());
    }) as unknown as typeof fetch;
    await refreshCatalog(fetchImpl);
    expect(seen).toEqual([
      'https://raw.githubusercontent.com/ugurkocde/IntuneBrew/abc123/supported_apps.json',
      'https://raw.githubusercontent.com/ugurkocde/IntuneBrew/abc123/Apps/slack.json',
    ]);
  });

  it('runs a single refresh at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      await gate;
      return String(input).endsWith('supported_apps.json') ? Response.json({ slack: 'x' }) : Response.json(manifest());
    }) as unknown as typeof fetch;
    const a = startCatalogRefresh(fetchImpl);
    const b = startCatalogRefresh(fetchImpl);
    expect(a).toBe(b);
    expect(getCatalogMetaWithState().refreshing).toBe(true);
    release();
    await a;
    expect(getCatalogMetaWithState().refreshing).toBe(false);
  });

  it('serves the stored catalog and refreshes lazily when stale', async () => {
    const fetchImpl = catalogFetch({ slack: 'x' }, { slack: manifest() });
    const first = queryCatalog({}, fetchImpl);
    expect(first.total).toBe(0);
    expect(first.meta.refreshing).toBe(true);
    await startCatalogRefresh(fetchImpl);
    const second = queryCatalog({ search: 'tinyspeck' }, fetchImpl);
    expect(second.total).toBe(1);
    expect(second.meta.refreshing).toBe(false);
    expect(second.categories).toEqual(['Communication']);
  });

  it('treats a missing or 12h-old refresh as stale', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(isCatalogStale(null, now)).toBe(true);
    expect(isCatalogStale('2026-11-16T01:00:00Z', now)).toBe(false);
    expect(isCatalogStale('2026-11-15T23:00:00Z', now)).toBe(true);
  });

  it('escapes LIKE wildcards in search', async () => {
    await refreshCatalog(catalogFetch({ slack: 'x' }, { slack: manifest() }));
    expect(searchCatalog({ search: '%' }).total).toBe(0);
    expect(searchCatalog({ search: 'SLACK' }).total).toBe(1);
  });
});

describe('jobs store', () => {
  const input: NewJobInput = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    userEmail: 'admin@example.test',
    catalogId: 'slack',
    appName: 'Slack',
    version: '4.41.0',
    mode: 'new',
    intuneAppId: null,
    assignments: [{ groupId: 'g', groupName: 'Macs', intent: 'required' }],
    ignoreVersionDetection: null,
  };

  it('refuses a second active job for the same app and tenant', () => {
    const job = insertJob(input);
    expect(job.status).toBe('queued');
    expect(job.assignments).toEqual(input.assignments);
    expect(() => insertJob(input)).toThrow(ActiveJobExistsError);
    expect(() => insertJob({ ...input, tenantId: 'tenant-2' })).not.toThrow();
    updateJob(job.id, { status: 'completed', progressPercent: 100 });
    expect(getJob(job.id)!.completedAt).not.toBeNull();
    expect(() => insertJob(input)).not.toThrow();
    expect(listJobsForTenant('tenant-1')).toHaveLength(2);
  });

  it('fails jobs left running by a previous process when the schema is opened', () => {
    const job = insertJob(input);
    updateJob(job.id, { status: 'uploading', progressPercent: 40 });
    const done = insertJob({ ...input, catalogId: 'zoom' });
    updateJob(done.id, { status: 'completed' });
    ensureMacosSchema(db);
    const failed = getJob(job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).toBe(INTERRUPTED_JOB_MESSAGE);
    expect(getJob(done.id)!.status).toBe('completed');
  });
});
