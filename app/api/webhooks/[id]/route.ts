/**
 * Individual Webhook API Routes
 * GET - Get a specific webhook configuration
 * PUT - Update a webhook configuration
 * DELETE - Delete a webhook configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseServerConfigured } from '@/lib/supabase';
import { getDatabase, isSqliteMode } from '@/lib/db';
import { parseAccessToken } from '@/lib/auth-utils';
import { WEBHOOK_STORAGE_UNAVAILABLE_MESSAGE } from '@/types/notifications';
import { MASKED_WEBHOOK_URL, maskWebhookUrl, validateWebhookUrl } from '@/lib/webhooks/service';
import type {
  WebhookConfiguration,
  WebhookConfigurationUpdate,
} from '@/types/notifications';
import type { Database } from '@/types/database';

type WebhookConfigurationDatabaseUpdate =
  Database['public']['Tables']['webhook_configurations']['Update'];

const WEBHOOK_TYPES: WebhookConfigurationUpdate['webhook_type'][] = [
  'slack',
  'teams',
  'discord',
  'googlechat',
  'custom',
];

/**
 * Mask secrets and Google Chat URLs before a webhook is echoed back. A Google
 * Chat webhook URL carries the space key and token in its query string.
 */
function sanitizeWebhook(webhook: WebhookConfiguration) {
  return {
    ...webhook,
    secret: webhook.secret ? '********' : null,
    url: maskWebhookUrl(webhook),
  };
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/webhooks/[id]
 * Get a specific webhook configuration
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    if (isSqliteMode()) {
      const webhook = await getDatabase().webhookConfigurations.get(id, user.userId);
      if (!webhook) {
        return NextResponse.json(
          { error: 'Webhook not found' },
          { status: 404 }
        );
      }
      return NextResponse.json({ webhook: sanitizeWebhook(webhook) });
    }

    if (!isSupabaseServerConfigured()) {
      return NextResponse.json({ error: WEBHOOK_STORAGE_UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    const supabase = createServerClient();

    // Get webhook configuration
    const { data: webhook, error } = await supabase
      .from('webhook_configurations')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Webhook not found' },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: 'Failed to fetch webhook' },
        { status: 500 }
      );
    }

    // Mask secret in response
    const sanitizedWebhook = sanitizeWebhook(webhook);

    return NextResponse.json({ webhook: sanitizedWebhook });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/webhooks/[id]
 * Update a webhook configuration
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;
    const body: WebhookConfigurationUpdate = await request.json();

    // The API masks Google Chat URLs in responses, so a submitted URL equal to
    // the mask means "unchanged", exactly like an untouched secret.
    if (body.url === MASKED_WEBHOOK_URL) {
      body.url = undefined;
    }

    // Validate URL if provided
    if (body.url) {
      const urlValidation = validateWebhookUrl(body.url);
      if (!urlValidation.valid) {
        return NextResponse.json(
          { error: urlValidation.error || 'Invalid webhook URL' },
          { status: 400 }
        );
      }
    }

    // Validate webhook type if provided
    if (body.webhook_type && !WEBHOOK_TYPES.includes(body.webhook_type)) {
      return NextResponse.json(
        { error: 'Invalid webhook type' },
        { status: 400 }
      );
    }

    if (isSqliteMode()) {
      const update: WebhookConfigurationUpdate = {};
      if (body.name !== undefined) update.name = body.name.trim();
      if (body.url !== undefined) update.url = body.url;
      if (body.webhook_type !== undefined) update.webhook_type = body.webhook_type;
      if (body.headers !== undefined) update.headers = body.headers;
      if (body.is_enabled !== undefined) update.is_enabled = body.is_enabled;
      if ('secret' in body) update.secret = body.secret;

      const webhook = await getDatabase().webhookConfigurations.update(id, user.userId, update);
      if (!webhook) {
        return NextResponse.json(
          { error: 'Webhook not found' },
          { status: 404 }
        );
      }
      return NextResponse.json({ webhook: sanitizeWebhook(webhook) });
    }

    if (!isSupabaseServerConfigured()) {
      return NextResponse.json({ error: WEBHOOK_STORAGE_UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    const supabase = createServerClient();

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('webhook_configurations')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.userId)
      .single();

    if (fetchError || !existing) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      );
    }

    // Build update data
    const updateData: WebhookConfigurationDatabaseUpdate = {
      updated_at: new Date().toISOString(),
    };

    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.url !== undefined) updateData.url = body.url;
    if (body.webhook_type !== undefined) updateData.webhook_type = body.webhook_type;
    if (body.headers !== undefined) updateData.headers = body.headers;
    if (body.is_enabled !== undefined) updateData.is_enabled = body.is_enabled;

    // Handle secret update (only update if explicitly provided, including null)
    if ('secret' in body) {
      updateData.secret = body.secret;
    }

    // Update webhook
    const { data: webhook, error } = await supabase
      .from('webhook_configurations')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: 'Failed to update webhook' },
        { status: 500 }
      );
    }

    // Mask secret in response
    const sanitizedWebhook = sanitizeWebhook(webhook);

    return NextResponse.json({ webhook: sanitizedWebhook });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/webhooks/[id]
 * Delete a webhook configuration
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    if (isSqliteMode()) {
      const deleted = await getDatabase().webhookConfigurations.delete(id, user.userId);
      if (!deleted) {
        return NextResponse.json(
          { error: 'Webhook not found' },
          { status: 404 }
        );
      }
      return NextResponse.json({ success: true });
    }

    if (!isSupabaseServerConfigured()) {
      return NextResponse.json({ error: WEBHOOK_STORAGE_UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    const supabase = createServerClient();

    // Delete webhook (will automatically fail if not owned by user due to WHERE clause)
    const { error } = await supabase
      .from('webhook_configurations')
      .delete()
      .eq('id', id)
      .eq('user_id', user.userId);

    if (error) {
      return NextResponse.json(
        { error: 'Failed to delete webhook' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
