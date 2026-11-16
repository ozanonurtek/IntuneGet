import { createDecipheriv, createHmac, randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import { BlockChunker, IntuneEncryptor, blockIdFor, encryptedSizeFor, type FileEncryptionInfo } from '../crypto';
import { appTypeForFileName, deployMacosApp, UPLOAD_BLOCK_SIZE, type UploadDeps } from '../intune-upload';
import {
  catalogApp,
  createFakeGraph,
  createFakeNetwork,
  LOGO_URL,
  SAS_BASE,
  sha256Hex,
} from './helpers';

const noSleep = async () => {};

function decryptAssembled(blob: Buffer, info: FileEncryptionInfo): Buffer {
  const mac = blob.subarray(0, 32);
  const iv = blob.subarray(32, 48);
  expect(iv.toString('base64')).toBe(info.initializationVector);
  const expectedMac = createHmac('sha256', Buffer.from(info.macKey, 'base64')).update(blob.subarray(32)).digest();
  expect(mac.equals(expectedMac)).toBe(true);
  expect(mac.toString('base64')).toBe(info.mac);
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(info.encryptionKey, 'base64'), iv);
  return Buffer.concat([decipher.update(blob.subarray(48)), decipher.final()]);
}

function deps(graph: ReturnType<typeof createFakeGraph>, net: ReturnType<typeof createFakeNetwork>, extra: Partial<UploadDeps> = {}): UploadDeps {
  return { graph: graph.client, fetchImpl: net.fetch, sleep: noSleep, ...extra };
}

describe('Intune content encryption (streaming)', () => {
  it.each([0, 15, 16, 17, UPLOAD_BLOCK_SIZE + 5])(
    'round-trips %i bytes through download, encryption and block upload',
    async (size) => {
      const installer = randomBytes(size);
      const app = catalogApp({ sha256: sha256Hex(installer) });
      const net = createFakeNetwork({ installer });
      const graph = createFakeGraph();
      const statuses: string[] = [];

      const result = await deployMacosApp(
        { app, mode: 'new', assignments: [], ignoreVersionDetection: null },
        deps(graph, net, { onStatus: (s) => statuses.push(s) })
      );

      expect(result.intuneAppId).toBe('11111111-1111-1111-1111-111111111111');
      const [[, , , fileInfo]] = graph.callsOf('createContentFile') as [[string, string, string, { size: number; sizeEncrypted: number }]];
      expect(fileInfo.size).toBe(size);
      expect(fileInfo.sizeEncrypted).toBe(encryptedSizeFor(size));
      expect(encryptedSizeFor(size)).toBe(48 + (Math.floor(size / 16) + 1) * 16);

      const ids = net.blockLists.get(SAS_BASE)!;
      expect(ids[0]).toBe(blockIdFor(0));
      expect(ids).toEqual(ids.map((_, i) => blockIdFor(i)));
      // Block 0 is the 48-byte header; every ciphertext block but the last is 8 MiB.
      const stored = net.blocks.get(SAS_BASE)!;
      expect(stored.get(ids[0])!.length).toBe(48);
      for (const id of ids.slice(1, -1)) expect(stored.get(id)!.length).toBe(UPLOAD_BLOCK_SIZE);

      const blob = net.assemble(SAS_BASE);
      expect(blob.length).toBe(encryptedSizeFor(size));
      const [[, info]] = graph.callsOf('commitFile') as [[string, FileEncryptionInfo]];
      expect(info.profileIdentifier).toBe('ProfileVersion1');
      expect(info.fileDigestAlgorithm).toBe('SHA256');
      expect(Buffer.from(info.fileDigest, 'base64').toString('hex')).toBe(app.sha256);
      expect(decryptAssembled(blob, info).equals(installer)).toBe(true);
      expect(statuses).toContain('uploading');
      expect(statuses).toContain('committing');
    },
    30_000
  );

  it('chunker hands out exact blocks across uneven pushes', () => {
    const chunker = new BlockChunker(10);
    const out: Buffer[] = [];
    const pieces = [3, 9, 1, 25, 2, 4].map((n) => Buffer.alloc(n, n));
    for (const piece of pieces) out.push(...chunker.push(piece));
    const last = chunker.flush();
    expect(out.map((b) => b.length)).toEqual([10, 10, 10, 10]);
    expect(last!.length).toBe(4);
    expect(Buffer.concat([...out, last!]).equals(Buffer.concat(pieces))).toBe(true);
    expect(chunker.flush()).toBeNull();
  });

  it('encryptor output matches a one-shot AES-CBC encryption', () => {
    const keys = { key: randomBytes(32), iv: randomBytes(16), macKey: randomBytes(32) };
    const data = randomBytes(1000);
    const enc = new IntuneEncryptor(keys);
    const parts = [enc.update(data.subarray(0, 333)), enc.update(data.subarray(333))];
    const { tail, result } = enc.final();
    const decipher = createDecipheriv('aes-256-cbc', keys.key, keys.iv);
    const ct = Buffer.concat([...parts, tail]);
    expect(Buffer.concat([decipher.update(ct), decipher.final()]).equals(data)).toBe(true);
    expect(result.ciphertextBytes).toBe(encryptedSizeFor(1000) - 48);
  });
});

