/**
 * POST /api/macos/catalog/refresh: refresh the IntuneBrew catalog now
 * (joins a refresh that is already running).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCatalogMetaWithState, startCatalogRefresh } from '@/lib/macos/catalog';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  try {
    const result = await startCatalogRefresh();
    return NextResponse.json({ result, meta: getCatalogMetaWithState() });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error), meta: getCatalogMetaWithState() },
      { status: 502 }
    );
  }
}
