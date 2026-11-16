import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: null as null | { userId: string; userEmail: string; tenantId: string },
  sqlite: true,
  tenantApps: [] as Record<string, unknown>[],
  iconFetch: null as null | ((url: string) => Promise<Response>),
  resolved: ['93.184.216.34'] as string[],
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
  return {
    ...actual,
    createGraphClientForTenant: () => ({
      listMacApps: async () => state.tenantApps,
      getApp: async () => ({}),
    }),
  };
});
vi.mock('@/lib/macos/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/macos/url-guard')>();
  return {
    ...actual,
    defaultResolveHost: async () => state.resolved,
    pinnedHttpsFetch: () => (async (input: RequestInfo | URL) => state.iconFetch!(String(input))) as typeof fetch,
  };
});

import { setMacosJobExecutorForTests, waitForMacosQueueIdle } from '@/lib/macos/jobs';
import { setMacosDatabaseForTests } from '@/lib/macos/store';
import type { MacosCustomApp } from '@/lib/macos/types';
import { GET as listRoute, POST as createRoute } from './route';
import { DELETE as deleteRoute, PUT as updateRoute } from './[id]/route';
import { GET as iconRoute } from './[id]/icon/route';
import { POST as deployRoute } from '../deploy/route';
import { GET as catalogRoute } from '../catalog/route';
import { GET as tenantAppsRoute } from '../tenant-apps/route';

const SHA = 'cd'.repeat(32);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Acme Agent',
  publisher: 'Acme',
  version: '1.0.0',
  bundleId: 'com.acme.agent',
  url: 'https://downloads.acme.test/AcmeAgent.pkg',
  sha256: SHA,
  iconUrl: 'https://cdn.acme.test/icon.png',
  ...overrides,
});

function req(url: string, method = 'GET', json?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function create(overrides: Record<string, unknown> = {}): Promise<MacosCustomApp> {
  const response = await createRoute(req('/api/macos/custom-apps', 'POST', body(overrides)));
  expect(response.status).toBe(201);
  return (await response.json()).app;
}

let db: Database.Database;
let release: () => void = () => {};

beforeEach(() => {
  db = new Database(':memory:');
  setMacosDatabaseForTests(db);
  state.user = { userId: 'user-1', userEmail: 'admin@example.test', tenantId: 'tenant-1' };
  state.sqlite = true;
  state.tenantApps = [];
  state.resolved = ['93.184.216.34'];
  state.iconFetch = async () => new Response(PNG, { status: 200 });
  const gate = new Promise<void>((resolve) => (release = resolve));
  setMacosJobExecutorForTests(async () => {
    await gate;
    return { intuneAppId: '33333333-3333-3333-3333-333333333333', warnings: [] };
  });
});

afterEach(async () => {
  release();
  await waitForMacosQueueIdle();
  setMacosJobExecutorForTests(null);
  setMacosDatabaseForTests(null);
  db.close();
});

describe('/api/macos/custom-apps', () => {
  it('requires SQLite mode and a user', async () => {
    state.sqlite = false;
    expect((await listRoute(req('/api/macos/custom-apps'))).status).toBe(501);
    state.sqlite = true;
    state.user = null;
    expect((await createRoute(req('/api/macos/custom-apps', 'POST', body()))).status).toBe(401);
  });

  it('creates and lists custom apps for the tenant only', async () => {
    const app = await create();
    expect(app).toMatchObject({ tenantId: 'tenant-1', fileName: 'AcmeAgent.pkg', createdBy: 'admin@example.test' });
    const list = await (await listRoute(req('/api/macos/custom-apps'))).json();
    expect(list.apps.map((a: MacosCustomApp) => a.id)).toEqual([app.id]);
    state.user = { ...state.user!, tenantId: 'tenant-2' };
    expect((await (await listRoute(req('/api/macos/custom-apps'))).json()).apps).toEqual([]);
  });

  it('validates the body', async () => {
    const response = await createRoute(req('/api/macos/custom-apps', 'POST', body({ sha256: 'x', url: 'http://a.test/a.pkg' })));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/SHA-256/);
    expect(Object.keys(json.fields)).toEqual(expect.arrayContaining(['sha256', 'url']));
  });

  it('returns 409 for a duplicate bundle id', async () => {
    await create();
    const response = await createRoute(req('/api/macos/custom-apps', 'POST', body({ name: 'Other' })));
    expect(response.status).toBe(409);
  });

  it('updates an app and 404s for unknown or foreign ids', async () => {
    const app = await create();
    const response = await updateRoute(
      req(`/api/macos/custom-apps/${app.id}`, 'PUT', body({ version: '1.1.0', url: 'https://downloads.acme.test/v/AcmeAgent-1.1.dmg' })),
      params(app.id)
    );
    expect(response.status).toBe(200);
    expect((await response.json()).app).toMatchObject({ version: '1.1.0', fileName: 'AcmeAgent-1.1.dmg' });

    expect((await updateRoute(req('/api/macos/custom-apps/slack', 'PUT', body()), params('slack'))).status).toBe(404);
    state.user = { ...state.user!, tenantId: 'tenant-2' };
    expect((await updateRoute(req(`/api/macos/custom-apps/${app.id}`, 'PUT', body()), params(app.id))).status).toBe(404);
    expect((await deleteRoute(req(`/api/macos/custom-apps/${app.id}`, 'DELETE'), params(app.id))).status).toBe(404);
  });

  it('deletes an app, but returns 409 while it has a queued job', async () => {
    const app = await create();
    const deploy = await deployRoute(req('/api/macos/deploy', 'POST', { catalogId: app.id, mode: 'new', assignments: [] }));
    expect(deploy.status).toBe(202);

    const busy = await deleteRoute(req(`/api/macos/custom-apps/${app.id}`, 'DELETE'), params(app.id));
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toMatch(/in progress/);
    const busyEdit = await updateRoute(req(`/api/macos/custom-apps/${app.id}`, 'PUT', body({ version: '2' })), params(app.id));
    expect(busyEdit.status).toBe(409);

    release();
    await waitForMacosQueueIdle();
    const done = await deleteRoute(req(`/api/macos/custom-apps/${app.id}`, 'DELETE'), params(app.id));
    expect(done.status).toBe(200);
    expect((await (await listRoute(req('/api/macos/custom-apps'))).json()).apps).toEqual([]);
  });
});

