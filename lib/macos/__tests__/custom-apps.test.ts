import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/intune/graph-client', () => ({
  fetchWithRetry: vi.fn(),
  getServicePrincipalToken: vi.fn(async () => 'token'),
}));

import { refreshCatalog, resetCatalogRefreshStateForTests, validateManifest } from '../catalog';
import {
  CustomAppBusyError,
  DuplicateBundleIdError,
  createCustomApp,
  deleteCustomApp,
  getCustomApp,
  getCustomAppIconUrl,
  listCustomApps,
  updateCustomApp,
} from '../custom-apps';
import { enqueueMacosJob, resolveJobApp, setMacosJobExecutorForTests, waitForMacosQueueIdle } from '../jobs';
import { getCatalogApp, getJob, insertJob, saveCatalogRefresh, setMacosDatabaseForTests, updateJob } from '../store';
import { matchTenantApps, type IntuneMacApp } from '../tenant-apps';
import { customAppToCatalogApp } from '../types';
import {
  fileNameFromInstallerUrl,
  installerUrlProblem,
  macosCustomAppSchema,
  type MacosCustomAppInput,
} from '../validators';
import { catalogApp } from './helpers';

const SHA = 'ab'.repeat(32);

function input(overrides: Partial<Record<keyof MacosCustomAppInput, unknown>> = {}): MacosCustomAppInput {
  return macosCustomAppSchema.parse({
    name: 'Acme Agent',
    publisher: 'Acme',
    version: '1.0.0',
    bundleId: 'com.acme.agent',
    url: 'https://downloads.acme.test/AcmeAgent-1.0.0.pkg',
    sha256: SHA,
    ...overrides,
  });
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  setMacosDatabaseForTests(db);
  resetCatalogRefreshStateForTests();
  delete process.env.MACOS_CATALOG_REF;
});

afterEach(() => {
  setMacosJobExecutorForTests(null);
  setMacosDatabaseForTests(null);
  db.close();
});

describe('custom app validation', () => {
  it('accepts a complete definition and normalises it', () => {
    const parsed = macosCustomAppSchema.parse({
      name: ' Acme ',
      publisher: 'Acme',
      version: '1.0.0',
      bundleId: 'com.acme.agent',
      url: 'https://downloads.acme.test/path/Acme%20Agent.DMG',
      sha256: SHA.toUpperCase(),
      description: '',
      homepage: 'http://acme.test',
      iconUrl: 'https://cdn.acme.test/icon.png',
    });
    expect(parsed).toMatchObject({ name: 'Acme', sha256: SHA, description: null, homepage: 'http://acme.test' });
    expect(fileNameFromInstallerUrl(parsed.url)).toBe('Acme Agent.DMG');
  });

  it.each([
    ['a short sha', { sha256: 'abc' }, /SHA-256/],
    ['a non-hex sha', { sha256: 'z'.repeat(64) }, /SHA-256/],
    ['a missing sha', { sha256: undefined }, /./],
    ['an http URL', { url: 'http://downloads.acme.test/a.pkg' }, /https/],
    ['an IPv4 literal', { url: 'https://10.0.0.5/a.pkg' }, /IP address/],
    ['an IPv4 literal in integer form', { url: 'https://2130706433/a.pkg' }, /IP address/],
    ['an IPv6 literal', { url: 'https://[::1]/a.pkg' }, /IP address/],
    ['credentials', { url: 'https://user:pw@downloads.acme.test/a.pkg' }, /credentials/],
    ['a wrong extension', { url: 'https://downloads.acme.test/a.zip' }, /\.pkg or \.dmg/],
    ['an extension only in the query', { url: 'https://downloads.acme.test/a?f=x.pkg' }, /\.pkg or \.dmg/],
    ['an encoded slash in the file name', { url: 'https://downloads.acme.test/x%2Fa.pkg' }, /\.pkg or \.dmg/],
    ['an http icon URL', { iconUrl: 'http://cdn.acme.test/i.png' }, /Icon URL/],
    ['an IP icon URL', { iconUrl: 'https://169.254.169.254/i.png' }, /Icon URL/],
    ['a javascript homepage', { homepage: 'javascript:alert(1)' }, /Homepage/],
    ['a bundle id with spaces', { bundleId: 'com acme' }, /Bundle ID/],
  ])('rejects %s', (_label, overrides, message) => {
    const result = macosCustomAppSchema.safeParse({ ...input(), ...overrides });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(message);
  });

  it('only checks the installer URL syntactically', () => {
    expect(installerUrlProblem('https://intranet.local/a.pkg')).toBeNull();
  });
});

