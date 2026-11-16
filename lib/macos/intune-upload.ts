/**
 * Deploy an IntuneBrew catalog app to Intune as a macOS PKG/DMG app, streaming.
 *
 * The container has little RAM and disk while installers can exceed 1 GiB, so
 * nothing is written to disk: the download is hashed, encrypted and uploaded to
 * Azure Storage in 8 MiB blocks as it arrives. Ported from IntuneBrew.ps1
 * (EncryptFile, UploadFileToAzureStorage, Request-RenewedSasUri, the app
 * creation/update path and Add-IntuneAppLogo).
 */

import { defaultResolveHost, guardedFetch, pinnedHttpsFetch, type HostResolver } from './url-guard';
import {
  BlockChunker,
  IntuneEncryptor,
  blockIdFor,
  blockListXml,
  encryptedSizeFor,
  type EncryptionResult,
  type IntuneEncryptorKeys,
} from './crypto';
import type { MacosGraphClient } from './graph';
import type { MacosAssignment, MacosCatalogApp, MacosIntuneAppType, MacosJobMode, MacosJobStatus } from './types';

export const UPLOAD_BLOCK_SIZE = 8 * 1024 * 1024;
const SAS_RENEW_AFTER_MS = 7 * 60 * 1000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const BLOCK_PUT_TIMEOUT_MS = 5 * 60 * 1000;
const BLOCK_ATTEMPTS = 3;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export class InstallerHashMismatchError extends Error {
  constructor() {
    super('installer hash does not match the catalog');
    this.name = 'InstallerHashMismatchError';
  }
}

export function appTypeForFileName(fileName: string): 'macOSPkgApp' | 'macOSDmgApp' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pkg')) return 'macOSPkgApp';
  if (lower.endsWith('.dmg')) return 'macOSDmgApp';
  throw new Error(`Unsupported installer type: ${fileName}. Only .pkg and .dmg are supported.`);
}

export interface UploadDeps {
  graph: MacosGraphClient;
  /** Used for the installer download, Azure blob PUTs and the logo (tests). */
  fetchImpl?: typeof fetch;
  /** DNS resolver for the installer URL guard (tests inject a public address). */
  resolveHost?: HostResolver;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  blockSize?: number;
  sasPollMs?: number;
  commitPollMs?: number;
  /** Test hook: fixed encryption keys. */
  keys?: IntuneEncryptorKeys;
  onStatus?: (status: MacosJobStatus, progressPercent: number) => void;
  /** Called as soon as a new Intune app exists, so the job can record its id. */
  onAppCreated?: (intuneAppId: string) => void;
}

export interface DeployInput {
  app: MacosCatalogApp;
  mode: MacosJobMode;
  intuneAppId?: string | null;
  assignments: MacosAssignment[];
  ignoreVersionDetection: boolean | null;
  logoUrl?: string | null;
}

