import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: null as null | { userId: string; userEmail: string; tenantId: string },
  sqlite: true,
  tenantApps: [] as Record<string, unknown>[],
  appById: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: vi.fn(async () => state.user) }));
vi.mock('@/lib/db', () => ({ isSqliteMode: () => state.sqlite }));
vi.mock('@/lib/supabase', () => ({ getServerClientOrNull: () => null }));
vi.mock('@/lib/intune/graph-client', () => ({
  fetchWithRetry: vi.fn(),
  getServicePrincipalToken: vi.fn(async () => 'token'),
}));
vi.mock('@/lib/macos/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/macos/jobs')>();
  const { GraphRequestError } = await import('@/lib/macos/graph');
  return {
    ...actual,
    createGraphClientForTenant: () => ({
      listMacApps: async () => state.tenantApps,
      getApp: async (id: string) => {
        if (!state.appById[id]) throw new GraphRequestError('not found', 404, null);
        return state.appById[id];
      },
    }),
  };
});

import { setMacosJobExecutorForTests, waitForMacosQueueIdle } from '@/lib/macos/jobs';
import { saveCatalogRefresh, setMacosDatabaseForTests } from '@/lib/macos/store';
import { POST } from './route';
import { GET as getCatalog } from '../catalog/route';
import { GET as getJobs } from '../jobs/route';

const APP_ID = '22222222-2222-2222-2222-222222222222';
const GROUP = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/macos/deploy', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

let db: Database.Database;
let release: () => void = () => {};

beforeEach(() => {
  db = new Database(':memory:');
  setMacosDatabaseForTests(db);
  state.user = { userId: 'user-1', userEmail: 'admin@example.test', tenantId: 'tenant-1' };
  state.sqlite = true;
  state.tenantApps = [];
  state.appById = {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  setMacosJobExecutorForTests(async () => {
    await gate;
    return { intuneAppId: APP_ID, warnings: [] };
  });
  saveCatalogRefresh(
    [
      {
        id: 'slack',
        name: 'Slack',
        version: '4.41.0',
        bundleId: 'com.tinyspeck.slackmacgap',
        publisher: 'Slack',
        category: 'Communication',
        description: null,
        homepage: null,
        url: 'https://downloads.example.test/slack.dmg',
        fileName: 'Slack.dmg',
        sha256: 'a'.repeat(64),
        rawJson: '{}',
      },
    ],
    [],
    { invalidCount: 0, lastError: null }
  );
});

afterEach(async () => {
  release();
  await waitForMacosQueueIdle();
  setMacosJobExecutorForTests(null);
  setMacosDatabaseForTests(null);
  db.close();
});

describe('POST /api/macos/deploy', () => {
  it('returns 501 outside SQLite mode and 401 without a user', async () => {
    state.sqlite = false;
    expect((await post({})).status).toBe(501);
    state.sqlite = true;
    state.user = null;
    expect((await post({})).status).toBe(401);
  });

  it('validates the body', async () => {
    const response = await post({ catalogId: 'slack', mode: 'update', assignments: [] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/intuneAppId/);
  });

  it('queues a new deploy and rejects a second one while it runs', async () => {
    const body = { catalogId: 'slack', mode: 'new', assignments: [{ groupId: GROUP, groupName: 'Macs', intent: 'required' }] };
    const first = await post(body);
    expect(first.status).toBe(202);
    const { job } = await first.json();
    expect(job).toMatchObject({ catalogId: 'slack', mode: 'new', tenantId: 'tenant-1', status: 'queued' });
    const second = await post(body);
    expect(second.status).toBe(409);

    const jobs = await getJobs(new NextRequest('http://localhost/api/macos/jobs', { headers: { Authorization: 'Bearer t' } }));
    expect((await jobs.json()).jobs).toHaveLength(1);
  });

  it('refuses a new app when Intune already has the bundle id', async () => {
    state.tenantApps = [
      { '@odata.type': '#microsoft.graph.macOSDmgApp', id: APP_ID, displayName: 'Slack', primaryBundleId: 'com.tinyspeck.slackmacgap' },
    ];
    const response = await post({ catalogId: 'slack', mode: 'new', assignments: [] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ intuneAppId: APP_ID });
  });

  it('updates only a PKG/DMG app of the same installer type', async () => {
    state.appById[APP_ID] = { '@odata.type': '#microsoft.graph.macOSPkgApp', id: APP_ID, displayName: 'Slack' };
    expect((await post({ catalogId: 'slack', mode: 'update', intuneAppId: APP_ID })).status).toBe(409);
    state.appById[APP_ID] = { '@odata.type': '#microsoft.graph.macOSDmgApp', id: APP_ID, displayName: 'Slack' };
    const ok = await post({ catalogId: 'slack', mode: 'update', intuneAppId: APP_ID });
    expect(ok.status).toBe(202);
    expect((await ok.json()).job).toMatchObject({ mode: 'update', intuneAppId: APP_ID, assignments: [] });
  });

  it('returns 404 for unknown catalog apps and Intune apps', async () => {
    expect((await post({ catalogId: 'nope', mode: 'new' })).status).toBe(404);
    expect((await post({ catalogId: 'slack', mode: 'update', intuneAppId: '33333333-3333-3333-3333-333333333333' })).status).toBe(404);
  });
});

describe('GET /api/macos/catalog', () => {
  it('returns stored apps with meta', async () => {
    const response = await getCatalog(
      new NextRequest('http://localhost/api/macos/catalog?search=slack', { headers: { Authorization: 'Bearer t' } })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.apps[0]).toMatchObject({ id: 'slack', version: '4.41.0' });
    expect(body.meta).toMatchObject({ appCount: 1, refreshing: false });
  });
});
