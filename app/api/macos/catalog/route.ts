/**
 * GET /api/macos/catalog?search=&category=&page=&pageSize=
 * The stored IntuneBrew catalog; a stale catalog (>12h) is refreshed in the background.
 * `customApps` lists the tenant's custom apps matching the search (none when a
 * category is selected).
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryCatalog } from '@/lib/macos/catalog';
import { listCustomApps } from '@/lib/macos/custom-apps';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  try {
    const params = new URL(request.url).searchParams;
    const page = Number(params.get('page') || '1');
    const pageSize = Number(params.get('pageSize') || '50');
    const search = params.get('search') || undefined;
    const category = params.get('category') || undefined;
    const result = queryCatalog({
      search,
      category,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 50,
    });
    // Custom apps have no category and are few: all matches, unpaginated.
    const customApps = category ? [] : listCustomApps(gate.ctx.tenantId, search);
    return NextResponse.json({ ...result, customApps });
  } catch (error) {
    console.error('[macos] catalog query failed:', errorMessage(error));
    return NextResponse.json({ error: 'Failed to read the macOS catalog' }, { status: 500 });
  }
}