describe('deployMacosApp', () => {
  it('fails on a hash mismatch, never commits and deletes the half-created app', async () => {
    const installer = randomBytes(100);
    const net = createFakeNetwork({ installer });
    const graph = createFakeGraph();
    await expect(
      deployMacosApp(
        { app: catalogApp({ sha256: 'f'.repeat(64) }), mode: 'new', assignments: [], ignoreVersionDetection: null },
        deps(graph, net)
      )
    ).rejects.toThrow('installer hash does not match the catalog');
    expect(graph.callsOf('commitFile')).toHaveLength(0);
    expect(net.blockLists.size).toBe(0);
    expect(graph.callsOf('deleteApp')).toEqual([['11111111-1111-1111-1111-111111111111']]);
  });

  it('keeps the existing app on a hash mismatch during an update', async () => {
    const installer = randomBytes(100);
    const net = createFakeNetwork({ installer });
    const graph = createFakeGraph();
    await expect(
      deployMacosApp(
        {
          app: catalogApp({ sha256: 'f'.repeat(64) }),
          mode: 'update',
          intuneAppId: '22222222-2222-2222-2222-222222222222',
          assignments: [],
          ignoreVersionDetection: null,
        },
        deps(graph, net)
      )
    ).rejects.toThrow('installer hash does not match the catalog');
    expect(graph.callsOf('deleteApp')).toHaveLength(0);
  });

  it('requires a Content-Length', async () => {
    const installer = randomBytes(100);
    const net = createFakeNetwork({ installer, omitContentLength: true });
    const graph = createFakeGraph();
    await expect(
      deployMacosApp(
        { app: catalogApp({ sha256: sha256Hex(installer) }), mode: 'new', assignments: [], ignoreVersionDetection: null },
        deps(graph, net)
      )
    ).rejects.toThrow(/Content-Length/);
    expect(graph.callsOf('createApp')).toHaveLength(0);
  });

  it('falls back to the GET length when HEAD is refused', async () => {
    const installer = randomBytes(5000);
    const net = createFakeNetwork({ installer, headFails: true });
    const graph = createFakeGraph();
    await deployMacosApp(
      { app: catalogApp({ sha256: sha256Hex(installer) }), mode: 'new', assignments: [], ignoreVersionDetection: null },
      deps(graph, net)
    );
    expect(graph.callsOf('commitFile')).toHaveLength(1);
  });

  it('creates a new app with the IntuneBrew body, logo and assignments', async () => {
    const installer = randomBytes(64);
    const net = createFakeNetwork({ installer, logo: Buffer.from('png-bytes') });
    const graph = createFakeGraph();
    const app = catalogApp({ sha256: sha256Hex(installer), fileName: 'TestApp.dmg' });
    const result = await deployMacosApp(
      {
        app,
        mode: 'new',
        assignments: [
          { groupId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', groupName: 'Macs', intent: 'required' },
          { groupId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', groupName: 'Devs', intent: 'available' },
        ],
        ignoreVersionDetection: true,
        logoUrl: LOGO_URL,
      },
      deps(graph, net)
    );
    expect(result.warnings).toEqual([]);
    const [[created]] = graph.callsOf('createApp') as [[Record<string, unknown>]];
    expect(created).toMatchObject({
      '@odata.type': '#microsoft.graph.macOSDmgApp',
      displayName: 'Test App',
      primaryBundleId: 'com.example.testapp',
      primaryBundleVersion: '2.0.0',
      fileName: 'TestApp.dmg',
      ignoreVersionDetection: true,
      informationUrl: 'https://example.test',
      minimumSupportedOperatingSystem: { v11_0: true },
      includedApps: [{ bundleId: 'com.example.testapp', bundleVersion: '2.0.0' }],
    });
    const patches = graph.callsOf('patchApp') as [string, Record<string, unknown>, string][];
    expect(patches[0][1]).toMatchObject({ committedContentVersion: '1', '@odata.type': '#microsoft.graph.macOSDmgApp' });
    expect(patches[1][1]).toMatchObject({
      largeIcon: { type: 'image/png', value: Buffer.from('png-bytes').toString('base64') },
    });
    expect(graph.callsOf('addAssignment').map((args) => (args[1] as { intent: string }).intent)).toEqual([
      'required',
      'available',
    ]);
  });

  it('updates an existing app in place without touching assignments or its name', async () => {
    const installer = randomBytes(64);
    const net = createFakeNetwork({ installer, logo: Buffer.from('png') });
    const graph = createFakeGraph();
    await deployMacosApp(
      {
        app: catalogApp({ sha256: sha256Hex(installer) }),
        mode: 'update',
        intuneAppId: '22222222-2222-2222-2222-222222222222',
        assignments: [],
        ignoreVersionDetection: null,
        logoUrl: LOGO_URL,
      },
      deps(graph, net)
    );
    expect(graph.callsOf('createApp')).toHaveLength(0);
    expect(graph.callsOf('addAssignment')).toHaveLength(0);
    const patches = graph.callsOf('patchApp') as [string, Record<string, unknown>][];
    expect(patches).toHaveLength(1);
    expect(patches[0][0]).toBe('22222222-2222-2222-2222-222222222222');
    expect(patches[0][1]).toMatchObject({ committedContentVersion: '1', primaryBundleVersion: '2.0.0' });
    expect(patches[0][1]).not.toHaveProperty('displayName');
    expect(patches[0][1]).not.toHaveProperty('ignoreVersionDetection');
  });

  it('renews the SAS after 7 minutes and on a 403 block failure', async () => {
    const installer = randomBytes(UPLOAD_BLOCK_SIZE * 2 + 10);
    const renewed = 'https://blob.example.test/container/file?sv=1&sig=renewed';
    const net = createFakeNetwork({ installer, failFirstBlockPuts: 1 });
    const graph = createFakeGraph({ renewedSas: renewed });
    let clock = 0;
    await deployMacosApp(
      { app: catalogApp({ sha256: sha256Hex(installer) }), mode: 'new', assignments: [], ignoreVersionDetection: null },
      deps(graph, net, {
        now: () => {
          clock += 3 * 60_000;
          return clock;
        },
      })
    );
    expect(graph.callsOf('renewUpload').length).toBeGreaterThanOrEqual(2);
    expect(net.blockLists.has(renewed)).toBe(true);
    const [[, info]] = graph.callsOf('commitFile') as [[string, FileEncryptionInfo]];
    expect(decryptAssembled(net.assemble(renewed), info).equals(installer)).toBe(true);
  });

  it('re-commits after commitFileFailed and then succeeds', async () => {
    const installer = randomBytes(64);
    const net = createFakeNetwork({ installer });
    const graph = createFakeGraph({ commitStates: ['commitFileFailed', 'commitFileSuccess'] });
    await deployMacosApp(
      { app: catalogApp({ sha256: sha256Hex(installer) }), mode: 'new', assignments: [], ignoreVersionDetection: null },
      deps(graph, net)
    );
    expect(graph.callsOf('commitFile')).toHaveLength(2);
  });

  it('maps the file extension to the Intune app type', () => {
    expect(appTypeForFileName('a.PKG')).toBe('macOSPkgApp');
    expect(appTypeForFileName('a.dmg')).toBe('macOSDmgApp');
    expect(() => appTypeForFileName('a.zip')).toThrow();
  });
});
