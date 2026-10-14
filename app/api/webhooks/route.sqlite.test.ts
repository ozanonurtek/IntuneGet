import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const auth = vi.hoisted(() => ({ parseAccessToken: vi.fn() }));
vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: auth.parseAccessToken }));
// SQLite mode must never construct a Supabase client.
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => {
    throw new Error('createServerClient must not be called in SQLite mode');
  },
  isSupabaseServerConfigured: () => false,
}));

let route: typeof import('./route');
let sqlite: typeof import('@/lib/db/sqlite');

// A Google Chat webhook URL is a secret (the query carries the key and token),
// so fixtures only ever carry placeholder values.
const chatUrl = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=fake-key&token=fake-token';

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_MODE = 'sqlite';
  process.env.DATABASE_PATH = ':memory:';
  auth.parseAccessToken.mockReset();
  auth.parseAccessToken.mockResolvedValue({ userId: 'user-a', tenantId: 'tenant-1' });
  vi.doMock('@/lib/db', async () => {
    const db = await import('@/lib/db/sqlite');
    return {
      getDatabase: () => db.sqliteDb,
      isSqliteMode: () => true,
      resetDatabaseInstance: () => {},
    };
  });
  sqlite = await import('@/lib/db/sqlite');
  route = await import('./route');
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Network forbidden in route tests');
  }));
});

afterEach(() => {
  sqlite.closeSqliteDb();
  vi.unstubAllGlobals();
  delete process.env.DATABASE_MODE;
  delete process.env.DATABASE_PATH;
});

const get = () => route.GET(new NextRequest('http://localhost/api/webhooks'));
const post = (body: unknown) =>
  new NextRequest('http://localhost/api/webhooks', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

describe('webhook list and create in SQLite mode', () => {
  it('stores a detected Google Chat webhook without logging or echoing its URL', async () => {
    const response = await route.POST(
      post({ name: 'Ops chat', url: chatUrl, secret: 'signing-secret' })
    );
    expect(response.status).toBe(201);
    const { webhook } = await response.json();
    expect(webhook).toMatchObject({
      name: 'Ops chat',
      webhook_type: 'googlechat',
      secret: '********',
      url: '********',
      is_enabled: true,
      failure_count: 0,
    });

    // The stored row keeps the real URL; only the API echoes it masked.
    const stored = await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'user-a');
    expect(stored?.url).toBe(chatUrl);

    const list = await route.GET(new NextRequest('http://localhost/api/webhooks'));
    expect(list.status).toBe(200);
    const { webhooks } = await list.json();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]).toMatchObject({ id: webhook.id, url: '********', secret: '********' });
  });

  it('keeps non-Google-Chat URLs visible in responses', async () => {
    const response = await route.POST(
      post({ name: 'Custom', url: 'https://example.test/hook', webhook_type: 'custom' })
    );
    expect(response.status).toBe(201);
    const { webhook } = await response.json();
    expect(webhook.url).toBe('https://example.test/hook');
    expect(webhook.secret).toBeNull();
  });

  it('rejects invalid input before touching storage', async () => {
    const cases = [
      { name: '', url: chatUrl },
      { name: 'Bad URL', url: 'http://chat.googleapis.com/v1/spaces/AAAA/messages' },
      { name: 'Bad type', url: 'https://example.test/hook', webhook_type: 'nope' },
    ];
    for (const body of cases) {
      const response = await route.POST(post(body));
      expect(response.status).toBe(400);
    }
    expect(await sqlite.sqliteDb.webhookConfigurations.count('user-a')).toBe(0);
  });

  it('enforces the ten webhook limit', async () => {
    for (let i = 0; i < 10; i++) {
      await sqlite.sqliteDb.webhookConfigurations.create({
        user_id: 'user-a',
        name: `hook ${i}`,
        url: chatUrl,
        webhook_type: 'googlechat',
      });
    }
    const response = await route.POST(post({ name: 'eleventh', url: chatUrl }));
    expect(response.status).toBe(400);
    expect(await sqlite.sqliteDb.webhookConfigurations.count('user-a')).toBe(10);
  });

  it('scopes the list to the signed-in user', async () => {
    await sqlite.sqliteDb.webhookConfigurations.create({
      user_id: 'user-b',
      name: 'Other user',
      url: 'https://example.test/hook',
      webhook_type: 'custom',
    });

    const response = await get();
    expect(await response.json()).toEqual({ webhooks: [] });
  });

  it('requires authentication', async () => {
    auth.parseAccessToken.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await route.POST(post({ name: 'x', url: chatUrl }))).status).toBe(401);
  });
});
