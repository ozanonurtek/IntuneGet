import { describe, it, expect } from 'vitest';

import {
  buildWebhookData,
  formatSlackMessage,
  formatTeamsMessage,
  formatDiscordMessage,
  formatCustomPayload,
  formatGoogleChatMessage,
  formatSlackTestMessage,
  formatTeamsTestMessage,
  formatDiscordTestMessage,
  formatGoogleChatTestMessage,
} from './formatters';
import type { NotificationPayload, WebhookTestPayload } from '@/types/notifications';

const payload: NotificationPayload = {
  event: 'app_updates_available',
  timestamp: '2026-06-25T12:40:07Z',
  tenant_id: 't1',
  tenant_name: 'Tenant',
  updates: [
    {
      app_name: 'Notepad++',
      winget_id: 'Notepad++.Notepad++',
      intune_app_id: 'a1',
      current_version: '8.9.4',
      latest_version: '8.9.6',
      is_critical: false,
    },
    {
      app_name: 'Chrome',
      winget_id: 'Google.Chrome',
      intune_app_id: 'a2',
      current_version: '1.0',
      latest_version: '2.0',
      is_critical: true,
    },
  ],
  summary: { total: 2, critical: 1 },
};

const expectedData = {
  event: 'app_updates_available',
  timestamp: '2026-06-25T12:40:07Z',
  tenant_id: 't1',
  tenant_name: 'Tenant',
  summary: { total: 2, critical: 1 },
  updates: [
    {
      displayName: 'Notepad++',
      wingetId: 'Notepad++.Notepad++',
      intuneAppId: 'a1',
      fromVersion: '8.9.4',
      toVersion: '8.9.6',
      isCritical: false,
    },
    {
      displayName: 'Chrome',
      wingetId: 'Google.Chrome',
      intuneAppId: 'a2',
      fromVersion: '1.0',
      toVersion: '2.0',
      isCritical: true,
    },
  ],
};

const testPayload: WebhookTestPayload = {
  event: 'test',
  timestamp: '2026-06-25T12:40:07Z',
  message: 'Test message',
  webhook_name: 'WH',
};

describe('buildWebhookData', () => {
  it('maps the notification payload to machine-readable data', () => {
    expect(buildWebhookData(payload)).toEqual(expectedData);
  });
});

describe('notification formatters', () => {
  it('includes structured data in the Slack payload alongside blocks', () => {
    const result = formatSlackMessage(payload);
    expect(result.data).toEqual(expectedData);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('includes structured data in the Teams payload alongside attachments', () => {
    const result = formatTeamsMessage(payload);
    expect(result.data).toEqual(expectedData);
    expect(result.type).toBe('message');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('includes structured data in the Discord payload alongside embeds', () => {
    const result = formatDiscordMessage(payload);
    expect(result.data).toEqual(expectedData);
    expect(result.embeds.length).toBeGreaterThan(0);
  });

  it('keeps original fields in the custom payload and adds structured data', () => {
    const result = formatCustomPayload(payload);
    expect(result).toEqual({ ...payload, data: expectedData });
  });

  it('formats the Google Chat payload as a cardsV2 message with a text fallback', () => {
    const result = formatGoogleChatMessage(payload);

    // Google Chat rejects unknown fields, so the payload carries no data
    // side-channel.
    expect(Object.keys(result).sort()).toEqual(['cardsV2', 'text']);

    expect(result.cardsV2).toHaveLength(1);
    const { cardId, card } = result.cardsV2[0];
    expect(cardId).toBe('intuneget-updates');
    expect(card.header.title).toBe('1 Critical App Update Available');
    expect(card.header.subtitle).toContain('IntuneGet');

    // One section per update with the app name and version transition, plus
    // the trailing dashboard button section.
    expect(card.sections).toHaveLength(3);
    expect(card.sections[0]).toEqual({
      header: 'Notepad++',
      widgets: [
        { decoratedText: { text: '<b>8.9.4 &rarr; 8.9.6</b>', wrapText: true } },
        { textParagraph: { text: 'Notepad++.Notepad++' } },
      ],
    });
    expect(card.sections[1].header).toBe('Chrome (critical)');
    expect(card.sections[1].widgets[0].decoratedText.text).toBe('<b>1.0 &rarr; 2.0</b>');
    expect(card.sections[2].widgets[0].buttonList?.buttons[0].onClick.openLink.url).toContain(
      '/dashboard'
    );

    expect(result.text).toContain('Notepad++: 8.9.4 -> 8.9.6');
    expect(result.text).toContain('Chrome (critical): 1.0 -> 2.0');
  });

  it('escapes markup-significant characters in Google Chat card text', () => {
    const risky = {
      ...payload,
      updates: [
        {
          app_name: 'App <beta>',
          winget_id: 'Vendor.App<&>Tag',
          intune_app_id: 'a3',
          current_version: '1.0',
          latest_version: '2.0',
          is_critical: false,
        },
      ],
      summary: { total: 1, critical: 0 },
    };
    const result = formatGoogleChatMessage(risky);
    expect(result.cardsV2[0].card.sections[0].widgets[0].decoratedText?.text).toBe(
      '<b>1.0 &rarr; 2.0</b>'
    );
    expect(result.cardsV2[0].card.sections[0].widgets[1].textParagraph?.text).toBe(
      'Vendor.App&lt;&amp;&gt;Tag'
    );
    // The plain text fallback stays readable.
    expect(result.text).toContain('App <beta>: 1.0 -> 2.0');
  });
});

describe('test message formatters', () => {
  it('includes structured data in the Slack test payload', () => {
    const result = formatSlackTestMessage(testPayload);
    expect(result.data).toEqual(testPayload);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('includes structured data in the Teams test payload', () => {
    const result = formatTeamsTestMessage(testPayload);
    expect(result.data).toEqual(testPayload);
    expect(result.attachments).toHaveLength(1);
  });

  it('includes structured data in the Discord test payload', () => {
    const result = formatDiscordTestMessage(testPayload);
    expect(result.data).toEqual(testPayload);
    expect(result.embeds).toHaveLength(1);
  });

  it('formats the Google Chat test payload as a cardsV2 test card', () => {
    const result = formatGoogleChatTestMessage(testPayload);
    expect(Object.keys(result).sort()).toEqual(['cardsV2', 'text']);
    expect(result.cardsV2).toHaveLength(1);
    expect(result.cardsV2[0].cardId).toBe('intuneget-webhook-test');
    expect(result.cardsV2[0].card.header.title).toBe('IntuneGet Webhook Test');
    expect(result.cardsV2[0].card.header.subtitle).toBe('WH');
    expect(result.cardsV2[0].card.sections).toHaveLength(2);
    expect(result.cardsV2[0].card.sections[1].widgets[0].textParagraph?.text).toBe(
      '<b>Configuration successful!</b>'
    );
    expect(result.text).toContain('IntuneGet Webhook Test');
    expect(result.text).toContain('WH');
  });
});
