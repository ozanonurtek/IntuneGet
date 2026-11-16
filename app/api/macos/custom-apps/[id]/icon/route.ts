/**
 * GET /api/macos/custom-apps/[id]/icon: proxy a custom app's icon URL.
 *
 * Not behind parseAccessToken: <img> requests carry no bearer token. The id
 * must match the custom id pattern and exist with an icon URL, and the fetch
 * goes through the public-host guard (every redirect hop, pinned sockets), so
 * this cannot be turned into a request to an internal address. Only PNGs are
 * served.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isSqliteMode } from '@/lib/db';
import { CUSTOM_APP_ID_PATTERN, getCustomAppIconUrl } from '@/lib/macos/custom-apps';
import { sqliteOnlyResponse } from '@/lib/macos/route-auth';
import { defaultResolveHost, guardedFetch, pinnedHttpsFetch } from '@/lib/macos/url-guard';

export const dynamic = 'force-dynamic';

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function notFound() {
  return new NextResponse(null, { status: 404 });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSqliteMode()) return sqliteOnlyResponse();
  const { id } = await params;
  if (!CUSTOM_APP_ID_PATTERN.test(id)) return notFound();
  const iconUrl = getCustomAppIconUrl(id);
  if (!iconUrl) return notFound();
  try {
    const response = await guardedFetch(
      iconUrl,
      { signal: AbortSignal.timeout(15_000) },
      pinnedHttpsFetch(defaultResolveHost),
      defaultResolveHost
    );
    if (!response.ok) return notFound();
    const declared = Number(response.headers.get('content-length') || '0');
    if (declared > MAX_ICON_BYTES) {
      await response.body?.cancel().catch(() => {});
      return notFound();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return notFound();
    if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return notFound();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        // Private and short: the URL is editable (the UI adds ?v=<updatedAt>).
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return notFound();
  }
}
