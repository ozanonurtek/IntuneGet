/**
 * Intune content encryption, streaming.
 *
 * Port of IntuneBrew's EncryptFile (IntuneBrew.ps1, ProfileVersion1): AES-256-CBC
 * with a random key and IV, HMAC-SHA256 under a separate random key computed
 * over IV || ciphertext, and an encrypted file laid out as
 *
 *     HMAC (32 bytes) || IV (16 bytes) || ciphertext
 *
 * The file digest is SHA-256 of the plaintext. Because the HMAC is only known
 * once the whole input has been read, the 48-byte header is produced last and
 * uploaded as its own block (block 0); Azure orders blocks by the block list,
 * so the committed blob is still header || ciphertext.
 */

import { createCipheriv, createHash, createHmac, randomBytes, type Cipheriv, type Hash, type Hmac } from 'crypto';

export const HMAC_LENGTH = 32;
export const IV_LENGTH = 16;
export const HEADER_LENGTH = HMAC_LENGTH + IV_LENGTH;
export const AES_BLOCK = 16;

/** Size of the encrypted file for `plaintextSize` bytes of input (PKCS#7 always pads). */
export function encryptedSizeFor(plaintextSize: number): number {
  return HEADER_LENGTH + (Math.floor(plaintextSize / AES_BLOCK) + 1) * AES_BLOCK;
}

export interface FileEncryptionInfo {
  encryptionKey: string;
  fileDigest: string;
  fileDigestAlgorithm: 'SHA256';
  initializationVector: string;
  mac: string;
  macKey: string;
  profileIdentifier: 'ProfileVersion1';
}

export interface EncryptionResult {
  /** HMAC || IV, to be uploaded as block 0. */
  header: Buffer;
  /** Plaintext SHA-256, lowercase hex (compare with the catalog `sha`). */
  plaintextSha256Hex: string;
  plaintextBytes: number;
  ciphertextBytes: number;
  info: FileEncryptionInfo;
}

export interface IntuneEncryptorKeys {
  key: Buffer;
  iv: Buffer;
  macKey: Buffer;
}

export function generateKeys(): IntuneEncryptorKeys {
  return { key: randomBytes(32), iv: randomBytes(IV_LENGTH), macKey: randomBytes(32) };
}

/**
 * Incremental encryptor: feed plaintext chunks to update() and get ciphertext
 * back; final() returns the trailing ciphertext and the header/encryption info.
 */
export class IntuneEncryptor {
  private readonly cipher: Cipheriv;
  private readonly hmac: Hmac;
  private readonly sha: Hash;
  private plaintextBytes = 0;
  private ciphertextBytes = 0;
  private finished = false;

  constructor(private readonly keys: IntuneEncryptorKeys = generateKeys()) {
    this.cipher = createCipheriv('aes-256-cbc', keys.key, keys.iv);
    this.hmac = createHmac('sha256', keys.macKey);
    this.hmac.update(keys.iv);
    this.sha = createHash('sha256');
  }

  update(chunk: Uint8Array): Buffer {
    if (this.finished) throw new Error('Encryptor already finished');
    this.plaintextBytes += chunk.byteLength;
    this.sha.update(chunk);
    const out = this.cipher.update(chunk);
    if (out.length) {
      this.hmac.update(out);
      this.ciphertextBytes += out.length;
    }
    return out;
  }

  final(): { tail: Buffer; result: EncryptionResult } {
    if (this.finished) throw new Error('Encryptor already finished');
    this.finished = true;
    const tail = this.cipher.final();
    this.hmac.update(tail);
    this.ciphertextBytes += tail.length;
    const mac = this.hmac.digest();
    const digest = this.sha.digest();
    return {
      tail,
      result: {
        header: Buffer.concat([mac, this.keys.iv]),
        plaintextSha256Hex: digest.toString('hex'),
        plaintextBytes: this.plaintextBytes,
        ciphertextBytes: this.ciphertextBytes,
        info: {
          encryptionKey: this.keys.key.toString('base64'),
          fileDigest: digest.toString('base64'),
          fileDigestAlgorithm: 'SHA256',
          initializationVector: this.keys.iv.toString('base64'),
          mac: mac.toString('base64'),
          macKey: this.keys.macKey.toString('base64'),
          profileIdentifier: 'ProfileVersion1',
        },
      },
    };
  }
}

/**
 * Accumulates bytes and hands out fixed-size blocks; the last block may be short.
 * Holds at most one block plus one incoming chunk in memory.
 */
export class BlockChunker {
  private parts: Buffer[] = [];
  private length = 0;

  constructor(private readonly blockSize: number) {
    if (!Number.isInteger(blockSize) || blockSize <= 0) throw new Error('blockSize must be a positive integer');
  }

  /** Add bytes; returns the full blocks now available (possibly none). */
  push(data: Buffer): Buffer[] {
    if (data.length === 0) return [];
    this.parts.push(data);
    this.length += data.length;
    const blocks: Buffer[] = [];
    while (this.length >= this.blockSize) {
      const joined = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.length);
      blocks.push(joined.subarray(0, this.blockSize));
      const rest = joined.subarray(this.blockSize);
      this.parts = rest.length ? [rest] : [];
      this.length = rest.length;
    }
    return blocks;
  }

  /** The remaining bytes as a final (short) block, or null when empty. */
  flush(): Buffer | null {
    if (this.length === 0) return null;
    const block = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.length);
    this.parts = [];
    this.length = 0;
    return block;
  }
}

/** Fixed-length block id (base64 of a zero-padded 6-digit index), as IntuneBrew does. */
export function blockIdFor(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 999_999) throw new Error(`Block index out of range: ${index}`);
  return Buffer.from(index.toString().padStart(6, '0'), 'utf8').toString('base64');
}

export function blockListXml(blockIds: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
}
