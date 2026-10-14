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
let testRoute: typeof import('./test/route');
let sqlite: typeof import('@/lib/db/sqlite');

// A Google Chat webhook URL is a secret, so fixtures only carry placeholders.
const chatUrl = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=fake-key&token=fake-token';

const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: unknown) =>
  new NextRequest('http://localhost/api/webhooks/local-webhook', {
    method,
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function create(userId = 'user-a', overrides: Record<string, unknown> = {}) {
  return sqlite.sqliteDb.webhookConfigurations.create({
    user_id: userId,
    name: 'Ops chat',
    url: chatUrl,
    webhook_type: 'googlechat',
    ...overrides,
  });
}

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
  testRoute = await import('./test/route');
});

afterEach(() => {
  sqlite.closeSqliteDb();
  vi.unstubAllGlobals();
  delete process.env.DATABASE_MODE;
  delete process.env.DATABASE_PATH;
});

describe('individual webhook routes in SQLite mode', () => {
  it('gets, renames and deletes a webhook owned by the signed-in user', async () => {
    const stored = await create();

    const fetched = await route.GET(request('GET'), context(stored.id));
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).webhook).toMatchObject({ id: stored.id, url: '********' });

    const renamed = await route.PUT(request('PUT', { name: '  Renamed  ' }), context(stored.id));
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).webhook).toMatchObject({ id: stored.id, name: 'Renamed', url: '********' });

    const deleted = await route.DELETE(request('DELETE'), context(stored.id));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true });
    expect(await sqlite.sqliteDb.webhookConfigurations.get(stored.id, 'user-a')).toBeNull();
  });

  it('treats the masked Google Chat URL as unchanged and applies a real replacement', async () => {
    const stored = await create();

    const masked = await route.PUT(request('PUT', { url: '********' }), context(stored.id));
    expect(masked.status).toBe(200);
    expect((await sqlite.sqliteDb.webhookConfigurations.get(stored.id, 'user-a'))?.url).toBe(chatUrl);

    const replacement = 'https://chat.googleapis.com/v1/spaces/BBBB/messages?key=k2&token=t2';
    const replaced = await route.PUT(request('PUT', { url: replacement }), context(stored.id));
    expect(replaced.status).toBe(200);
    expect((await sqlite.sqliteDb.webhookConfigurations.get(stored.id, 'user-a'))?.url).toBe(replacement);
  });

  it('does not expose or mutate another user’s webhook', async () => {
    const stored = await create('user-b');

    expect((await route.GET(request('GET'), context(stored.id))).status).toBe(404);
    expect((await route.PUT(request('PUT', { name: 'Hijack' }), context(stored.id))).status).toBe(404);
    expect((await route.DELETE(request('DELETE'), context(stored.id))).status).toBe(404);
    expect((await testRoute.POST(request('POST'), context(stored.id))).status).toBe(404);
    expect((await sqlite.sqliteDb.webhookConfigurations.get(stored.id, 'user-b'))?.name).toBe('Ops chat');
  });

  it('posts the Google Chat test card and records a success', async () => {
    const stored = await create();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await testRoute.POST(request('POST'), context(stored.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, statusCode: 200, error: undefined });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(chatUrl);
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['cardsV2', 'text']);
    expect(body.cardsV2[0].card.header.title).toBe('IntuneGet Webhook Test');
    expect(body.cardsV2[0].card.header.subtitle).toBe('Ops chat');

    const reread = await sqlite.sqliteDb.webhookConfigurations.get(stored.id, 'user-a');
    expect(reread).toMatchObject({ failure_count: 0, last_success_at: expect.any(String) });
  });

  it('increments and persists the circuit breaker counters on a failed test', async () => {
    const stored = await create();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await testRoute.POST(request('POST'), context(stored.id));
      expect((await response.json()).success).toBe(false);
      const reread = await sqlite.sqliteDb.webhookConfigurations.get(stored.id, 'user-a');
      expect(reread?.failure_count).toBe(attempt);
      expect(reread?.last_failure_at).toBeTruthy();
    }
  });

  it('requires authentication for every method', async () => {
    const stored = await create();
    auth.parseAccessToken.mockResolvedValue(null);
    expect((await route.GET(request('GET'), context(stored.id))).status).toBe(401);
    expect((await route.PUT(request('PUT', {}), context(stored.id))).status).toBe(401);
    expect((await route.DELETE(request('DELETE'), context(stored.id))).status).toBe(401);
    expect((await testRoute.POST(request('POST'), context(stored.id))).status).toBe(401);
  });
});