describe('custom app store', () => {
  it('creates, lists, updates and deletes within a tenant', () => {
    const created = createCustomApp('tenant-1', 'admin@example.test', input(), '2026-11-16T10:00:00.000Z');
    expect(created.id).toMatch(/^custom-[0-9a-f-]{36}$/);
    expect(created).toMatchObject({
      tenantId: 'tenant-1',
      fileName: 'AcmeAgent-1.0.0.pkg',
      createdBy: 'admin@example.test',
      createdAt: '2026-11-16T10:00:00.000Z',
      updatedAt: '2026-11-16T10:00:00.000Z',
      iconUrl: null,
    });
    expect(listCustomApps('tenant-1').map((a) => a.id)).toEqual([created.id]);
    expect(listCustomApps('tenant-1', 'acme.ag').length).toBe(1);
    expect(listCustomApps('tenant-1', 'nomatch')).toEqual([]);

    const updated = updateCustomApp(
      created.id,
      'tenant-1',
      input({ version: '1.1.0', url: 'https://downloads.acme.test/AcmeAgent-1.1.0.dmg' }),
      '2026-11-17T10:00:00.000Z'
    );
    expect(updated).toMatchObject({
      version: '1.1.0',
      fileName: 'AcmeAgent-1.1.0.dmg',
      createdAt: '2026-11-16T10:00:00.000Z',
      updatedAt: '2026-11-17T10:00:00.000Z',
    });
    expect(customAppToCatalogApp(updated!)).toMatchObject({
      id: created.id,
      fileName: 'AcmeAgent-1.1.0.dmg',
      fetchedAt: '2026-11-17T10:00:00.000Z',
      category: null,
    });

    expect(deleteCustomApp(created.id, 'tenant-1')).toBe(true);
    expect(getCustomApp(created.id, 'tenant-1')).toBeNull();
    expect(deleteCustomApp(created.id, 'tenant-1')).toBe(false);
  });

  it('scopes reads and writes to the tenant', () => {
    const created = createCustomApp('tenant-1', 'u', input({ iconUrl: 'https://cdn.acme.test/i.png' }));
    expect(listCustomApps('tenant-2')).toEqual([]);
    expect(getCustomApp(created.id, 'tenant-2')).toBeNull();
    expect(updateCustomApp(created.id, 'tenant-2', input({ version: '9' }))).toBeNull();
    expect(deleteCustomApp(created.id, 'tenant-2')).toBe(false);
    expect(getCustomApp(created.id, 'tenant-1')?.version).toBe('1.0.0');
    expect(getCustomAppIconUrl(created.id)).toBe('https://cdn.acme.test/i.png');
  });

  it('keeps bundle ids unique per tenant, case-insensitively', () => {
    const first = createCustomApp('tenant-1', 'u', input());
    expect(() => createCustomApp('tenant-1', 'u', input({ bundleId: 'COM.ACME.AGENT' }))).toThrow(DuplicateBundleIdError);
    expect(createCustomApp('tenant-2', 'u', input()).tenantId).toBe('tenant-2');
    const second = createCustomApp('tenant-1', 'u', input({ bundleId: 'com.acme.other' }));
    expect(() => updateCustomApp(second.id, 'tenant-1', input())).toThrow(DuplicateBundleIdError);
    // Saving an app under its own bundle id is fine.
    expect(updateCustomApp(first.id, 'tenant-1', input({ version: '2.0' }))?.version).toBe('2.0');
  });

  it('refuses to delete or edit an app with a queued or running job', () => {
    const app = createCustomApp('tenant-1', 'u', input());
    const job = insertJob({
      tenantId: 'tenant-1',
      userId: 'u',
      userEmail: null,
      catalogId: app.id,
      appName: app.name,
      version: app.version,
      mode: 'new',
      intuneAppId: null,
      assignments: [],
      ignoreVersionDetection: null,
    });
    expect(() => deleteCustomApp(app.id, 'tenant-1')).toThrow(CustomAppBusyError);
    expect(() => updateCustomApp(app.id, 'tenant-1', input({ version: '2' }))).toThrow(CustomAppBusyError);
    updateJob(job.id, { status: 'completed' });
    expect(deleteCustomApp(app.id, 'tenant-1')).toBe(true);
  });

  it('is never served as a catalog app', () => {
    const app = createCustomApp('tenant-1', 'u', input());
    expect(getCatalogApp(app.id)).toBeNull();
  });
});

