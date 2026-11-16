/**
 * GET /api/macos/catalog?search=&category=&page=&pageSize=
 * The stored IntuneBrew catalog; a stale catalog (>12h) is refreshed in the background.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryCatalog } from '@/lib/macos/catalog';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  try {
    const params = new URL(request.url).searchParams;
    const page = Number(params.get('page') || '1');
    const pageSize = Number(params.get('pageSize') || '50');
    const result = queryCatalog({
      search: params.get('search') || undefined,
      category: params.get('category') || undefined,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 50,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[macos] catalog query failed:', errorMessage(error));
    return NextResponse.json({ error: 'Failed to read the macOS catalog' }, { status: 500 });
  }
}
