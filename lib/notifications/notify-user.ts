/**
 * Per-user update notification dispatch.
 *
 * Shared by the daily send-notifications cron and the on-demand
 * /api/updates/refresh route so update notifications go out the same way
 * whether they are batched nightly or triggered right after a user-facing
 * refresh detects a new update. Keeping this in one place avoids the two
 * paths drifting apart.
 *
 * A self-hosted SQLite deployment has no Supabase, so it uses the sibling
 * SQLite functions below, which read pending updates and enabled webhooks
 * through the database adapter. Email notifications stay Supabase-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendUpdateNotificationEmail, isEmailConfigured } from '@/lib/email/service';
import { deliverWebhook } from '@/lib/webhooks/service';
import type { DatabaseAdapter } from '@/lib/db/types';
import type {
  NotificationPreferences,
  WebhookConfiguration,
  UpdateCheckResult,
  NotificationPayload,
  AppUpdate,
} from '@/types/notifications';
import { shouldSkipUpdate, type AppUpdatePolicy } from '@/types/update-policies';

interface UserProfile {
  id: string;
  email: string | null;
  name: string | null;
  tenant_name: string | null;
}

export interface NotifyUserResult {
  emailsSent: number;
  webhooksSent: number;
  notifiedUpdateIds: string[];
  errors: string[];
}

/**
 * Determine if an email notification should be sent based on frequency.
 * daily/immediate: always send (the cron runs daily; immediate means "now").
 * weekly: only on Sundays.
 */
export function shouldSendBasedOnFrequency(frequency: string): boolean {
  if (frequency === 'weekly') {
    return new Date().getDay() === 0;
  }
  // daily and immediate both send on this run
  return true;
}

/**
 * Send email + webhook notifications for a single user's pending updates and
 * mark the delivered ones notified. Updates skipped by the user's ignore or
 * pin policy are neither sent nor marked notified.
 *
 * @param pendingUpdates Optional preloaded pending rows for the user. When
 *   omitted, the function loads update_check_results rows with notified_at and
 *   dismissed_at null itself. Pass `respectFrequency: false` to force-send
 *   regardless of the user's email frequency (used by on-demand refresh, where
 *   the user just asked for a check).
 */
