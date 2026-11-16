import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/intune/graph-client', () => ({
  fetchWithRetry: vi.fn(),
  getServicePrincipalToken: vi.fn(async () => 'token'),
}));

import { MacosGraphClient, GraphRequestError } from '../graph';
import { enqueueMacosJob, setMacosJobExecutorForTests, waitForMacosQueueIdle } from '../jobs';
import { getJob, setMacosDatabaseForTests, type NewJobInput } from '../store';
import { matchTenantApps, parseIntuneMacApp } from '../tenant-apps';
import { catalogApp } from './helpers';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  setMacosDatabaseForTests(db);
});

afterEach(() => {
  setMacosJobExecutorForTests(null);
  setMacosDatabaseForTests(null);
  db.close();
});

const input = (catalogId: string): NewJobInput => ({
  tenantId: 'tenant-1',
  userId: 'user-1',
  userEmail: null,
  catalogId,
  appName: catalogId,
  version: '1.0',
  mode: 'new',
  intuneAppId: null,
  assignments: [],
  ignoreVersionDetection: null,
});

describe('macOS job queue', () => {
  it('runs one job at a time and records the outcome', async () => {
    let running = 0;
    let maxRunning = 0;
    setMacosJobExecutorForTests(async (job) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (job.catalogId === 'bad') throw new Error('installer hash does not match the catalog');
      return { intuneAppId: `app-${job.catalogId}`, warnings: job.catalogId === 'warn' ? ['1 assignment failed'] : [] };
    });
    const ok = enqueueMacosJob(input('good'));
    const bad = enqueueMacosJob(input('bad'));
    const warn = enqueueMacosJob(input('warn'));
    await waitForMacosQueueIdle();
    expect(maxRunning).toBe(1);
    expect(getJob(ok.id)).toMatchObject({ status: 'completed', progressPercent: 100, intuneAppId: 'app-good', errorMessage: null });
    expect(getJob(bad.id)).toMatchObject({ status: 'failed', errorMessage: 'installer hash does not match the catalog' });
    expect(getJob(warn.id)).toMatchObject({ status: 'completed', errorMessage: '1 assignment failed' });
  });
});

describe('tenant app matching', () => {
  const catalog = [
    catalogApp({ id: 'slack', name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', version: '4.41.0' }),
    catalogApp({ id: 'zoom', name: 'Zoom', bundleId: 'us.zoom.xos', version: '6.0.0' }),
  ];

  it('parses PKG, DMG and LOB records and ignores other types', () => {
    expect(parseIntuneMacApp({ '@odata.type': '#microsoft.graph.macOSPkgApp', id: 'a', displayName: 'A', primaryBundleId: 'x', primaryBundleVersion: '1' }))
      .toEqual({ id: 'a', displayName: 'A', appType: 'macOSPkgApp', bundleId: 'x', version: '1' });
    expect(parseIntuneMacApp({ '@odata.type': '#microsoft.graph.macOSLobApp', id: 'b', displayName: 'B', bundleId: 'y', versionNumber: '2' }))
      .toMatchObject({ appType: 'macOSLobApp', bundleId: 'y', version: '2' });
    expect(parseIntuneMacApp({ '@odata.type': '#microsoft.graph.win32LobApp', id: 'c' })).toBeNull();
  });

  it('matches by bundle id, then by name, and flags newer catalog versions', () => {
    const apps = matchTenantApps(
      [
        { id: '1', displayName: 'Slack (Company)', appType: 'macOSDmgApp', bundleId: 'COM.TINYSPECK.SLACKMACGAP', version: '4.40.1' },
        { id: '2', displayName: 'zoom', appType: 'macOSPkgApp', bundleId: 'other.bundle', version: '6.0.0' },
        { id: '3', displayName: 'Internal Tool', appType: 'macOSLobApp', bundleId: 'com.internal', version: '1.0' },
      ],
      catalog
    );
    const byId = Object.fromEntries(apps.map((a) => [a.intuneAppId, a]));
    expect(byId['1']).toMatchObject({ catalogId: 'slack', catalogVersion: '4.41.0', updateAvailable: true, updateSupported: true });
    expect(byId['2']).toMatchObject({ catalogId: 'zoom', updateAvailable: false });
    expect(byId['3']).toMatchObject({ catalogId: null, updateAvailable: false, updateSupported: false });
    expect(apps[0].intuneAppId).toBe('1');
  });
});

describe('MacosGraphClient', () => {
  it('follows nextLink pages with the isof filter and a bearer token', async () => {
    const fetchRetry = vi.fn(async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn');
      if (url.includes('skiptoken')) return Response.json({ value: [{ id: 'b' }] });
      expect(decodeURIComponent(url)).toContain("isof('microsoft.graph.macOSPkgApp')");
      return Response.json({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?$skiptoken=x' });
    });
    const client = new MacosGraphClient(async () => 'tkn', fetchRetry as never);
    expect(await client.listMacApps()).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('raises GraphRequestError with the Graph message', async () => {
    const fetchRetry = vi.fn(async () => Response.json({ error: { code: 'Forbidden', message: 'Insufficient privileges' } }, { status: 403 }));
    const client = new MacosGraphClient(async () => 'tkn', fetchRetry as never);
    await expect(client.getApp('x')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('Insufficient privileges') });
    await expect(client.getApp('x')).rejects.toBeInstanceOf(GraphRequestError);
  });

  it('fails without a token', async () => {
    const client = new MacosGraphClient(async () => null, vi.fn() as never);
    await expect(client.getApp('x')).rejects.toThrow(/no Graph token/);
  });
});
