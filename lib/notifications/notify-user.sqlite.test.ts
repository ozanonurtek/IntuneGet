import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliverWebhookMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/webhooks/service', () => ({ deliverWebhook: deliverWebhookMock }));
vi.mock('@/lib/email/service', () => ({
  sendUpdateNotificationEmail: vi.fn(),
  isEmailConfigured: () => false,
}));
// SQLite mode must never construct a Supabase client.
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => {
    throw new Error('createServerClient must not be called in SQLite mode');
  },
  isSupabaseServerConfigured: () => false,
}));

import {
  notifyUserOfPendingUpdatesSqlite,
  notifyWebhookUsersOfPendingUpdatesSqlite,
} from './notify-user';

let sqlite: typeof import('@/lib/db/sqlite');

// A Google Chat webhook URL is a secret, so fixtures only carry placeholders.
const chatUrl = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=fake-key&token=fake-token';

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_MODE = 'sqlite';
  process.env.DATABASE_PATH = ':memory:';
  deliverWebhookMock.mockReset();
  sqlite = await import('@/lib/db/sqlite');
});

afterEach(() => {
  sqlite.closeSqliteDb();
  delete process.env.DATABASE_MODE;
  delete process.env.DATABASE_PATH;
});

async function seedUpdate(userId = 'user-a', overrides: Record<string, unknown> = {}) {
  return sqlite.sqliteDb.updateCheckResults.upsert({
    user_id: userId,
    tenant_id: 'tenant-1',
    winget_id: 'Vendor.App',
    intune_app_id: 'app-1',
    display_name: 'App',
    current_version: '1.0',
    latest_version: '2.0',
    is_critical: false,
    ...overrides,
  });
}

async function seedWebhook(userId = 'user-a', overrides: Record<string, unknown> = {}) {
  return sqlite.sqliteDb.webhookConfigurations.create({
    user_id: userId,
    name: 'Ops chat',
    url: chatUrl,
    webhook_type: 'googlechat',
    ...overrides,
  });
}

