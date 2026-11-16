/**
 * Installer URLs come from a third-party catalog. The server runs inside a
 * private VNet, so every hop of the download (including redirects) must point
 * at a public HTTPS host: no IP literals or names that resolve to private,
 * loopback, link-local or metadata addresses.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type HostResolver = (hostname: string) => Promise<string[]>;

export const defaultResolveHost: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const MAX_REDIRECTS = 5;

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
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
    return (
      lower === '::' || lower === '::1' ||
      lower.startsWith('fc') || lower.startsWith('fd') || // unique local
      /^fe[89ab]/.test(lower) || // link-local
      lower.startsWith('ff') // multicast
    );
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
