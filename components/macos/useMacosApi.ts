'use client';

import { useCallback } from 'react';
import { useMicrosoftAuth } from '@/hooks/useMicrosoftAuth';
import { useMspOptional } from '@/hooks/useMspOptional';

/** fetch() for /api routes with the signed-in user's bearer token. */
export function useMacosApi() {
  const { getAccessToken } = useMicrosoftAuth();
  const { isMspUser, selectedTenantId } = useMspOptional();

  return useCallback(
    async (url: string, init: RequestInit = {}): Promise<Response> => {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Your session has expired. Sign in again.');
      return fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(isMspUser && selectedTenantId ? { 'X-MSP-Tenant-Id': selectedTenantId } : {}),
        },
      });
    },
    [getAccessToken, isMspUser, selectedTenantId]
  );
}