export async function notifyUserOfPendingUpdates(
  supabase: SupabaseClient,
  userId: string,
  options: {
    pendingUpdates?: UpdateCheckResult[];
    respectFrequency?: boolean;
  } = {}
): Promise<NotifyUserResult> {
  const respectFrequency = options.respectFrequency ?? true;

  const result: NotifyUserResult = {
    emailsSent: 0,
    webhooksSent: 0,
    notifiedUpdateIds: [],
    errors: [],
  };

  // Load pending updates for the user if not supplied
  let updates = options.pendingUpdates;
  if (!updates) {
    const { data, error } = await supabase
      .from('update_check_results')
      .select('*')
      .eq('user_id', userId)
      .is('notified_at', null)
      .is('dismissed_at', null)
      .order('detected_at', { ascending: false });
    if (error) {
      result.errors.push(`Error fetching pending updates: ${error.message}`);
      return result;
    }
    updates = (data as UpdateCheckResult[]) || [];
  }

  if (updates.length === 0) {
    return result;
  }

  // Respect the per-app update policies the same way the update check and
  // auto-update paths do: an ignored app, or a pinned app whose detected
  // version is not the pinned one, never produces a notification. The refresh
  // route stores rows for those apps too (the Updates page shows them), so
  // they have to be filtered here.
  //
  // Skipped rows are deliberately NOT marked notified. They stay pending and
  // are skipped again on every run while the policy applies. If the admin
  // removes the ignore policy or the detected version becomes the pinned one,
  // the next run notifies about it instead of the update being silently
  // swallowed. If the policies cannot be loaded, send nothing and leave every
  // row pending so the next run retries; a late notification is better than
  // one for an app the admin chose to ignore.
  const policies = await loadUpdatePolicies(supabase, userId);
  if ('error' in policies) {
    result.errors.push(`Error fetching update policies: ${policies.error}`);
    return result;
  }
  const policyByApp = new Map<string, NotificationPolicy>();
  policies.rows.forEach((policy) => {
    policyByApp.set(`${policy.tenant_id}:${policy.winget_id}`, policy);
  });
  updates = updates.filter(
    (u) => !shouldSkipUpdate(policyByApp.get(`${u.tenant_id}:${u.winget_id}`), u.latest_version)
  );

  if (updates.length === 0) {
    return result;
  }

  const [{ data: prefsRow }, { data: webhookRows }, { data: profileRow }] =
    await Promise.all([
      supabase.from('notification_preferences').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('webhook_configurations').select('*').eq('user_id', userId).eq('is_enabled', true),
      supabase.from('user_profiles').select('id, email, name, tenant_name').eq('id', userId).maybeSingle(),
    ]);

  const prefs = (prefsRow as NotificationPreferences | null) || undefined;
  const userWebhooks = (webhookRows as WebhookConfiguration[] | null) || [];
  const profile = (profileRow as UserProfile | null) || undefined;

  // Filter updates based on preferences
  let filteredUpdates = updates;
  if (prefs?.notify_critical_only) {
    filteredUpdates = updates.filter((u) => u.is_critical);
  }

  if (filteredUpdates.length === 0) {
    // Nothing matches the user's filter; mark all as notified so they are not
    // reconsidered every run.
    result.notifiedUpdateIds.push(...updates.map((u) => u.id));
    await markNotified(supabase, result.notifiedUpdateIds);
    return result;
  }

  // Group by tenant for payload
  const tenantUpdates = new Map<string, UpdateCheckResult[]>();
  filteredUpdates.forEach((u) => {
    if (!tenantUpdates.has(u.tenant_id)) {
      tenantUpdates.set(u.tenant_id, []);
    }
    tenantUpdates.get(u.tenant_id)!.push(u);
  });

  for (const [tenantId, tenantUpdateList] of tenantUpdates) {
    const appUpdates: AppUpdate[] = tenantUpdateList.map((u) => ({
      app_name: u.display_name,
      winget_id: u.winget_id,
      intune_app_id: u.intune_app_id,
      current_version: u.current_version,
      latest_version: u.latest_version,
      is_critical: u.is_critical,
    }));

    const criticalCount = appUpdates.filter((u) => u.is_critical).length;

    const payload: NotificationPayload = {
      event: 'app_updates_available',
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      tenant_name: profile?.tenant_name || undefined,
      updates: appUpdates,
      summary: { total: appUpdates.length, critical: criticalCount },
    };

    let delivered = false;

    // Send email if enabled and configured
    if (prefs?.email_enabled && isEmailConfigured()) {
      const shouldSendEmail = !respectFrequency || shouldSendBasedOnFrequency(prefs.email_frequency);
      if (shouldSendEmail) {
        const emailAddress = prefs.email_address || profile?.email;
        if (emailAddress) {
          const emailResult = await sendUpdateNotificationEmail(
            emailAddress,
            payload,
            profile?.name || undefined
          );

          await supabase.from('notification_history').insert({
            user_id: userId,
            channel: 'email',
            payload,
            status: emailResult.success ? 'sent' : 'failed',
            error_message: emailResult.error || null,
            apps_notified: appUpdates.length,
            sent_at: emailResult.success ? new Date().toISOString() : null,
          });

          if (emailResult.success) {
            delivered = true;
            result.emailsSent++;
          } else {
            result.errors.push(`Email to ${emailAddress} failed: ${emailResult.error}`);
          }
        } else {
          result.errors.push(
            `No email address available for user ${userId} (email_enabled is true but no address found)`
          );
        }
      }
    }

    // Send webhooks
    for (const webhook of userWebhooks) {
      const webhookResult = await deliverWebhook(webhook, payload);

      const statusUpdate: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (webhookResult.success) {
        statusUpdate.last_success_at = new Date().toISOString();
        statusUpdate.failure_count = 0;
      } else {
        statusUpdate.last_failure_at = new Date().toISOString();
        statusUpdate.failure_count = (webhook.failure_count || 0) + 1;
      }

      await supabase.from('webhook_configurations').update(statusUpdate).eq('id', webhook.id);

      await supabase.from('notification_history').insert({
        user_id: userId,
        channel: 'webhook',
        webhook_id: webhook.id,
        payload,
        status: webhookResult.success ? 'sent' : 'failed',
        error_message: webhookResult.error || null,
        apps_notified: appUpdates.length,
        sent_at: webhookResult.success ? new Date().toISOString() : null,
      });

      if (webhookResult.success) {
        delivered = true;
        result.webhooksSent++;
      } else {
        result.errors.push(`Webhook ${webhook.name} failed: ${webhookResult.error}`);
      }
    }

    // Only mark updates notified when at least one channel delivered, so
    // undelivered updates are retried on the next run until a valid channel
    // exists.
    if (delivered) {
      result.notifiedUpdateIds.push(...tenantUpdateList.map((u) => u.id));
    }
  }

  await markNotified(supabase, result.notifiedUpdateIds);
  return result;
}

