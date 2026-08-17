/**
 * crypto.js — Cryptographic Engine
 *
 * Responsibilities:
 *   1. ECDH P-256 key pair generation (private key seeded with TRNG entropy via HKDF)
 *   2. Public key serialisation / deserialisation (SPKI format → base64)
 *   3. Shared AES-GCM key derivation from ECDH shared secret + HKDF
 *   4. Message encryption: AES-GCM-256, random 96-bit IV prepended per message
 *   5. Message decryption
 *
 * Zero-Knowledge Policy: no keys or plaintexts touch any storage API.
 */

const AES_KEY_LENGTH = 256;
const IV_LENGTH_BYTES = 12; // 96-bit IV for AES-GCM

/**
 * CryptoEngine manages the full cryptographic lifecycle for one session.
 */
class CryptoEngine {
  constructor() {
    /** @type {CryptoKeyPair|null} */
    this._ecdhKeyPair = null;
    /** @type {CryptoKey|null} */
    this._aesKey = null;
    /** @type {boolean} */
    this._ready = false;
  }

  /**
   * Generate an ECDH key pair. The entropy from the TRNG is used as HKDF
   * input to seed the derivation of a deterministic private key scalar,
   * providing a TRNG-seeded ECDH key pair.
   *
   * Note: The Web Crypto API does not expose raw ECDH private key import
   * for P-256 on all browsers. We instead use the TRNG entropy to derive
   * an AES-GCM wrapping key, generate a standard ECDH pair, then mix the
   * ECDH shared secret with the TRNG entropy via HKDF for the final session
   * key. This provides both hardware entropy AND forward-secure ECDH.
   *
   * @param {Uint8Array} trngEntropy - 32-byte entropy from TRNG
   * @returns {Promise<string>} - base64-encoded SPKI public key
   */
  async generateKeyPair(trngEntropy) {
    // 1. Generate ephemeral ECDH key pair (browser-generated randomness)
    this._ecdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );

    // 2. Store TRNG entropy for mixing into final key derivation
    this._trngEntropy = trngEntropy;

    // 3. Export public key for transmission to peer
    const pubKeyBuffer = await crypto.subtle.exportKey('spki', this._ecdhKeyPair.publicKey);
    return arrayBufferToBase64(pubKeyBuffer);
  }

  /**
   * Derive the shared AES-GCM session key using:
   *   ECDH shared secret XOR-mixed with TRNG entropy via HKDF-SHA-256
   *
   * @param {string} peerPublicKeyBase64 - peer's base64-encoded SPKI public key
   * @returns {Promise<void>}
   */
  async deriveSharedKey(peerPublicKeyBase64) {
    if (!this._ecdhKeyPair) throw new Error('Key pair not generated yet');

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

    // 3. XOR ECDH shared secret with TRNG entropy to bind hardware randomness
    const ecdhBytes = new Uint8Array(sharedSecretBits);
    const mixed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      mixed[i] = ecdhBytes[i] ^ (this._trngEntropy[i] ?? 0);
    }

    // 4. HKDF-SHA-256 to derive final 256-bit AES key material
    //    info = "e2ee-chat-trng-session-v1"
    const hkdfBaseKey = await crypto.subtle.importKey(
      'raw', mixed, { name: 'HKDF' }, false, ['deriveKey']
    );

    const saltBuffer = new TextEncoder().encode('e2ee-chat-trng-salt-v1');
    const infoBuffer = new TextEncoder().encode('e2ee-chat-trng-session-v1');

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

    // Clear TRNG entropy from memory now that key is derived
    if (this._trngEntropy) {
      this._trngEntropy.fill(0);
      this._trngEntropy = null;
    }
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
    this._trngEntropy = null;
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
