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
});
