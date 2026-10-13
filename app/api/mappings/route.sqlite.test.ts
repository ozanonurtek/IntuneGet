import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => {
  vi.stubEnv('DATABASE_PATH', ':memory:');
  vi.stubEnv('DATABASE_MODE', 'sqlite');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  return { user: 'fixture-owner' as string | null, tenant: 'fixture-tenant', sqlite: true };
});
vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: async () => state.user
    ? { userId: state.user, tenantId: state.tenant, userEmail: 'fixture@example.test', userName: 'Fixture' } : null,
}));
vi.mock('@/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase');
  return { ...actual, createServerClient: vi.fn(actual.createServerClient) };
});
vi.mock('@/lib/db', async () => {
  const { sqliteDb } = await vi.importActual<typeof import('@/lib/db/sqlite')>('@/lib/db/sqlite');
  return { getDatabase: () => sqliteDb, isSqliteMode: () => state.sqlite };
});

import { sqliteDb, closeSqliteDb } from '@/lib/db/sqlite';
import { createServerClient } from '@/lib/supabase';
import { GET, POST, DELETE } from './route';

const request = (method: string, body?: unknown) => new NextRequest('http://localhost/api/mappings', {
  method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const deleteRequest = (id?: string) => new NextRequest(`http://localhost/api/mappings${id ? `?id=${id}` : ''}`, {
  method: 'DELETE', headers: { Authorization: 'Bearer fixture' },
});
const mappingBody = (discoveredAppName = 'Fixture App', wingetPackageId = 'Fixture.App') => ({
  discoveredAppName, discoveredPublisher: 'Fixture Publisher', wingetPackageId,
});
const stored = (tenantId = 'fixture-tenant') => sqliteDb.manualAppMappings.listForTenant(tenantId);

describe('manual app mappings with the SQLite adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = 'fixture-owner'; state.tenant = 'fixture-tenant'; state.sqlite = true;
  });
  afterAll(() => { closeSqliteDb(); vi.unstubAllEnvs(); });

  it('creates a mapping for the signed in tenant without Supabase', async () => {
    const response = await POST(request('POST', mappingBody('  Fixture APP  ')));
    expect(response.status).toBe(201);
    const { mapping, updated } = await response.json();
    expect(updated).toBe(false);
    expect(mapping).toMatchObject({
      discoveredAppName: 'fixture app',
      discoveredPublisher: 'Fixture Publisher',
      wingetPackageId: 'Fixture.App',
      tenantId: 'fixture-tenant',
      createdBy: 'fixture-owner',
      isVerified: false,
    });
    expect((await stored()).find(row => row.discovered_app_name === 'fixture app')?.id).toBe(mapping.id);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('updates the mapping in place when the same name is linked again', async () => {
    const first = await (await POST(request('POST', mappingBody('Fixture App')))).json();
    const response = await POST(request('POST', mappingBody('  fixture APP  ', 'Fixture.Renamed')));
    expect(response.status).toBe(200);
    const { mapping, updated } = await response.json();
    expect(updated).toBe(true);
    expect(mapping).toMatchObject({ id: first.mapping.id, wingetPackageId: 'Fixture.Renamed' });
    expect((await stored()).filter(row => row.discovered_app_name === 'fixture app')).toHaveLength(1);
  });

  it('validates input and authentication before storing', async () => {
    const before = (await stored()).length;
    expect((await POST(request('POST', { discoveredAppName: 'Only Name' }))).status).toBe(400);
    state.user = null;
    expect((await POST(request('POST', mappingBody()))).status).toBe(401);
    expect((await GET(request('GET'))).status).toBe(401);
    expect((await DELETE(deleteRequest('fixture'))).status).toBe(401);
    expect((await stored()).length).toBe(before);
  });

  it('lists the tenant mappings and global ones, not another tenant\'s', async () => {
    await POST(request('POST', mappingBody('Own App')));
    await sqliteDb.manualAppMappings.upsert({
      discovered_app_name: 'Global App', discovered_publisher: null,
      winget_package_id: 'Global.App', tenant_id: null, created_by: null,
    });
    state.tenant = 'other-fixture-tenant';
    await POST(request('POST', mappingBody('Other App')));
    state.tenant = 'fixture-tenant';

    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    const names = (await response.json()).mappings.map((mapping: { discoveredAppName: string }) => mapping.discoveredAppName);
    expect(names).toContain('own app');
    expect(names).toContain('global app');
    expect(names).not.toContain('other app');
  });

  it('deletes the tenant mapping and refuses another tenant\'s', async () => {
    state.tenant = 'other-fixture-tenant';
    const { mapping: foreign } = await (await POST(request('POST', mappingBody('Foreign App')))).json();
    state.tenant = 'fixture-tenant';
    const { mapping: own } = await (await POST(request('POST', mappingBody('Disposable App')))).json();

    const missing = await DELETE(deleteRequest('no-such-mapping-id'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Mapping not found' });

    const forbidden = await DELETE(deleteRequest(foreign.id));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'Unauthorized to delete this mapping' });
    expect((await sqliteDb.manualAppMappings.getById(foreign.id))?.id).toBe(foreign.id);

    expect(await (await DELETE(deleteRequest(own.id))).json()).toEqual({ success: true });
    expect(await sqliteDb.manualAppMappings.getById(own.id)).toBeNull();
  });

  it('still reports that manual mappings need hosted services outside SQLite mode', async () => {
    state.sqlite = false;
    expect((await POST(request('POST', mappingBody()))).status).toBe(503);
    expect((await DELETE(deleteRequest('fixture'))).status).toBe(503);
    expect(await (await GET(request('GET'))).json()).toEqual({ mappings: [] });
    expect(createServerClient).not.toHaveBeenCalled();
  });
});