describe('job executor with custom apps', () => {
  it('resolves a custom id within the job tenant, with its icon as the logo', () => {
    const app = createCustomApp('tenant-1', 'u', input({ iconUrl: 'https://cdn.acme.test/i.png' }));
    const resolved = resolveJobApp({ catalogId: app.id, tenantId: 'tenant-1' });
    expect(resolved.custom).toBe(true);
    expect(resolved.logoUrl).toBe('https://cdn.acme.test/i.png');
    expect(resolved.app).toMatchObject({ id: app.id, url: app.url, sha256: SHA, fileName: 'AcmeAgent-1.0.0.pkg' });
    expect(() => resolveJobApp({ catalogId: app.id, tenantId: 'tenant-2' })).toThrow(/custom app no longer exists/);
  });

  it('still resolves catalog ids from the catalog', () => {
    saveCatalogRefresh([{ ...catalogApp({ id: 'slack' }), rawJson: '{}' }], [], { invalidCount: 0, lastError: null });
    const resolved = resolveJobApp({ catalogId: 'slack', tenantId: 'tenant-1' });
    expect(resolved).toMatchObject({ custom: false, app: { id: 'slack' } });
    expect(resolved.logoUrl).toMatch(/Logos\/slack\.png$/);
  });

  it("fails a job for another tenant's custom app before touching the network", async () => {
    const app = createCustomApp('tenant-1', 'u', input());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setMacosJobExecutorForTests(null);
    const job = enqueueMacosJob({
      tenantId: 'tenant-2',
      userId: 'u',
      userEmail: null,
      catalogId: app.id,
      appName: app.name,
      version: app.version,
      mode: 'new',
      intuneAppId: null,
      assignments: [],
      ignoreVersionDetection: null,
    });
    await waitForMacosQueueIdle();
    expect(getJob(job.id)).toMatchObject({ status: 'failed', errorMessage: 'The custom app no longer exists for this tenant.' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('catalog refresh and custom apps', () => {
  const BASE = 'https://raw.githubusercontent.com/ugurkocde/IntuneBrew/main/';

  it('never deletes or changes custom apps', async () => {
    const app = createCustomApp('tenant-1', 'u', input());
    saveCatalogRefresh([{ ...catalogApp({ id: 'old' }), rawJson: '{}' }], [], { invalidCount: 0, lastError: null });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url) === `${BASE}supported_apps.json` ? Response.json({}) : new Response('nope', { status: 404 })
    ) as unknown as typeof fetch;
    const result = await refreshCatalog(fetchImpl);
    expect(result.removed).toBe(1);
    expect(result.appCount).toBe(0);
    expect(getCustomApp(app.id, 'tenant-1')).toEqual(app);
  });

  it('rejects catalog ids that use the custom- prefix', () => {
    expect(validateManifest('custom-x', {})).toMatchObject({ kind: 'invalid' });
  });
});

describe('tenant app matching with custom apps', () => {
  const intune = (overrides: Partial<IntuneMacApp>): IntuneMacApp => ({
    id: 'i1',
    displayName: 'Acme Agent',
    appType: 'macOSPkgApp',
    bundleId: 'com.acme.agent',
    version: '1.0.0',
    ...overrides,
  });

  it('matches custom apps by bundle id before the catalog and flags newer saved versions', () => {
    const custom = createCustomApp('tenant-1', 'u', input({ version: '1.2.0', bundleId: 'COM.ACME.AGENT' }));
    const catalog = [
      catalogApp({ id: 'acme', name: 'Acme Agent', bundleId: 'com.acme.agent', version: '9.0.0' }),
      catalogApp({ id: 'zoom', name: 'Zoom', bundleId: 'us.zoom.xos', version: '6.0.0' }),
    ];
    const [acme, zoom] = matchTenantApps(
      [intune({}), intune({ id: 'i2', displayName: 'Zoom', bundleId: 'us.zoom.xos', version: '6.0.0' })],
      catalog,
      [customAppToCatalogApp(custom)]
    );
    expect(acme).toMatchObject({
      catalogId: custom.id,
      catalogVersion: '1.2.0',
      catalogCustom: true,
      updateAvailable: true,
    });
    expect(zoom).toMatchObject({ catalogId: 'zoom', catalogCustom: false, updateAvailable: false });
  });

  it('reports a custom app at the Intune version as up to date', () => {
    const custom = createCustomApp('tenant-1', 'u', input({ version: '1.0.0' }));
    const [row] = matchTenantApps([intune({})], [], [customAppToCatalogApp(custom)]);
    expect(row).toMatchObject({ catalogId: custom.id, catalogCustom: true, updateAvailable: false });
  });
});
