import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SQLite adapter must never construct a Supabase client; a transitive
// import that does fails the test instead of silently talking to a service.
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => {
    throw new Error('createServerClient must not be called in SQLite mode');
  },
  isSupabaseServerConfigured: () => false,
}));

let sqliteDb: typeof import('../sqlite').sqliteDb;
let closeDb: typeof import('../sqlite').closeSqliteDb;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('DATABASE_MODE', 'sqlite');
  vi.stubEnv('DATABASE_PATH', ':memory:');
  const mod = await import('../sqlite');
  sqliteDb = mod.sqliteDb;
  closeDb = mod.closeSqliteDb;
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
});

// Google Chat URLs are secrets; fixtures carry only placeholder values.
const googleChatUrl =
  'https://chat.googleapis.com/v1/spaces/AAAAAAAAAAA/messages?key=fake-key&token=fake-token';

async function createWebhook(
  overrides: Partial<Parameters<typeof sqliteDb.webhookConfigurations.create>[0]> = {}
) {
  return sqliteDb.webhookConfigurations.create({
    user_id: 'user-a',
    name: 'Chat hook',
    url: googleChatUrl,
    webhook_type: 'googlechat',
    ...overrides,
  });
}

describe('webhook configurations in SQLite', () => {
  it('stores a webhook with defaults and returns it parsed', async () => {
    const stored = await createWebhook({ headers: { 'X-Custom': '1' } });

    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored).toMatchObject({
      user_id: 'user-a',
      name: 'Chat hook',
      url: googleChatUrl,
      webhook_type: 'googlechat',
      headers: { 'X-Custom': '1' },
      is_enabled: true,
      failure_count: 0,
      secret: null,
      last_failure_at: null,
      last_success_at: null,
      tenant_id: null,
    });
    // Re-read through a fresh adapter call: headers survive as JSON.
    const reread = await sqliteDb.webhookConfigurations.get(stored.id, 'user-a');
    expect(reread?.headers).toEqual({ 'X-Custom': '1' });
  });

  it('lists only the owning user and counts their webhooks', async () => {
    await createWebhook({ name: 'A1' });
    await createWebhook({ user_id: 'user-b', name: 'B1' });

    expect(await sqliteDb.webhookConfigurations.count('user-a')).toBe(1);
    expect((await sqliteDb.webhookConfigurations.list('user-a')).map((w) => w.name)).toEqual(['A1']);
    expect((await sqliteDb.webhookConfigurations.list('user-b')).map((w) => w.name)).toEqual(['B1']);
  });

  it('scopes get, update and delete to the owning user', async () => {
    const stored = await createWebhook();

    expect(await sqliteDb.webhookConfigurations.get(stored.id, 'user-b')).toBeNull();
    expect(await sqliteDb.webhookConfigurations.update(stored.id, 'user-b', { name: 'Nope' })).toBeNull();
    expect(await sqliteDb.webhookConfigurations.delete(stored.id, 'user-b')).toBe(false);

    const updated = await sqliteDb.webhookConfigurations.update(stored.id, 'user-a', {
      name: 'Renamed',
      is_enabled: false,
    });
    expect(updated).toMatchObject({ name: 'Renamed', is_enabled: false, url: googleChatUrl });

    expect(await sqliteDb.webhookConfigurations.delete(stored.id, 'user-a')).toBe(true);
    expect(await sqliteDb.webhookConfigurations.get(stored.id, 'user-a')).toBeNull();
  });

  it('updates the secret only when the field is explicitly present', async () => {
    const stored = await createWebhook();

    const untouched = await sqliteDb.webhookConfigurations.update(stored.id, 'user-a', { name: 'Keep secret' });
    expect(untouched?.secret).toBeNull();

    const cleared = await sqliteDb.webhookConfigurations.update(stored.id, 'user-a', { secret: null });
    expect(cleared?.secret).toBeNull();

    const set = await sqliteDb.webhookConfigurations.update(stored.id, 'user-a', { secret: 's3cret' });
    expect(set?.secret).toBe('s3cret');

    const changed = await sqliteDb.webhookConfigurations.update(stored.id, 'user-a', { name: 'Again' });
    expect(changed?.secret).toBe('s3cret');
  });

  it('reports every user with an enabled webhook', async () => {
    expect(await sqliteDb.webhookConfigurations.listEnabledUserIds()).toEqual([]);

    const a = await createWebhook();
    await createWebhook({ user_id: 'user-b', is_enabled: false });
    await createWebhook({ user_id: 'user-c' });

    expect(await sqliteDb.webhookConfigurations.listEnabledUserIds()).toEqual(['user-a', 'user-c']);

    await sqliteDb.webhookConfigurations.update(a.id, 'user-a', { is_enabled: false });
    expect(await sqliteDb.webhookConfigurations.listEnabledUserIds()).toEqual(['user-c']);
  });

  it('persists circuit breaker counters across reads', async () => {
    const stored = await createWebhook();

    await sqliteDb.webhookConfigurations.markDelivery(stored.id, 'user-a', false, 1);
    let reread = await sqliteDb.webhookConfigurations.get(stored.id, 'user-a');
    expect(reread).toMatchObject({ failure_count: 1, last_failure_at: expect.any(String), last_success_at: null });

    await sqliteDb.webhookConfigurations.markDelivery(stored.id, 'user-a', false, 2);
    reread = await sqliteDb.webhookConfigurations.get(stored.id, 'user-a');
    expect(reread?.failure_count).toBe(2);

    await sqliteDb.webhookConfigurations.markDelivery(stored.id, 'user-a', true, 0);
    reread = await sqliteDb.webhookConfigurations.get(stored.id, 'user-a');
    expect(reread).toMatchObject({
      failure_count: 0,
      last_success_at: expect.any(String),
      // A success keeps the last failure stamp, like the hosted path.
      last_failure_at: expect.any(String),
    });
  });

  it('marks pending update results notified and keeps them out of pendingOnly', async () => {
    const result = await sqliteDb.updateCheckResults.upsert({
      user_id: 'user-a',
      tenant_id: 'tenant-1',
      winget_id: 'Vendor.App',
      intune_app_id: 'app-1',
      display_name: 'App',
      current_version: '1.0',
      latest_version: '2.0',
      is_critical: true,
    });

    expect(await sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(1);

    const changed = await sqliteDb.updateCheckResults.setNotified([result.id], 'user-a', new Date().toISOString());
    expect(changed).toBe(1);
    expect(await sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(0);
    expect(await sqliteDb.updateCheckResults.list('user-a', {})).toHaveLength(1);
  });

  it('resets notified_at when the detected version changes and keeps it otherwise', async () => {
    const base = {
      user_id: 'user-a',
      tenant_id: 'tenant-1',
      winget_id: 'Vendor.App',
      intune_app_id: 'app-1',
      display_name: 'App',
      current_version: '1.0',
    };
    await sqliteDb.updateCheckResults.upsert({ ...base, latest_version: '2.0' });

    const [first] = await sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true });
    await sqliteDb.updateCheckResults.setNotified([first.id], 'user-a', new Date().toISOString());

    // Same latest version: the announcement state survives the re-check.
    await sqliteDb.updateCheckResults.upsert({ ...base, latest_version: '2.0' });
    expect(await sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(0);

    // A new latest version must be announced again.
    await sqliteDb.updateCheckResults.upsert({ ...base, latest_version: '3.0' });
    expect(await sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(1);
  });
});