type NotificationPolicy = Pick<
  AppUpdatePolicy,
  'id' | 'tenant_id' | 'winget_id' | 'policy_type' | 'pinned_version'
>;

const POLICY_PAGE_SIZE = 1000;

/**
 * Load every update policy of the user. Paged so a user with more policies
 * than the Supabase row limit (an MSP across many tenants) still has all of
 * their ignore and pin policies applied. Keyset paged on the primary key and
 * ended only by an empty page, so a server max-rows setting below
 * POLICY_PAGE_SIZE cannot end the read early and drop policies.
 */
async function loadUpdatePolicies(
  supabase: SupabaseClient,
  userId: string
): Promise<{ rows: NotificationPolicy[] } | { error: string }> {
  const rows: NotificationPolicy[] = [];
  let lastId: string | null = null;
  for (;;) {
    let query = supabase
      .from('app_update_policies')
      .select('id, tenant_id, winget_id, policy_type, pinned_version')
      .eq('user_id', userId);
    if (lastId !== null) {
      query = query.gt('id', lastId);
    }
    const { data, error } = await query.order('id', { ascending: true }).limit(POLICY_PAGE_SIZE);
    if (error) {
      return { error: error.message };
    }
    const page = (data as NotificationPolicy[] | null) || [];
    if (page.length === 0) {
      return { rows };
    }
    rows.push(...page);
    lastId = page[page.length - 1].id;
  }
}

async function markNotified(supabase: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const chunkSize = 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await supabase
      .from('update_check_results')
      .update({ notified_at: new Date().toISOString() })
      .in('id', chunk);
  }
}

/**
 * Deliver webhook notifications for one user's pending updates on a
 * self-hosted SQLite deployment, then mark the delivered rows notified so the
 * same update is not announced again on the next run. Email is Supabase-only
 * and is not attempted here.
 *
 * Mirrors notifyUserOfPendingUpdates: ignore/pin policies are honoured and
 * skipped rows stay pending; rows are only marked notified for tenants where
 * at least one webhook delivered, so a failure retries on the next run. A
 * delivery failure is collected, never thrown, so it cannot break the caller.
 */
