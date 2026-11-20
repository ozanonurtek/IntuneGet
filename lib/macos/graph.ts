/**
 * Minimal Graph (beta) client for Intune macOS PKG/DMG apps.
 * Request shapes follow IntuneBrew.ps1; see the comments on each call.
 */

import { fetchWithRetry } from '@/lib/intune/graph-client';
import type { FileEncryptionInfo } from './crypto';
import type { MacosAssignment, MacosAssignmentIntent, MacosIntuneAppType } from './types';

export const GRAPH_BETA = 'https://graph.microsoft.com/beta';
const MOBILE_APPS = `${GRAPH_BETA}/deviceAppManagement/mobileApps`;

export type TokenProvider = () => Promise<string | null>;

export class GraphRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail: string | null
  ) {
    super(message);
    this.name = 'GraphRequestError';
  }
}

async function readGraphError(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
      const message = parsed.error?.message || parsed.error?.code;
      if (message) return message.slice(0, 500);
    } catch {
      // not JSON
    }
    return text.slice(0, 500);
  } catch {
    return null;
  }
}

export class MacosGraphClient {
  constructor(
    private readonly getToken: TokenProvider,
    private readonly fetchRetry: typeof fetchWithRetry = fetchWithRetry
  ) {}

  async request<T = unknown>(method: string, url: string, body?: unknown, what = 'Graph request'): Promise<T> {
    const token = await this.getToken();
    if (!token) throw new GraphRequestError(`${what} failed: no Graph token available`, 0, null);
    const response = await this.fetchRetry(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await readGraphError(response);
      throw new GraphRequestError(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`, response.status, detail);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** All macOS PKG/DMG/LOB apps of the tenant, following @odata.nextLink. */
  async listMacApps(): Promise<Record<string, unknown>[]> {
    // IntuneBrew's Get-TenantMacAppNames uses the same isof() filter (PKG/DMG);
    // macOSLobApp is added so older line-of-business uploads are visible too.
    const filter =
      "isof('microsoft.graph.macOSDmgApp') or isof('microsoft.graph.macOSPkgApp') or isof('microsoft.graph.macOSLobApp')";
    let url: string | null = `${MOBILE_APPS}?$filter=${encodeURIComponent(filter)}&$top=100`;
    const apps: Record<string, unknown>[] = [];
    let pages = 0;
    while (url) {
      if (++pages > 100) throw new Error('Too many pages while listing Intune macOS apps');
      const page: { value?: Record<string, unknown>[]; '@odata.nextLink'?: string } = await this.request(
        'GET',
        url,
        undefined,
        'Listing Intune macOS apps'
      );
      apps.push(...(page.value || []));
      const next: string | undefined = page['@odata.nextLink'];
      url = next && next.startsWith(`${GRAPH_BETA}/`) ? next : null;
    }
    return apps;
  }

  getApp(appId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `${MOBILE_APPS}/${encodeURIComponent(appId)}`, undefined, 'Reading the Intune app');
  }

  createApp(body: Record<string, unknown>): Promise<{ id: string }> {
    return this.request('POST', MOBILE_APPS, body, 'Creating the Intune app');
  }

  patchApp(appId: string, body: Record<string, unknown>, what = 'Updating the Intune app'): Promise<void> {
    return this.request('PATCH', `${MOBILE_APPS}/${encodeURIComponent(appId)}`, body, what);
  }

  deleteApp(appId: string): Promise<void> {
    return this.request('DELETE', `${MOBILE_APPS}/${encodeURIComponent(appId)}`, undefined, 'Deleting the Intune app');
  }

  private contentVersionsUrl(appId: string, appType: MacosIntuneAppType): string {
    return `${MOBILE_APPS}/${encodeURIComponent(appId)}/microsoft.graph.${appType}/contentVersions`;
  }

  fileUrl(appId: string, appType: MacosIntuneAppType, contentVersionId: string, fileId: string): string {
    return `${this.contentVersionsUrl(appId, appType)}/${encodeURIComponent(contentVersionId)}/files/${encodeURIComponent(fileId)}`;
  }

  createContentVersion(appId: string, appType: MacosIntuneAppType): Promise<{ id: string }> {
    return this.request('POST', this.contentVersionsUrl(appId, appType), {}, 'Creating a content version');
  }

  createContentFile(
    appId: string,
    appType: MacosIntuneAppType,
    contentVersionId: string,
    file: { name: string; size: number; sizeEncrypted: number }
  ): Promise<{ id: string }> {
    return this.request(
      'POST',
      `${this.contentVersionsUrl(appId, appType)}/${encodeURIComponent(contentVersionId)}/files`,
      {
        '@odata.type': '#microsoft.graph.mobileAppContentFile',
        name: file.name,
        size: file.size,
        sizeEncrypted: file.sizeEncrypted,
        isDependency: false,
      },
      'Creating the content file'
    );
  }

  getFile(fileUrl: string): Promise<{ uploadState?: string; azureStorageUri?: string | null; isCommitted?: boolean }> {
    return this.request('GET', fileUrl, undefined, 'Reading the content file status');
  }

  renewUpload(fileUrl: string): Promise<void> {
    return this.request('POST', `${fileUrl}/renewUpload`, {}, 'Renewing the upload URL');
  }

  commitFile(fileUrl: string, info: FileEncryptionInfo): Promise<void> {
    return this.request('POST', `${fileUrl}/commit`, { fileEncryptionInfo: info }, 'Committing the content file');
  }

  private assignmentsUrl(appId: string): string {
    return `${MOBILE_APPS}/${encodeURIComponent(appId)}/assignments`;
  }

  async listAssignments(appId: string): Promise<Record<string, unknown>[]> {
    const page: { value?: Record<string, unknown>[] } = await this.request(
      'GET',
      this.assignmentsUrl(appId),
      undefined,
      'Reading the app assignments'
    );
    return page.value || [];
  }

  /** Changes only the intent; target, filter and settings stay as they are. */
  updateAssignmentIntent(appId: string, assignmentId: string, intent: MacosAssignmentIntent): Promise<void> {
    return this.request(
      'PATCH',
      `${this.assignmentsUrl(appId)}/${encodeURIComponent(assignmentId)}`,
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent },
      'Changing the assignment intent'
    );
  }

  deleteAssignment(appId: string, assignmentId: string): Promise<void> {
    return this.request(
      'DELETE',
      `${this.assignmentsUrl(appId)}/${encodeURIComponent(assignmentId)}`,
      undefined,
      'Removing the assignment'
    );
  }

  async getGroupName(groupId: string): Promise<string | null> {
    const group: { displayName?: unknown } = await this.request(
      'GET',
      `${GRAPH_BETA}/groups/${encodeURIComponent(groupId)}?$select=id,displayName`,
      undefined,
      'Reading the group'
    );
    return typeof group?.displayName === 'string' ? group.displayName : null;
  }

  /** IntuneBrew Set-IntuneAppAssignment: one POST per group. */
  addAssignment(appId: string, assignment: MacosAssignment): Promise<void> {
    return this.request(
      'POST',
      this.assignmentsUrl(appId),
      {
        '@odata.type': '#microsoft.graph.mobileAppAssignment',
        intent: assignment.intent,
        target: {
          '@odata.type': '#microsoft.graph.groupAssignmentTarget',
          groupId: assignment.groupId,
        },
      },
      `Assigning ${assignment.groupName || assignment.groupId}`
    );
  }
}
