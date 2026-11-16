import { describe, it, expect } from 'vitest';

import {
  detectWebhookType,
  formatPayload,
  formatTestPayload,
  maskWebhookUrl,
  validateWebhookUrl,
  MASKED_WEBHOOK_URL,
} from './service';
import type { NotificationPayload } from '@/types/notifications';

// Google Chat URLs embed the space key and token in the query string, so the
// fixtures never carry realistic credentials.
const googleChatUrl = 'https://chat.googleapis.com/v1/spaces/AAAA/posts/messages?key=fake-key&token=fake-token';

const payload: NotificationPayload = {
  event: 'app_updates_available',
  timestamp: '2026-06-25T12:40:07Z',
  tenant_id: 't1',
  updates: [
    {
      app_name: 'App',
      winget_id: 'Vendor.App',
      intune_app_id: 'a1',
      current_version: '1.0',
      latest_version: '2.0',
      is_critical: false,
    },
  ],
  summary: { total: 1, critical: 0 },
};

describe('detectWebhookType', () => {
  it('recognises Google Chat incoming webhook URLs', () => {
    expect(detectWebhookType(googleChatUrl)).toBe('googlechat');
    expect(detectWebhookType('https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t')).toBe(
      'googlechat'
    );
  });

  it('does not claim other Google URLs', () => {
    expect(detectWebhookType('https://chat.googleapis.com/v1/space/list')).toBeNull();
    expect(detectWebhookType('https://chat.googleapis.com/')).toBeNull();
  });
});

describe('validateWebhookUrl', () => {
  it('accepts Google Chat URLs over HTTPS only', () => {
    expect(validateWebhookUrl(googleChatUrl)).toEqual({ valid: true });
    expect(validateWebhookUrl('http://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t')).toEqual({
      valid: false,
      error: 'URL must use HTTPS',
    });
  });
});

describe('formatPayload and formatTestPayload for Google Chat', () => {
  it('routes googlechat payloads to the cardsV2 formatter without a data side-channel', () => {
    const result = formatPayload('googlechat', payload) as { text: string; cardsV2: unknown[] };
    expect(Object.keys(result).sort()).toEqual(['cardsV2', 'text']);
    expect(result.cardsV2).toHaveLength(1);

    const test = formatTestPayload('googlechat', 'WH') as { text: string; cardsV2: unknown[] };
    expect(test.cardsV2).toHaveLength(1);
    expect(test.text).toContain('WH');
  });
});

describe('maskWebhookUrl', () => {
  it('masks Google Chat URLs and leaves the other types visible', () => {
    expect(maskWebhookUrl({ url: googleChatUrl, webhook_type: 'googlechat' })).toBe(MASKED_WEBHOOK_URL);
    expect(maskWebhookUrl({ url: 'https://hooks.slack.com/services/T/B/X', webhook_type: 'slack' })).toBe(
      'https://hooks.slack.com/services/T/B/X'
    );
  });
});