export interface DeployResult {
  intuneAppId: string;
  warnings: string[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fields IntuneBrew sends that describe the installer content and its version. */
function contentFields(app: MacosCatalogApp, appType: MacosIntuneAppType, ignoreVersionDetection: boolean | null) {
  const body: Record<string, unknown> = {
    '@odata.type': `#microsoft.graph.${appType}`,
    fileName: app.fileName,
    packageIdentifier: app.bundleId,
    bundleId: app.bundleId,
    versionNumber: app.version,
    primaryBundleId: app.bundleId,
    primaryBundleVersion: app.version,
    includedApps: [
      {
        '@odata.type': '#microsoft.graph.macOSIncludedApp',
        bundleId: app.bundleId,
        bundleVersion: app.version,
      },
    ],
  };
  if (ignoreVersionDetection !== null) body.ignoreVersionDetection = ignoreVersionDetection;
  return body;
}

export function buildCreateAppBody(
  app: MacosCatalogApp,
  appType: 'macOSPkgApp' | 'macOSDmgApp',
  ignoreVersionDetection: boolean | null
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...contentFields(app, appType, ignoreVersionDetection),
    displayName: app.name,
    // Intune requires a description and publisher on LOB apps.
    description: app.description || app.name,
    publisher: app.publisher || app.name,
    minimumSupportedOperatingSystem: {
      '@odata.type': '#microsoft.graph.macOSMinimumOperatingSystem',
      v11_0: true,
    },
  };
  if (app.homepage) body.informationUrl = app.homepage;
  return body;
}

/**
 * PATCH after the commit. For an update only the content/version fields change:
 * display name, description, publisher, minimum OS and assignments the admin
 * may have edited in Intune are left alone.
 */
export function buildFinalizeBody(
  app: MacosCatalogApp,
  appType: 'macOSPkgApp' | 'macOSDmgApp',
  contentVersionId: string,
  ignoreVersionDetection: boolean | null
): Record<string, unknown> {
  return { ...contentFields(app, appType, ignoreVersionDetection), committedContentVersion: contentVersionId };
}

function contentLengthOf(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

const DOWNLOAD_HEADERS = { 'Accept-Encoding': 'identity' };

class SasHolder {
  uri: string;
  obtainedAt: number;
  constructor(uri: string, now: number) {
    this.uri = uri;
    this.obtainedAt = now;
  }
}

export async function deployMacosApp(input: DeployInput, deps: UploadDeps): Promise<DeployResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  // Installer downloads go through sockets pinned to the validated address; tests inject fetchImpl.
  const downloadFetch = deps.fetchImpl ?? pinnedHttpsFetch(resolveHost);
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const blockSize = deps.blockSize ?? UPLOAD_BLOCK_SIZE;
  const sasPollMs = deps.sasPollMs ?? 5000;
  const commitPollMs = deps.commitPollMs ?? 10_000;
  const report = (status: MacosJobStatus, percent: number) => deps.onStatus?.(status, percent);
  const { graph } = deps;
  const { app } = input;
  const appType = appTypeForFileName(app.fileName);
  const warnings: string[] = [];

  report('downloading', 0);

  // 1. Installer size. HEAD first; fall back to the GET's own Content-Length.
  let download: Response | null = null;
  let size: number | null = null;
  try {
    const head = await guardedFetch(app.url, { method: 'HEAD', headers: DOWNLOAD_HEADERS, signal: AbortSignal.timeout(30_000) }, downloadFetch, resolveHost);
    if (head.ok) size = contentLengthOf(head);
  } catch {
    size = null;
  }
  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new Error('Installer download stalled')), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const disarmIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const openDownload = async () => {
    armIdle();
    try {
      const response = await guardedFetch(app.url, { headers: DOWNLOAD_HEADERS, signal: idle.signal }, downloadFetch, resolveHost);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Installer download failed (HTTP ${response.status})`);
      }
      return response;
    } finally {
      // The idle timer only guards waits on the server; it is re-armed around each read.
      disarmIdle();
    }
  };
  if (size === null) {
    download = await openDownload();
    size = contentLengthOf(download);
    if (size === null) {
      await download.body?.cancel().catch(() => {});
      throw new Error('The installer server did not report a Content-Length; streaming upload needs the size up front.');
    }
  }
  const plaintextSize = size;
  let streamStarted = false;
  // A download opened early (no HEAD length) must not stay open if we fail first.
  const releaseDownload = async () => {
    if (download && !streamStarted) await download.body?.cancel().catch(() => {});
  };
  const encryptedSize = encryptedSizeFor(plaintextSize);

  // 2. App (new) or existing app (update).
  let intuneAppId: string;
  let createdHere = false;
  if (input.mode === 'new') {
    let created: { id: string };
    try {
      created = await graph.createApp(buildCreateAppBody(app, appType, input.ignoreVersionDetection));
    } catch (error) {
      await releaseDownload();
      throw error;
    }
    if (!created?.id) {
      await releaseDownload();
      throw new Error('App creation returned no app ID.');
    }
    intuneAppId = created.id;
    createdHere = true;
    deps.onAppCreated?.(intuneAppId);
  } else {
    if (!input.intuneAppId) {
      await releaseDownload();
      throw new Error('An Intune app id is required to update an app.');
    }
    intuneAppId = input.intuneAppId;
  }

  let contentVersionId = '';
  let committed = false;
  try {
    const contentVersion = await graph.createContentVersion(intuneAppId, appType);
    if (!contentVersion?.id) throw new Error('Content version creation returned no ID.');
    contentVersionId = contentVersion.id;
    const file = await graph.createContentFile(intuneAppId, appType, contentVersionId, {
      name: app.fileName,
      size: plaintextSize,
      sizeEncrypted: encryptedSize,
    });
    if (!file?.id) throw new Error('Content file creation returned no ID.');
    const fileUrl = graph.fileUrl(intuneAppId, appType, contentVersionId, file.id);

    // 3. Wait for the SAS URI.
    let sasUri: string | null = null;
    for (let attempt = 0; attempt < 60 && !sasUri; attempt++) {
      await sleep(sasPollMs);
      const status = await graph.getFile(fileUrl);
      if (status.uploadState === 'azureStorageUriRequestFailed') throw new Error('Intune could not issue an upload URL.');
      if (status.uploadState === 'azureStorageUriRequestSuccess' && status.azureStorageUri) sasUri = status.azureStorageUri;
    }
    if (!sasUri) throw new Error('Timed out waiting for the Intune upload URL.');
    const sas = new SasHolder(sasUri, now());

    const renewSas = async () => {
      try {
        await graph.renewUpload(fileUrl);
      } catch {
        // IntuneBrew carries on and polls anyway.
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(sasPollMs);
        const status = await graph.getFile(fileUrl);
        if (status.uploadState === 'azureStorageUriRenewalFailed') break;
        if (status.azureStorageUri && status.uploadState !== 'azureStorageUriRenewalPending') {
          sas.uri = status.azureStorageUri;
          break;
        }
      }
      sas.obtainedAt = now();
    };

    const putBlob = async (query: string, body: Buffer | string, contentType: string, what: string) => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= BLOCK_ATTEMPTS; attempt++) {
        if (now() - sas.obtainedAt >= SAS_RENEW_AFTER_MS) await renewSas();
        try {
          const response = await fetchImpl(`${sas.uri}&${query}`, {
            method: 'PUT',
            headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType },
            body: typeof body === 'string' ? body : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
            signal: AbortSignal.timeout(BLOCK_PUT_TIMEOUT_MS),
          });
          if (response.ok) {
            await response.arrayBuffer().catch(() => undefined);
            return;
          }
          await response.arrayBuffer().catch(() => undefined);
          lastError = new Error(`${what} failed (HTTP ${response.status})`);
          if (response.status === 403) {
            // Usually an expired SAS on a long upload: renew and retry the same block.
            await renewSas();
            continue;
          }
        } catch (error) {
          lastError = error;
        }
        if (attempt < BLOCK_ATTEMPTS) await sleep(2000);
      }
      throw lastError instanceof Error ? lastError : new Error(`${what} failed`);
    };

    // 4. Stream: download -> SHA-256 + AES-CBC + HMAC -> 8 MiB blocks (ids 1..N).
    report('uploading', 0);
    if (!download) download = await openDownload();
    const getLength = contentLengthOf(download);
    if (getLength !== null && getLength !== plaintextSize) {
      await download.body?.cancel().catch(() => {});
      throw new Error('The installer size changed between the size check and the download.');
    }
    const encryptor = new IntuneEncryptor(deps.keys);
    const chunker = new BlockChunker(blockSize);
    const blockIds: string[] = [blockIdFor(0)];
    let uploadedBytes = 0;
    let lastReported = -1;
    const uploadBlock = async (block: Buffer) => {
      const id = blockIdFor(blockIds.length);
      await putBlob(`comp=block&blockid=${encodeURIComponent(id)}`, block, 'application/octet-stream', `Uploading block ${blockIds.length}`);
      blockIds.push(id);
      uploadedBytes += block.length;
      const percent = Math.floor((uploadedBytes / encryptedSize) * 100);
      if (percent !== lastReported) {
        lastReported = percent;
        report('uploading', percent);
      }
    };

    let result: EncryptionResult;
    streamStarted = true;
    const reader = download.body!.getReader();
    try {
      for (;;) {
        armIdle();
        const { done, value } = await reader.read();
        disarmIdle();
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        for (const block of chunker.push(encryptor.update(chunk))) await uploadBlock(block);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error instanceof Error && error.name === 'AbortError' ? new Error('Installer download stalled or was aborted') : error;
    } finally {
      disarmIdle();
      reader.releaseLock();
    }
    const finished = encryptor.final();
    result = finished.result;
    for (const block of chunker.push(finished.tail)) await uploadBlock(block);
    const last = chunker.flush();
    if (last) await uploadBlock(last);

    if (result.plaintextBytes !== plaintextSize) {
      throw new Error(`The installer download was ${result.plaintextBytes} bytes, expected ${plaintextSize}.`);
    }
    // 5. Integrity: never commit content that is not the catalog's installer.
    if (result.plaintextSha256Hex !== app.sha256.toLowerCase()) throw new InstallerHashMismatchError();

    // Header (HMAC || IV) last, as block 0, then the block list 0..N.
    await putBlob(`comp=block&blockid=${encodeURIComponent(blockIds[0])}`, result.header, 'application/octet-stream', 'Uploading the header block');
    await putBlob('comp=blocklist', blockListXml(blockIds), 'application/xml', 'Committing the block list');
    report('uploading', 100);

    // 6. Commit and wait for commitFileSuccess.
    report('committing', 0);
    await graph.commitFile(fileUrl, result.info);
    let recommits = 0;
    for (let attempt = 0; attempt < 60 && !committed; attempt++) {
      await sleep(commitPollMs);
      const status = await graph.getFile(fileUrl);
      if (status.uploadState === 'commitFileSuccess') committed = true;
      else if (status.uploadState === 'commitFileFailed') {
        if (++recommits > 3) throw new Error('Intune failed to commit the content file.');
        await graph.commitFile(fileUrl, result.info);
      }
    }
    if (!committed) throw new Error('Timed out waiting for Intune to commit the content file.');
  } catch (error) {
    disarmIdle();
    await releaseDownload();
    if (createdHere && !committed) {
      try {
        await graph.deleteApp(intuneAppId);
      } catch {
        warnings.push(`Could not remove the incomplete Intune app ${intuneAppId}; delete it in the Intune portal.`);
      }
    }
    if (warnings.length && error instanceof Error) error.message = `${error.message} ${warnings.join(' ')}`;
    throw error;
  }

  await graph.patchApp(
    intuneAppId,
    buildFinalizeBody(app, appType, contentVersionId, input.ignoreVersionDetection),
    'Setting the committed content version'
  );
  report('committing', 100);

  if (input.mode === 'new') {
    report('assigning', 0);
    if (input.logoUrl) {
      try {
        await setLogo(graph, downloadFetch, resolveHost, intuneAppId, appType, input.logoUrl);
      } catch {
        // Non-fatal, like IntuneBrew's Add-IntuneAppLogo.
      }
    }
    const failed: string[] = [];
    for (const [index, assignment] of input.assignments.entries()) {
      try {
        await graph.addAssignment(intuneAppId, assignment);
      } catch (error) {
        failed.push(`${assignment.groupName || assignment.groupId} (${error instanceof Error ? error.message : 'error'})`);
      }
      report('assigning', Math.round(((index + 1) / input.assignments.length) * 100));
    }
    if (failed.length) warnings.push(`App deployed, but ${failed.length} assignment(s) failed: ${failed.join('; ')}`);
  }

  return { intuneAppId, warnings };
}

async function setLogo(
  graph: MacosGraphClient,
  fetchImpl: typeof fetch,
  resolveHost: HostResolver,
  appId: string,
  appType: MacosIntuneAppType,
  url: string
): Promise<void> {
  // Custom apps carry an admin-supplied icon URL, so the logo goes through the
  // same public-host guard as the installer.
  const response = await guardedFetch(url, { signal: AbortSignal.timeout(20_000) }, fetchImpl, resolveHost);
  if (!response.ok) return;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return;
  await graph.patchApp(
    appId,
    {
      '@odata.type': `#microsoft.graph.${appType}`,
      largeIcon: { '@odata.type': '#microsoft.graph.mimeContent', type: 'image/png', value: bytes.toString('base64') },
    },
    'Setting the app icon'
  );
}
