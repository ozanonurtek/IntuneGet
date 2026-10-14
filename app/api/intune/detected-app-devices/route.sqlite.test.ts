import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => {
  vi.stubEnv('DATABASE_PATH', ':memory:');
  vi.stubEnv('DATABASE_MODE', 'sqlite');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  return { user: 'fixture-owner' as string | null, tenant: 'fixture-tenant' };
});
vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: async () => state.user
    ? { userId: state.user, tenantId: state.tenant, userEmail: 'fixture@example.test', userName: 'Fixture' } : null,
}));
vi.mock('@/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase');
  return {
    ...actual,
    isSupabaseConfigured: () => false,
    isSupabaseServerConfigured: () => false,
    getServerClientOrNull: () => null,
    createServerClient: vi.fn(actual.createServerClient),
  };
});
vi.mock('@/lib/db', async () => {
  const { sqliteDb } = await vi.importActual<typeof import('@/lib/db/sqlite')>('@/lib/db/sqlite');
  return { getDatabase: () => sqliteDb, isSqliteMode: () => true };
});
vi.mock('@/lib/intune/graph-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/intune/graph-client')>('@/lib/intune/graph-client');
  return {
    ...actual,
    getServicePrincipalToken: async () => 'offline-test-token',
    invalidateServicePrincipalToken: vi.fn(),
  };
});

import { sqliteDb, closeSqliteDb } from '@/lib/db/sqlite';
import { createServerClient } from '@/lib/supabase';
import { GET } from './route';

// Devices per detected-app (version) id. A device shared between versions must
// be deduplicated in the union.
const devicesByAppId = vi.hoisted(() => ({
  'app-old': [
    { id: 'device-1', deviceName: 'Laptop-1', operatingSystem: 'Windows 11' },
    { id: 'device-2', deviceName: 'Laptop-2', operatingSystem: 'Windows 11' },
  ],
  'app-new': [
    { id: 'device-1', deviceName: 'Laptop-1', operatingSystem: 'Windows 11' },
    { id: 'device-3', deviceName: 'Laptop-3', operatingSystem: 'Windows 10' },
  ],
}));

const fetchMock = vi.hoisted(() => vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const match = url.match(/detectedApps\/([^/]+)\/managedDevices/);
  const appId = match ? decodeURIComponent(match[1]) : '';
  const devices = devicesByAppId[appId] ?? [];
  return new Response(JSON.stringify({ value: devices }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}));

const requestedAppIds = () =>
  fetchMock.mock.calls.map(([url]) => {
    const match = String(url).match(/detectedApps\/([^/]+)\/managedDevices/);
    return match ? decodeURIComponent(match[1]) : null;
  }).filter(Boolean) as string[];

const drillDown = (appId: string) =>
  GET(new NextRequest(`http://localhost/api/intune/detected-app-devices?appId=${encodeURIComponent(appId)}`, {
    headers: { Authorization: 'Bearer fixture' },
  }));

describe('detected app devices with the SQLite adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = 'fixture-owner'; state.tenant = 'fixture-tenant';
    vi.stubGlobal('fetch', fetchMock);
  });
  afterAll(() => { closeSqliteDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('fans out over the stored group ids and returns the deduplicated union', async () => {
    await sqliteDb.discoveredAppGroups.replaceForTenant('fixture-tenant', [
      {
        tenant_id: 'fixture-tenant', discovered_app_id: 'app-new',
        merged_app_ids: ['app-old', 'app-new'], device_count: 9,
      },
    ]);

    const response = await drillDown('app-new');
    expect(response.status).toBe(200);
    const result = await response.json();

    expect(requestedAppIds().sort()).toEqual(['app-new', 'app-old']);
    expect(result.devices.map((device: { id: string }) => device.id).sort())
      .toEqual(['device-1', 'device-2', 'device-3']);
    expect(result.total).toBe(3);
    expect(result.summedDeviceCount).toBe(9);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('falls back to the single id when no group is stored', async () => {
    const response = await drillDown('unknown-app');
    expect(response.status).toBe(200);
    const result = await response.json();

    // The stub returns no devices for unknown ids; only the winner id is asked.
    expect(requestedAppIds()).toEqual(['unknown-app']);
    expect(result.devices).toEqual([]);
    expect(result.summedDeviceCount).toBeUndefined();
  });
});
