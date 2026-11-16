/**
 * Installer URLs come from a third-party catalog. The server runs inside a
 * private VNet, so every hop of the download (including redirects) must point
 * at a public HTTPS host: no IP literals or names that resolve to private,
 * loopback, link-local or metadata addresses.
 */

import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

export type HostResolver = (hostname: string) => Promise<string[]>;

export const defaultResolveHost: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const MAX_REDIRECTS = 5;

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

function expandIpv6(address: string): string[] {
  const [head, tail = ''] = address.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = address.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t];
}

export function isNonPublicAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = lower.startsWith('::ffff:') ? lower.slice(7) : null;
  if (mapped && isIP(mapped) === 4) return isNonPublicAddress(mapped);

  const v4 = ipv4Parts(lower);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, IMDS
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(lower) === 6) {
    // Allow global unicast only (2000::/3), minus ranges that embed or tunnel to
    // other addresses: 6to4 (2002::/16), Teredo (2001::/32), documentation
    // (2001:db8::/32). Mapped/compatible/NAT64 forms fall outside 2000::/3.
    const first = parseInt(expandIpv6(lower)[0], 16);
    const second = parseInt(expandIpv6(lower)[1], 16);
    if (first < 0x2000 || first > 0x3fff) return true;
    if (first === 0x2002) return true;
    if (first === 0x2001 && (second === 0x0000 || second === 0x0db8)) return true;
    return false;
  }
  return true;
}

export async function assertPublicHttpsUrl(rawUrl: string, resolveHost: HostResolver): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Installer URL must use https');
  if (url.username || url.password) throw new Error('Installer URL must not carry credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) throw new Error('Installer URL must use a host name, not an IP address');
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new Error(`Installer host ${host} does not resolve`);
  }
  if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
    throw new Error(`Installer host ${host} resolves to a non-public address`);
  }
  return url;
}

/** fetch() that validates the URL and every redirect target before connecting. */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  resolveHost: HostResolver
): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpsUrl(current, resolveHost);
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => {});
      current = new URL(response.headers.get('location') as string, current).toString();
      continue;
    }
    return response;
  }
  throw new Error('Installer download redirected too many times');
}

/**
 * DNS lookup for outbound sockets that rejects non-public answers. Used as the
 * socket's own lookup, so the address that was checked is the one connected to
 * (no gap for DNS rebinding between the check and the connection).
 */
export function publicOnlyLookup(resolveHost: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolveHost(hostname).then((addresses) => {
      if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
        callback(Object.assign(new Error(`Installer host ${hostname} resolves to a non-public address`), { code: 'ENOTPUBLIC' }), '', 0);
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
          null, addresses.map((address) => ({ address, family: isIP(address) })));
      } else {
        callback(null, addresses[0], isIP(addresses[0]));
      }
    }, (error: Error) => callback(Object.assign(error, { code: 'ENOTFOUND' }), '', 0));
  };
}

/**
 * Minimal fetch over node:https whose sockets resolve through publicOnlyLookup.
 * Never follows redirects (guardedFetch does, hop by hop).
 */
export function pinnedHttpsFetch(resolveHost: HostResolver): typeof fetch {
  const lookup = publicOnlyLookup(resolveHost);
  return ((input: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== 'https:') { reject(new Error('Installer URL must use https')); return; }
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const req = httpsRequest(url, { method, headers, lookup, signal: init.signal ?? undefined }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
        else if (value !== undefined) responseHeaders.set(key, String(value));
      }
      const status = res.statusCode ?? 502;
      const nullBody = method === 'HEAD' || status === 204 || status === 304;
      if (nullBody) res.resume();
      resolve(new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: responseHeaders }));
    });
    req.on('error', reject);
    req.end();
  })) as typeof fetch;
}