export async function notifyUserOfPendingUpdatesSqlite(
  db: DatabaseAdapter,
  userId: string
): Promise<NotifyUserResult> {
  const result: NotifyUserResult = {
    emailsSent: 0,
    webhooksSent: 0,
    notifiedUpdateIds: [],
    errors: [],
  };

  try {
    const updates = await db.updateCheckResults.list(userId, { pendingOnly: true });
    if (updates.length === 0) {
      return result;
    }

    // Apply the same per-app update policies as the hosted path: an ignored
    // app, or a pinned app whose detected version is not the pinned one, is
    // skipped and stays pending.
    const policies = await db.updatePolicies.list(userId);
    const policyByApp = new Map<string, NotificationPolicy>();
    policies.forEach((policy) => {
      policyByApp.set(`${policy.tenant_id}:${policy.winget_id}`, policy);
    });
    const notifiable = updates.filter(
      (u) => !shouldSkipUpdate(policyByApp.get(`${u.tenant_id}:${u.winget_id}`), u.latest_version)
    );
    if (notifiable.length === 0) {
      return result;
    }

    const webhooks = (await db.webhookConfigurations.list(userId)).filter(
      (webhook) => webhook.is_enabled
    );
    if (webhooks.length === 0) {
      return result;
    }

    // Group by tenant for the payload, like the hosted path.
    const tenantUpdates = new Map<string, UpdateCheckResult[]>();
    notifiable.forEach((u) => {
      if (!tenantUpdates.has(u.tenant_id)) {
        tenantUpdates.set(u.tenant_id, []);
      }
      tenantUpdates.get(u.tenant_id)!.push(u);
    });

    for (const [tenantId, tenantUpdateList] of tenantUpdates) {
      const appUpdates: AppUpdate[] = tenantUpdateList.map((u) => ({
        app_name: u.display_name,
        winget_id: u.winget_id,
        intune_app_id: u.intune_app_id,
        current_version: u.current_version,
        latest_version: u.latest_version,
        is_critical: u.is_critical,
      }));

      const payload: NotificationPayload = {
        event: 'app_updates_available',
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        updates: appUpdates,
        summary: {
          total: appUpdates.length,
          critical: appUpdates.filter((u) => u.is_critical).length,
        },
      };

      let delivered = false;

      for (const webhook of webhooks) {
        try {
          const webhookResult = await deliverWebhook(webhook, payload);

          await db.webhookConfigurations.markDelivery(
            webhook.id,
            userId,
            webhookResult.success,
            (webhook.failure_count || 0) + 1
          );

          if (webhookResult.success) {
            delivered = true;
            result.webhooksSent++;
          } else {
            result.errors.push(`Webhook ${webhook.name} failed: ${webhookResult.error}`);
          }
        } catch (error) {
          // One webhook's failure must not stop the others or the run.
          result.errors.push(
            `Webhook ${webhook.name} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Only mark updates notified when at least one webhook delivered, so an
      // undelivered update is retried on the next run.
      if (delivered) {
        result.notifiedUpdateIds.push(...tenantUpdateList.map((u) => u.id));
      }
    }

    await db.updateCheckResults.setNotified(
      result.notifiedUpdateIds,
      userId,
      new Date().toISOString()
    );
  } catch (error) {
    // A storage failure is reported, not thrown, so the nightly job finishes.
    result.errors.push(
      `SQLite notification run failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  return result;
}

/**
 * Deliver webhook notifications for every user with an enabled webhook. Used
 * by the nightly SQLite update check, which has no per-user list of its own.
 * One user's failure never stops the rest of the run.
 */
export async function notifyWebhookUsersOfPendingUpdatesSqlite(db: DatabaseAdapter): Promise<{
  usersChecked: number;
  webhooksSent: number;
  updatesNotified: number;
  errors: string[];
}> {
  const summary = {
    usersChecked: 0,
    webhooksSent: 0,
    updatesNotified: 0,
    errors: [] as string[],
  };

  let userIds: string[];
  try {
    userIds = await db.webhookConfigurations.listEnabledUserIds();
  } catch (error) {
    summary.errors.push(
      `Failed to list users with webhooks: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return summary;
  }

  for (const userId of userIds) {
    summary.usersChecked++;
    try {
      const res = await notifyUserOfPendingUpdatesSqlite(db, userId);
      summary.webhooksSent += res.webhooksSent;
      summary.updatesNotified += res.notifiedUpdateIds.length;
      summary.errors.push(...res.errors);
    } catch (error) {
      summary.errors.push(
        `Notification run failed for user ${userId}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  return summary;
}