describe('notifyUserOfPendingUpdatesSqlite', () => {
  it('delivers a pending update once and marks it notified', async () => {
    await seedUpdate();
    const webhook = await seedWebhook();
    deliverWebhookMock.mockResolvedValue({ success: true, statusCode: 200 });

    const first = await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect(first).toMatchObject({ webhooksSent: 1, emailsSent: 0, errors: [] });
    expect(first.notifiedUpdateIds).toHaveLength(1);
    expect(deliverWebhookMock).toHaveBeenCalledTimes(1);

    // The webhook payload is the same shape the hosted path sends.
    const [sentWebhook, sentPayload] = deliverWebhookMock.mock.calls[0];
    expect(sentWebhook).toMatchObject({ id: webhook.id, webhook_type: 'googlechat' });
    expect(sentPayload).toMatchObject({
      event: 'app_updates_available',
      tenant_id: 'tenant-1',
      summary: { total: 1, critical: 0 },
      updates: [
        { app_name: 'App', winget_id: 'Vendor.App', current_version: '1.0', latest_version: '2.0' },
      ],
    });

    const reread = await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'user-a');
    expect(reread).toMatchObject({ failure_count: 0, last_success_at: expect.any(String) });

    // Nothing pending and no second delivery on the next run.
    const second = await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect(second).toMatchObject({ webhooksSent: 0, notifiedUpdateIds: [] });
    expect(deliverWebhookMock).toHaveBeenCalledTimes(1);
    expect(await sqlite.sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(0);
  });

  it('leaves an ignored app pending and sends nothing', async () => {
    await seedUpdate();
    await seedWebhook();
    await sqlite.sqliteDb.updatePolicies.upsert({
      user_id: 'user-a',
      tenant_id: 'tenant-1',
      winget_id: 'Vendor.App',
      policy_type: 'ignore',
    });

    const result = await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect(result).toMatchObject({ webhooksSent: 0, notifiedUpdateIds: [] });
    expect(deliverWebhookMock).not.toHaveBeenCalled();
    // Skipped rows stay pending so removing the policy notifies later.
    expect(await sqlite.sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(1);
  });

  it('sends nothing when the user has no enabled webhook', async () => {
    await seedUpdate();
    await seedWebhook('user-a', { is_enabled: false });

    const result = await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect(result).toMatchObject({ webhooksSent: 0, notifiedUpdateIds: [] });
    expect(deliverWebhookMock).not.toHaveBeenCalled();
    expect(await sqlite.sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(1);
  });

  it('keeps the update pending after a failed delivery and records the error', async () => {
    await seedUpdate();
    const webhook = await seedWebhook();
    deliverWebhookMock.mockResolvedValue({ success: false, error: 'HTTP 500' });

    const result = await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect(result.webhooksSent).toBe(0);
    expect(result.notifiedUpdateIds).toEqual([]);
    expect(result.errors.join(' ')).toContain('HTTP 500');
    expect(await sqlite.sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(1);
    expect((await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'user-a'))?.failure_count).toBe(1);
  });

  it('resets the failure count on a later successful retry', async () => {
    await seedUpdate();
    const webhook = await seedWebhook();

    deliverWebhookMock.mockResolvedValue({ success: false, error: 'HTTP 500' });
    await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect((await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'user-a'))?.failure_count).toBe(1);

    deliverWebhookMock.mockResolvedValue({ success: true, statusCode: 200 });
    await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect((await sqlite.sqliteDb.webhookConfigurations.get(webhook.id, 'user-a'))).toMatchObject({
      failure_count: 0,
      last_success_at: expect.any(String),
    });
  });

  it('never throws when a webhook delivery itself rejects', async () => {
    await seedUpdate();
    await seedWebhook();
    deliverWebhookMock.mockRejectedValue(new Error('socket hang up'));

    const result = await notifyUserOfPendingUpdatesSqlite(sqlite.sqliteDb, 'user-a');
    expect(result.errors.join(' ')).toContain('socket hang up');
    expect(result.notifiedUpdateIds).toEqual([]);
  });
});

describe('notifyWebhookUsersOfPendingUpdatesSqlite', () => {
  it('notifies every user with an enabled webhook and isolates one failure', async () => {
    await seedUpdate('user-a');
    await seedUpdate('user-b', { intune_app_id: 'app-b' });
    await seedWebhook('user-a');
    await seedWebhook('user-b', { name: 'Broken' });

    deliverWebhookMock.mockImplementation(async (webhook: { name: string }) =>
      webhook.name === 'Broken' ? { success: false, error: 'HTTP 500' } : { success: true, statusCode: 200 }
    );

    const summary = await notifyWebhookUsersOfPendingUpdatesSqlite(sqlite.sqliteDb);
    expect(summary).toMatchObject({ usersChecked: 2, webhooksSent: 1, updatesNotified: 1 });
    expect(summary.errors.join(' ')).toContain('Broken');

    // user-a's update is announced; user-b's stays pending for the next run.
    expect(await sqlite.sqliteDb.updateCheckResults.list('user-a', { pendingOnly: true })).toHaveLength(0);
    expect(await sqlite.sqliteDb.updateCheckResults.list('user-b', { pendingOnly: true })).toHaveLength(1);
  });

  it('does not throw when the webhook user list cannot be read', async () => {
    const brokenDb = {
      webhookConfigurations: {
        listEnabledUserIds: async () => {
          throw new Error('database is locked');
        },
      },
    } as unknown as Parameters<typeof notifyWebhookUsersOfPendingUpdatesSqlite>[0];

    const summary = await notifyWebhookUsersOfPendingUpdatesSqlite(brokenDb);
    expect(summary.usersChecked).toBe(0);
    expect(summary.errors.join(' ')).toContain('database is locked');
  });
});