describe('custom apps in the other macOS routes', () => {
  it('deploys a custom app only for its own tenant', async () => {
    const app = await create();
    state.user = { ...state.user!, tenantId: 'tenant-2' };
    const foreign = await deployRoute(req('/api/macos/deploy', 'POST', { catalogId: app.id, mode: 'new', assignments: [] }));
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error).toMatch(/custom app was not found/);

    state.user = { ...state.user!, tenantId: 'tenant-1' };
    const own = await deployRoute(req('/api/macos/deploy', 'POST', { catalogId: app.id, mode: 'new', assignments: [] }));
    expect(own.status).toBe(202);
    expect((await own.json()).job).toMatchObject({ catalogId: app.id, appName: 'Acme Agent', version: '1.0.0', tenantId: 'tenant-1' });
  });

  it('lists custom apps in the catalog response, filtered by search and hidden by a category', async () => {
    const app = await create();
    const all = await (await catalogRoute(req('/api/macos/catalog'))).json();
    expect(all.customApps.map((a: MacosCustomApp) => a.id)).toEqual([app.id]);
    expect(all.meta.appCount).toBe(0);
    expect((await (await catalogRoute(req('/api/macos/catalog?search=nomatch'))).json()).customApps).toEqual([]);
    expect((await (await catalogRoute(req('/api/macos/catalog?category=Utilities'))).json()).customApps).toEqual([]);
  });

  it("matches the tenant's Intune apps to custom apps", async () => {
    const app = await create({ version: '2.0.0' });
    state.tenantApps = [
      {
        '@odata.type': '#microsoft.graph.macOSPkgApp',
        id: 'intune-1',
        displayName: 'Acme Agent',
        primaryBundleId: 'com.acme.agent',
        primaryBundleVersion: '1.0.0',
      },
    ];
    const json = await (await tenantAppsRoute(req('/api/macos/tenant-apps'))).json();
    expect(json.apps[0]).toMatchObject({ catalogId: app.id, catalogCustom: true, updateAvailable: true });
  });
});

describe('GET /api/macos/custom-apps/[id]/icon', () => {
  it('proxies a PNG icon with a cache header', async () => {
    const app = await create();
    const response = await iconRoute(req(`/api/macos/custom-apps/${app.id}/icon`), params(app.id));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toMatch(/max-age/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it('404s for unknown ids, apps without an icon, non-PNG bodies and private hosts', async () => {
    expect((await iconRoute(req('/api/macos/custom-apps/x/icon'), params('slack'))).status).toBe(404);
    const missing = 'custom-00000000-0000-0000-0000-000000000000';
    expect((await iconRoute(req('/x'), params(missing))).status).toBe(404);

    const plain = await create({ iconUrl: '' });
    expect(plain.iconUrl).toBeNull();
    expect((await iconRoute(req('/x'), params(plain.id))).status).toBe(404);

    const withIcon = await create({ bundleId: 'com.acme.two' });
    state.iconFetch = async () => new Response('<svg/>', { status: 200 });
    expect((await iconRoute(req('/x'), params(withIcon.id))).status).toBe(404);

    let fetched = false;
    state.iconFetch = async () => {
      fetched = true;
      return new Response(PNG, { status: 200 });
    };
    state.resolved = ['10.0.0.4'];
    expect((await iconRoute(req('/x'), params(withIcon.id))).status).toBe(404);
    expect(fetched).toBe(false);
  });
});
