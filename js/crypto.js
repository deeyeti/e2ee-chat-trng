/**
 * crypto.js — Cryptographic Engine
 *
 * Responsibilities:
 *   1. ECDH P-256 key pair generation using the browser's CSPRNG
 *   2. Public key serialisation / deserialisation (SPKI format → base64)
 *   3. Shared AES-GCM key derivation from ECDH + a canonical public-key transcript
 *   4. Message encryption: AES-GCM-256, random 96-bit IV prepended per message
 *   5. Message decryption
 *
 * Zero-Knowledge Policy: no keys or plaintexts touch any storage API.
 */

const AES_KEY_LENGTH = 256;
const IV_LENGTH_BYTES = 12; // 96-bit IV for AES-GCM
const SESSION_KDF_INFO = 'securelink-session-v2';
const TRANSCRIPT_LABEL = 'securelink-ecdh-transcript-v2';

/**
 * CryptoEngine manages the full cryptographic lifecycle for one session.
 */
class CryptoEngine {
  constructor() {
    /** @type {CryptoKeyPair|null} */
    this._ecdhKeyPair = null;
    /** @type {CryptoKey|null} */
    this._aesKey = null;
    /** @type {string|null} */
    this._publicKeyBase64 = null;
    /** @type {boolean} */
    this._ready = false;
  }

  /**
   * Generate an ephemeral ECDH key pair. Web Crypto sources the private-key
   * randomness from the browser/operating-system CSPRNG.
   *
   * @returns {Promise<string>} - base64-encoded SPKI public key
   */
  async generateKeyPair() {
    this._ecdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );

    const pubKeyBuffer = await crypto.subtle.exportKey('spki', this._ecdhKeyPair.publicKey);
    this._publicKeyBase64 = arrayBufferToBase64(pubKeyBuffer);
    return this._publicKeyBase64;
  }

  /**
   * Derive the shared AES-GCM session key from the ECDH secret with a
   * deterministic transcript hash as the HKDF salt. Both peers have the same
   * ECDH output and canonical transcript, so they derive the same AES key.
   *
   * @param {string} peerPublicKeyBase64 - peer's base64-encoded SPKI public key
   * @returns {Promise<void>}
   */
  async deriveSharedKey(peerPublicKeyBase64) {
    if (!this._ecdhKeyPair || !this._publicKeyBase64) {
      throw new Error('Key pair not generated yet');
    }

    // 1. Import peer's public key
    const peerPubKeyBuffer = base64ToArrayBuffer(peerPublicKeyBase64);
    const peerPublicKey = await crypto.subtle.importKey(
      'spki',
      peerPubKeyBuffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // 2. Derive raw ECDH shared secret bits (256 bits)
    const sharedSecretBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPublicKey },
      this._ecdhKeyPair.privateKey,
      256
    );

    // 3. Hash a canonical transcript of both public keys. The transcript is
    // public, but binds this derived key to this exact ECDH exchange.
    const transcript = [this._publicKeyBase64, peerPublicKeyBase64]
      .sort()
      .map(key => `${key.length}:${key}`)
      .join('|');
    const transcriptBytes = new TextEncoder().encode(`${TRANSCRIPT_LABEL}|${transcript}`);
    const saltBuffer = await crypto.subtle.digest('SHA-256', transcriptBytes);

    // 4. HKDF-SHA-256 derives the final 256-bit AES key from shared material.
    const hkdfBaseKey = await crypto.subtle.importKey(
      'raw', sharedSecretBits, { name: 'HKDF' }, false, ['deriveKey']
    );

    const infoBuffer = new TextEncoder().encode(SESSION_KDF_INFO);

    this._aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: saltBuffer,
        info: infoBuffer,
      },
      hkdfBaseKey,
      { name: 'AES-GCM', length: AES_KEY_LENGTH },
      false, // non-extractable — key never leaves SubtleCrypto
      ['encrypt', 'decrypt']
    );

    this._ready = true;
  }

  /**
   * Encrypt a plaintext string using AES-GCM-256.
   * Format: [12 bytes IV] + [ciphertext]
   *
   * @param {string} plaintext
   * @returns {Promise<string>} - base64-encoded ciphertext with prepended IV
   */
  async encrypt(plaintext) {
    if (!this._ready) throw new Error('AES key not ready');

    const iv = new Uint8Array(IV_LENGTH_BYTES);
    crypto.getRandomValues(iv);

    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this._aesKey,
      encoded
    );

    // Prepend IV to ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return arrayBufferToBase64(combined.buffer);
  }

  /**
   * Decrypt a base64-encoded AES-GCM ciphertext.
   *
   * @param {string} ciphertextBase64
   * @returns {Promise<string>} - decrypted plaintext
   */
  async decrypt(ciphertextBase64) {
    if (!this._ready) throw new Error('AES key not ready');

    const combined = base64ToArrayBuffer(ciphertextBase64);
    const iv = combined.slice(0, IV_LENGTH_BYTES);
    const ciphertext = combined.slice(IV_LENGTH_BYTES);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      this._aesKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Check if the AES session key is ready for use.
   * @returns {boolean}
   */
  isReady() {
    return this._ready;
  }

  /**
   * Destroy all key material (called on session termination / tab close).
   */
  destroy() {
    this._ecdhKeyPair = null;
    this._aesKey = null;
    this._publicKeyBase64 = null;
    this._ready = false;
  }
}

// ── Utility Functions ─────────────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer to a base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string to an ArrayBuffer.
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export { CryptoEngine, arrayBufferToBase64, base64ToArrayBuffer };
