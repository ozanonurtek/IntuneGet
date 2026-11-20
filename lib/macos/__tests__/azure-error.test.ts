import { describe, expect, it } from 'vitest';
import { azureErrorDetail } from '../intune-upload';

describe('azureErrorDetail', () => {
  it('reads the Azure Storage error code and the first line of the message', async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><Error><Code>InvalidBlockList</Code><Message>The specified block list is invalid.\nRequestId:abc\nTime:2026-11-20T11:03:53Z</Message></Error>';
    const response = new Response(body, { status: 400, headers: { 'x-ms-error-code': 'InvalidBlockList' } });
    expect(await azureErrorDetail(response)).toBe('InvalidBlockList: The specified block list is invalid.');
  });

  it('names the offending header and never echoes a SAS signature', async () => {
    const body =
      '<Error><Code>InvalidHeaderValue</Code><Message>The value for one of the HTTP headers is not in the correct format.</Message><HeaderName>x-ms-blob-type</HeaderName><HeaderValue>BlockBlob</HeaderValue></Error>';
    expect(await azureErrorDetail(new Response(body, { status: 400 }))).toBe(
      'InvalidHeaderValue: The value for one of the HTTP headers is not in the correct format.: HeaderName=x-ms-blob-type'
    );
    const auth = '<Error><Code>AuthenticationFailed</Code><Message>x</Message><AuthenticationErrorDetail>sig=abcdef bad</AuthenticationErrorDetail></Error>';
    expect(await azureErrorDetail(new Response(auth, { status: 403 }))).not.toContain('abcdef');
  });

  it('returns an empty string for an empty body', async () => {
    expect(await azureErrorDetail(new Response(null, { status: 400 }))).toBe('');
  });
});
