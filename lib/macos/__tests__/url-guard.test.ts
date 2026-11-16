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

describe('IPv6 and pinned lookup', () => {
  it('allows only global unicast IPv6 outside tunnelling ranges', () => {
    for (const a of ['::ffff:a00:1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:0:4136:e378::1', '2001:db8::1', '::a00:1']) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    expect(isNonPublicAddress('2606:4700::6810:84e5')).toBe(false);
  });

  it('fails the socket lookup when the name answers with a private address', async () => {
    const { publicOnlyLookup } = await import('../url-guard');
    const lookup = publicOnlyLookup(async () => ['10.71.53.4']);
    const err = await new Promise<Error | null>((resolve) => lookup('x.example', {}, (e) => resolve(e)));
    expect(err?.message).toMatch(/non-public/);
    const ok = publicOnlyLookup(async () => ['93.184.216.34']);
    const address = await new Promise<string>((resolve) => ok('x.example', {}, (_e, a) => resolve(a as string)));
    expect(address).toBe('93.184.216.34');
  });
});

describe('readBodyCapped', () => {
  it('stops reading once the body passes the cap, without trusting Content-Length', async () => {
    const { readBodyCapped } = await import('../url-guard');
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
    expect(await readBodyCapped(new Response(stream), 4096)).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect((await readBodyCapped(new Response(new Uint8Array(10)), 4096))?.byteLength).toBe(10);
  });
});
