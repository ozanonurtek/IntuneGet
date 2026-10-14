import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parseAccessTokenMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: parseAccessTokenMock }));

// The catalog is stubbed so the check has a latest version without the network.
const catalog = vi.hoisted(() => ({
  apps: [] as Array<{ winget_id: string; latest_version: string }>,
}));
vi.mock('@/lib/catalog', () => ({
  getCatalogSource: () => ({
    getAppsByWingetIds: async (ids: string[]) =>
      catalog.apps.filter((app) => ids.includes(app.winget_id)),
  }),
}));

// The SQLite path schedules the notifier through after(); capture the callback.
const afterMock = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: afterMock,
}));

const notifySqliteMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notifications/notify-user', () => ({
  notifyUserOfPendingUpdates: vi.fn(),
  notifyUserOfPendingUpdatesSqlite: notifySqliteMock,
}));

let tempDir: string;
let route: typeof import('@/app/api/updates/refresh/route');
let sqlite: typeof import('@/lib/db/sqlite');

beforeEach(async () => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), 'intuneget-refresh-'));
  process.env.DATABASE_MODE = 'sqlite';
  process.env.DATABASE_PATH = join(tempDir, 'app.db');
  process.env.PACKAGER_API_KEY = 'test';
  catalog.apps = [];
  afterMock.mockReset();
  notifySqliteMock.mockReset();
  parseAccessTokenMock.mockReset();
  parseAccessTokenMock.mockResolvedValue({ userId: 'u1', tenantId: 't1' });
  vi.doMock('@/lib/db', async () => {
    const mod = await import('@/lib/db/sqlite');
    return {
      getDatabase: () => mod.sqliteDb,
      isSqliteMode: () => true,
      resetDatabaseInstance: () => {},
    };
  });
  sqlite = await import('@/lib/db/sqlite');
  route = await import('@/app/api/updates/refresh/route');
});

afterEach(async () => {
  sqlite.closeSqliteDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DATABASE_MODE;
  delete process.env.DATABASE_PATH;
  delete process.env.PACKAGER_API_KEY;
});

function request(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/updates/refresh', {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('updates refresh route in SQLite mode', () => {
  it('runs the catalog check and returns the SQLite summary', async () => {
    const response = await route.POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, mode: 'sqlite', refreshedCount: 0, updateCount: 0 });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('returns 401 without a token', async () => {
    parseAccessTokenMock.mockResolvedValue(null);
    const response = await route.POST(request());
    expect(response.status).toBe(401);
  });

  it('schedules the SQLite notifier after responding when an update is available', async () => {
    catalog.apps = [{ winget_id: 'Vendor.App', latest_version: '2.0' }];
    await sqlite.sqliteDb.uploadHistory.create({
      user_id: 'u1',
      winget_id: 'Vendor.App',
      version: '1.0',
      display_name: 'App',
      intune_app_id: 'app-1',
      intune_tenant_id: 't1',
    });

    const response = await route.POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'sqlite', refreshedCount: 1, updateCount: 1 });

    expect(notifySqliteMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledOnce();
    await afterMock.mock.calls[0][0]();
    expect(notifySqliteMock).toHaveBeenCalledWith(expect.anything(), 'u1');
  });
});
