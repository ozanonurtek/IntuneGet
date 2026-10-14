import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The catalog is stubbed so the check has a latest version to compare against
// without touching the network.
const catalog = vi.hoisted(() => ({
  apps: [] as Array<{ winget_id: string; latest_version: string }>,
}));
vi.mock('@/lib/catalog', () => ({
  getCatalogSource: () => ({
    getAppsByWingetIds: async (ids: string[]) =>
      catalog.apps.filter((app) => ids.includes(app.winget_id)),
  }),
}));

let tempDir: string;
let route: typeof import('@/app/api/cron/check-updates/route');
let sqlite: typeof import('@/lib/db/sqlite');

// A Google Chat webhook URL is a secret, so fixtures only carry placeholders.
const chatUrl = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=fake-key&token=fake-token';

beforeEach(async () => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), 'intuneget-cron-'));
  process.env.DATABASE_MODE = 'sqlite';
  process.env.DATABASE_PATH = join(tempDir, 'app.db');
  process.env.PACKAGER_API_KEY = 'test';
  delete process.env.CRON_SECRET;
  catalog.apps = [];
  vi.doMock('@/lib/db', async () => {
    const mod = await import('@/lib/db/sqlite');
    return {
      getDatabase: () => mod.sqliteDb,
      isSqliteMode: () => true,
      resetDatabaseInstance: () => {},
    };
  });
  sqlite = await import('@/lib/db/sqlite');
  route = await import('@/app/api/cron/check-updates/route');
});

afterEach(async () => {
  sqlite.closeSqliteDb();
  vi.unstubAllGlobals();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DATABASE_MODE;
  delete process.env.DATABASE_PATH;
  delete process.env.PACKAGER_API_KEY;
  delete process.env.CRON_SECRET;
});

function request(secret?: string): Request {
  return new Request('http://localhost/api/cron/check-updates', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

async function seedDeploymentAndWebhook() {
  await sqlite.sqliteDb.uploadHistory.create({
    user_id: 'u1',
    winget_id: 'Vendor.App',
    version: '1.0',
    display_name: 'App',
    intune_app_id: 'app-1',
    intune_tenant_id: 'tenant-1',
  });
  return sqlite.sqliteDb.webhookConfigurations.create({
    user_id: 'u1',
    name: 'Ops chat',
    url: chatUrl,
    webhook_type: 'googlechat',
  });
}

describe('check-updates cron in SQLite mode', () => {
  it('rejects every request when CRON_SECRET is not configured', async () => {
    expect((await route.GET(request())).status).toBe(401);
    expect((await route.GET(request('undefined'))).status).toBe(401);
  });

  it('runs the SQLite check when the secret matches', async () => {
    process.env.CRON_SECRET = 'secret';
    const response = await route.GET(request('secret'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: 'sqlite',
      available: 0,
      triggered: 0,
      notifications: { usersChecked: 0, webhooksSent: 0, updatesNotified: 0 },
    });
  });

  it('rejects a wrong secret', async () => {
    process.env.CRON_SECRET = 'secret';
    expect((await route.GET(request('other'))).status).toBe(401);
  });

  it('delivers a pending update once and not again on the next run', async () => {
    process.env.CRON_SECRET = 'secret';
    catalog.apps = [{ winget_id: 'Vendor.App', latest_version: '2.0' }];
    const webhook = await seedDeploymentAndWebhook();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await route.GET(request('secret'));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      success: true,
      available: 1,
      notifications: { usersChecked: 1, webhooksSent: 1, updatesNotified: 1 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(chatUrl);
    const body = JSON.parse(init.body as string);
    expect(body.cardsV2[0].card.header.title).toContain('App Update');
    // 1.0 -> 2.0 is a major bump, so the app is marked critical.
    expect(body.cardsV2[0].card.sections[0].header).toBe('App (critical)');

    const reread = await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'u1');
    expect(reread).toMatchObject({ failure_count: 0, last_success_at: expect.any(String) });

    // The next nightly run sees the same version already notified.
    const second = await route.GET(request('secret'));
    expect(await second.json()).toMatchObject({
      notifications: { usersChecked: 1, webhooksSent: 0, updatesNotified: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the run healthy when a delivery fails and retries it next time', async () => {
    process.env.CRON_SECRET = 'secret';
    catalog.apps = [{ winget_id: 'Vendor.App', latest_version: '2.0' }];
    const webhook = await seedDeploymentAndWebhook();
    // A 4xx is not retried by deliverWebhook, keeping the test fast and the
    // call count deterministic.
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await route.GET(request('secret'));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.success).toBe(true);
    expect(firstBody.notifications.webhooksSent).toBe(0);
    expect(firstBody.notifications.errors.join(' ')).toContain('HTTP 400');

    // The failure is recorded and the update stays pending for a retry.
    expect((await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'u1'))?.failure_count).toBe(1);
    expect(await sqlite.sqliteDb.updateCheckResults.list('u1', { pendingOnly: true })).toHaveLength(1);

    const second = await route.GET(request('secret'));
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'u1'))?.failure_count).toBe(2);
  });
});
