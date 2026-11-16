import { describe, expect, it, vi } from 'vitest';
import { assertPublicHttpsUrl, guardedFetch, isNonPublicAddress } from '../url-guard';

const publicHost = async () => ['93.184.216.34'];

describe('installer URL guard', () => {
  it('classifies private, loopback, link-local and metadata addresses', () => {
    for (const a of ['10.71.53.4', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '20.60.1.1', '2606:4700::6810:84e5']) expect(isNonPublicAddress(a), a).toBe(false);
  });

  it('rejects http, IP literals, credentials and hosts that resolve privately', async () => {
    await expect(assertPublicHttpsUrl('http://example.com/a.pkg', publicHost)).rejects.toThrow(/https/);
    await expect(assertPublicHttpsUrl('https://10.0.0.5/a.pkg', publicHost)).rejects.toThrow(/IP address/);
    await expect(assertPublicHttpsUrl('https://u:p@example.com/a.pkg', publicHost)).rejects.toThrow(/credentials/);
    await expect(assertPublicHttpsUrl('https://internal.example/a.pkg', async () => ['93.184.216.34', '10.1.1.1'])).rejects.toThrow(/non-public/);
    await expect(assertPublicHttpsUrl('https://example.com/a.pkg', publicHost)).resolves.toBeInstanceOf(URL);
  });

  it('checks every redirect hop and refuses a redirect into the VNet', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('cdn')
      ? new Response(null, { status: 302, headers: { location: 'https://private.example/x.pkg' } })
      : new Response('ok'));
    const resolve = async (host: string) => host === 'private.example' ? ['10.71.53.10'] : ['93.184.216.34'];
    await expect(guardedFetch('https://cdn.example/x.pkg', {}, fetchImpl as unknown as typeof fetch, resolve)).rejects.toThrow(/non-public/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
});
