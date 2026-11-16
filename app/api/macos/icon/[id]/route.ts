/**
 * GET /api/macos/icon/[id]: proxy the IntuneBrew logo of a catalog app.
 *
 * Not behind parseAccessToken: <img> requests carry no bearer token. The id is
 * checked against the pattern and the stored catalog, so this only ever serves
 * public IntuneBrew logos for known apps.
 */

import { NextRequest, NextResponse } from 'next/server';
import { CATALOG_ID_PATTERN, logoUrl } from '@/lib/macos/catalog';
import { sqliteOnlyResponse } from '@/lib/macos/route-auth';
import { getCatalogApp } from '@/lib/macos/store';
import { isSqliteMode } from '@/lib/db';

export const dynamic = 'force-dynamic';

const MAX_ICON_BYTES = 2 * 1024 * 1024;

function notFound() {
  return new NextResponse(null, { status: 404 });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSqliteMode()) return sqliteOnlyResponse();
  const { id } = await params;
  if (!CATALOG_ID_PATTERN.test(id) || !getCatalogApp(id)) return notFound();
  try {
    const response = await fetch(logoUrl(id), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return notFound();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return notFound();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return notFound();
  }
}
