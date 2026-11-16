/**
 * Shared request handling for /api/macos/custom-apps routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { CustomAppBusyError, DuplicateBundleIdError } from './custom-apps';
import { errorMessage } from './route-auth';
import { macosCustomAppSchema, type MacosCustomAppInput } from './validators';

export type CustomAppBodyResult = { ok: true; input: MacosCustomAppInput } | { ok: false; response: NextResponse };

export async function parseCustomAppBody(request: NextRequest): Promise<CustomAppBodyResult> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 }) };
  }
  const parsed = macosCustomAppSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: parsed.error.issues.map((issue) => issue.message).join('; ') || 'Invalid request',
          fields: Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0] ?? ''), issue.message])),
        },
        { status: 400 }
      ),
    };
  }
  return { ok: true, input: parsed.data };
}

/** Map store errors to responses; anything unexpected is a logged 500. */
export function customAppErrorResponse(error: unknown, action: string): NextResponse {
  if (error instanceof DuplicateBundleIdError) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error instanceof CustomAppBusyError) {
    return NextResponse.json({ error: error.message, job: error.job }, { status: 409 });
  }
  console.error(`[macos] could not ${action} custom app:`, errorMessage(error));
  return NextResponse.json({ error: `Failed to ${action} the custom app` }, { status: 500 });
}
