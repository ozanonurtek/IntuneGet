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
    createServerClient: vi.fn(actual.createServerClient),
  };
});
vi.mock('@/lib/db', async () => {
  const { sqliteDb } = await vi.importActual<typeof import('@/lib/db/sqlite')>('@/lib/db/sqlite');
  return { getDatabase: () => sqliteDb, isSqliteMode: () => true };
});
vi.mock('@/lib/intune/graph-client', () => ({
  getServicePrincipalToken: async () => 'offline-test-token',
  invalidateServicePrincipalToken: vi.fn(),
}));
vi.mock('@/lib/matching/app-matcher', () => ({
  filterUserApps: (apps: unknown[]) => apps,
  isSystemApp: () => false,
  normalizeAppName: (name: string) => name.toLowerCase(),
  matchDiscoveredApp: () => ({ status: 'unmatched', wingetId: null, wingetName: null, confidence: 0, partialMatches: [] }),
}));

import { sqliteDb, closeSqliteDb } from '@/lib/db/sqlite';
import { createServerClient } from '@/lib/supabase';
import { GET } from './route';

const list = () => GET(new NextRequest('http://localhost/api/intune/unmanaged-apps?refresh=true', {
  headers: { Authorization: 'Bearer fixture' },
}));

const scanWith = (apps: Array<Record<string, unknown>>) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: apps }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));

describe('unmanaged apps with the SQLite adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = 'fixture-owner'; state.tenant = 'fixture-tenant';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: [
      { id: 'app-one', displayName: 'First app', platform: 'windows', deviceCount: 3 },
      { id: 'app-two', displayName: 'Second app', platform: 'windows', deviceCount: 2 },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  });
  afterAll(() => { closeSqliteDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('applies SQLite manual mappings and claims to the live scan', async () => {
    await sqliteDb.manualAppMappings.upsert({
      discovered_app_name: 'First app', discovered_publisher: null,
      winget_package_id: 'Mapped.App', tenant_id: 'fixture-tenant', created_by: 'fixture-owner',
    });
    await sqliteDb.claimedApps.upsert({
      user_id: 'fixture-owner', tenant_id: 'fixture-tenant', discovered_app_id: 'app-two',
      discovered_app_name: 'Second app', winget_package_id: 'Claimed.App', device_count_at_claim: 2,
    });

    const response = await list();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.fromCache).toBe(false);

    const mapped = result.apps.find((app: { discoveredAppId: string }) => app.discoveredAppId === 'app-one');
    expect(mapped).toMatchObject({
      matchStatus: 'matched', matchedPackageId: 'Mapped.App', matchConfidence: 1.0,
      isClaimed: false,
    });

    const claimed = result.apps.find((app: { discoveredAppId: string }) => app.discoveredAppId === 'app-two');
    expect(claimed).toMatchObject({ isClaimed: true, claimStatus: 'pending' });

    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('stores one group per merged app with both version ids and the summed count', async () => {
    scanWith([
      { id: 'chrome-137', displayName: 'Google Chrome', version: '137.0.0.0', publisher: 'Google LLC', platform: 'windows', deviceCount: 40 },
      { id: 'chrome-138', displayName: 'Google Chrome', version: '138.0.0.0', publisher: 'Google LLC', platform: 'windows', deviceCount: 22 },
      { id: 'solo-app', displayName: 'Solo App', version: '1.0.0', publisher: 'Solo Ltd', platform: 'windows', deviceCount: 4 },
    ]);

    const response = await list();
    expect(response.status).toBe(200);
    const result = await response.json();

    // One card for Chrome, keyed by the newest version's id, summing both.
    const chrome = result.apps.find((app: { discoveredAppId: string }) => app.discoveredAppId === 'chrome-138');
    expect(chrome).toMatchObject({ displayName: 'Google Chrome', version: '138.0.0.0', deviceCount: 62 });

    const chromeGroup = await sqliteDb.discoveredAppGroups.get('fixture-tenant', 'chrome-138');
    expect(chromeGroup).toMatchObject({
      tenant_id: 'fixture-tenant',
      discovered_app_id: 'chrome-138',
      merged_app_ids: ['chrome-137', 'chrome-138'],
      device_count: 62,
    });

    const soloGroup = await sqliteDb.discoveredAppGroups.get('fixture-tenant', 'solo-app');
    expect(soloGroup).toMatchObject({ merged_app_ids: ['solo-app'], device_count: 4 });

    expect(await sqliteDb.discoveredAppGroups.get('fixture-tenant', 'chrome-137')).toBeNull();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('replaces the tenant groups on a second scan', async () => {
    scanWith([
      { id: 'old-winner', displayName: 'Replaced App', version: '1.0.0', publisher: 'Replaced Ltd', platform: 'windows', deviceCount: 5 },
    ]);
    expect((await list()).status).toBe(200);
    expect(await sqliteDb.discoveredAppGroups.get('fixture-tenant', 'old-winner')).not.toBeNull();

    scanWith([
      { id: 'new-winner', displayName: 'Fresh App', version: '2.0.0', publisher: 'Fresh Ltd', platform: 'windows', deviceCount: 7 },
    ]);
    const response = await list();
    expect(response.status).toBe(200);

    expect(await sqliteDb.discoveredAppGroups.get('fixture-tenant', 'old-winner')).toBeNull();
    expect(await sqliteDb.discoveredAppGroups.get('fixture-tenant', 'new-winner')).toMatchObject({
      merged_app_ids: ['new-winner'],
      device_count: 7,
    });
  });
});
