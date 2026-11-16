/**
 * Test doubles for the macOS module: an in-memory Azure blob endpoint, an
 * installer server and a fake Graph client. Imported by *.test.ts only.
 */

import { createHash } from 'crypto';
import type { MacosGraphClient } from '../graph';
import type { MacosCatalogApp } from '../types';

export const INSTALLER_URL = 'https://downloads.example.test/app.pkg';
export const LOGO_URL = 'https://raw.example.test/Logos/app.png';
export const SAS_BASE = 'https://blob.example.test/container/file?sv=1&sig=abc';

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function catalogApp(overrides: Partial<MacosCatalogApp> = {}): MacosCatalogApp {
  return {
    id: 'test_app',
    name: 'Test App',
    version: '2.0.0',
    bundleId: 'com.example.testapp',
    publisher: 'Example',
    category: 'Productivity',
    description: 'A test app',
    homepage: 'https://example.test',
    url: INSTALLER_URL,
    fileName: 'TestApp-2.0.0.pkg',
    sha256: '0'.repeat(64),
    fetchedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

export interface FakeNetworkOptions {
  installer: Buffer;
  /** Size of the chunks the installer body is streamed in. */
  chunkSize?: number;
  omitContentLength?: boolean;
  headFails?: boolean;
  /** Return 403 for the first N block PUTs. */
  failFirstBlockPuts?: number;
  logo?: Buffer | null;
}

export interface FakeNetwork {
  fetch: typeof fetch;
  blocks: Map<string, Map<string, Buffer>>;
  blockLists: Map<string, string[]>;
  sasUrisUsed: Set<string>;
  blockPuts: number;
  /** The committed blob for a SAS base (block list order). */
  assemble(sasBase?: string): Buffer;
}

function sasKey(url: URL): string {
  const copy = new URL(url.toString());
  copy.searchParams.delete('comp');
  copy.searchParams.delete('blockid');
  return copy.toString();
}

export function createFakeNetwork(options: FakeNetworkOptions): FakeNetwork {
  const blocks = new Map<string, Map<string, Buffer>>();
  const blockLists = new Map<string, string[]>();
  const sasUrisUsed = new Set<string>();
  let failuresLeft = options.failFirstBlockPuts ?? 0;
  const net: FakeNetwork = {
    blocks,
    blockLists,
    sasUrisUsed,
    blockPuts: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.toString() === INSTALLER_URL) {
        if (method === 'HEAD') {
          if (options.headFails) return new Response(null, { status: 405 });
          const headers: Record<string, string> = {};
          if (!options.omitContentLength) headers['content-length'] = String(options.installer.length);
          return new Response(null, { status: 200, headers });
        }
        const chunkSize = options.chunkSize ?? 1024 * 1024 + 3;
        const data = options.installer;
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= data.length) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(data.subarray(offset, offset + chunkSize)));
            offset += chunkSize;
          },
        });
        const headers: Record<string, string> = {};
        if (!options.omitContentLength) headers['content-length'] = String(data.length);
        return new Response(stream, { status: 200, headers });
      }
      if (url.toString() === LOGO_URL) {
        if (!options.logo) return new Response(null, { status: 404 });
        return new Response(new Uint8Array(options.logo), { status: 200 });
      }
      if (url.host === 'blob.example.test' && method === 'PUT') {
        const key = sasKey(url);
        sasUrisUsed.add(key);
        const comp = url.searchParams.get('comp');
        const body = Buffer.from(
          init?.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init?.body ?? ''))
        );
        if (comp === 'block') {
          net.blockPuts++;
          if (failuresLeft > 0) {
            failuresLeft--;
            return new Response('AuthenticationFailed', { status: 403 });
          }
          const id = url.searchParams.get('blockid')!;
          if (!blocks.has(key)) blocks.set(key, new Map());
          blocks.get(key)!.set(id, Buffer.from(body));
          return new Response(null, { status: 201 });
        }
        if (comp === 'blocklist') {
          const ids = [...body.toString('utf8').matchAll(/<Latest>([^<]+)<\/Latest>/g)].map((m) => m[1]);
          blockLists.set(key, ids);
          return new Response(null, { status: 201 });
        }
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
    assemble(sasBase?: string) {
      const key = sasBase ?? [...blockLists.keys()][0];
      const ids = blockLists.get(key);
      if (!ids) throw new Error('no block list committed');
      // Blocks may have been uploaded under an older SAS for the same blob.
      const all = new Map<string, Buffer>();
      for (const map of blocks.values()) for (const [id, data] of map) all.set(id, data);
      return Buffer.concat(ids.map((id) => {
        const data = all.get(id);
        if (!data) throw new Error(`missing block ${id}`);
        return data;
      }));
    },
  };
  return net;
}

export interface GraphCall {
  method: string;
  args: unknown[];
}

export interface FakeGraph {
  client: MacosGraphClient;
  calls: GraphCall[];
  callsOf(method: string): unknown[][];
}

export function createFakeGraph(options: { commitStates?: string[]; renewedSas?: string } = {}): FakeGraph {
  const calls: GraphCall[] = [];
  const commitStates = [...(options.commitStates ?? ['commitFilePending', 'commitFileSuccess'])];
  let committed = false;
  let renewals = 0;
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const client = {
    createApp: async (body: unknown) => {
      record('createApp', body);
      return { id: '11111111-1111-1111-1111-111111111111' };
    },
    createContentVersion: async (...args: unknown[]) => {
      record('createContentVersion', ...args);
      return { id: '1' };
    },
    createContentFile: async (...args: unknown[]) => {
      record('createContentFile', ...args);
      return { id: 'file-1' };
    },
    fileUrl: (appId: string, appType: string, cv: string, fileId: string) =>
      `https://graph.example.test/${appId}/${appType}/${cv}/${fileId}`,
    getFile: async (url: string) => {
      record('getFile', url);
      if (committed) {
        const state = commitStates.length > 1 ? commitStates.shift()! : commitStates[0];
        return { uploadState: state };
      }
      if (renewals > 0 && options.renewedSas) {
        return { uploadState: 'azureStorageUriRenewalSuccess', azureStorageUri: options.renewedSas };
      }
      return { uploadState: 'azureStorageUriRequestSuccess', azureStorageUri: SAS_BASE };
    },
    renewUpload: async (url: string) => {
      record('renewUpload', url);
      renewals++;
    },
    commitFile: async (...args: unknown[]) => {
      record('commitFile', ...args);
      committed = true;
    },
    patchApp: async (...args: unknown[]) => {
      record('patchApp', ...args);
    },
    deleteApp: async (...args: unknown[]) => {
      record('deleteApp', ...args);
    },
    addAssignment: async (...args: unknown[]) => {
      record('addAssignment', ...args);
    },
  };
  return {
    client: client as unknown as MacosGraphClient,
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method).map((c) => c.args),
  };
}
