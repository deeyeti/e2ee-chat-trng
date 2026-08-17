/**
 * webrtc.js — WebRTC / PeerJS Connection Manager
 *
 * Wraps PeerJS for:
 *   - Generating a session ID (Peer ID) for the initiator
 *   - Joining an existing session by ID
 *   - WebRTC DataChannel management for chat + ECDH key exchange
 *
 * Events emitted on the returned EventTarget:
 *   - 'peer-ready'        → { detail: { peerId: string } }
 *   - 'connecting'        → signaling in progress
 *   - 'connected'         → P2P DataChannel open
 *   - 'disconnected'      → peer disconnected
 *   - 'chat-message'      → { detail: { ciphertext: string } }
 *   - 'key-exchange'      → { detail: { publicKey: string } }
 *   - 'error'             → { detail: { message: string } }
 */

const PEERJS_CDN = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const CHAT_CHANNEL_LABEL = 'e2ee-chat';

/**
 * Dynamically load PeerJS from CDN if not already available.
 */
async function loadPeerJS() {
  if (window.Peer) return;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PEERJS_CDN;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load PeerJS'));
    document.head.appendChild(script);
  });
}

/**
 * WebRTCManager — manages the full P2P connection lifecycle.
 */
class WebRTCManager extends EventTarget {
  constructor() {
    super();
    /** @type {Peer|null} */
    this._peer = null;
    /** @type {DataConnection|null} */
    this._conn = null;
    this._isInitiator = false;
    this._connected = false;
  }

  /**
   * Initialise as the session INITIATOR.
   * Generates a peer ID (session code) and waits for a joiner.
   * @returns {Promise<string>} - the session ID to share
   */
  async initAsInitiator() {
    await loadPeerJS();
    this._isInitiator = true;

    return new Promise((resolve, reject) => {
      // Generate a short, user-friendly 6-char session code
      const sessionId = generateSessionCode();
      this._peer = new window.Peer(sessionId, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ]
        }
      });

      this._peer.on('open', (id) => {
        this.dispatchEvent(new CustomEvent('peer-ready', { detail: { peerId: id } }));
        resolve(id);
      });

      this._peer.on('connection', (conn) => {
        this._conn = conn;
        this.dispatchEvent(new CustomEvent('connecting'));
        this._setupConnection(conn);
      });

      this._peer.on('error', (err) => {
        this._handleError(err);
        reject(err);
      });
    });
  }

  /**
   * Initialise as the session JOINER.
   * Connects to the initiator via the provided session code.
   * @param {string} sessionCode - the code shared by the initiator
   * @returns {Promise<void>}
   */
  async joinSession(sessionCode) {
    await loadPeerJS();
    this._isInitiator = false;

    return new Promise((resolve, reject) => {
      this._peer = new window.Peer({
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ]
        }
      });

      this._peer.on('open', () => {
        this.dispatchEvent(new CustomEvent('connecting'));
        const conn = this._peer.connect(sessionCode.trim().toUpperCase(), {
          reliable: true,
          label: CHAT_CHANNEL_LABEL,
        });
        this._conn = conn;
        this._setupConnection(conn);
        resolve();
      });

      this._peer.on('error', (err) => {
        this._handleError(err);
        reject(err);
      });
    });
  }

  /**
   * Send an encrypted chat message to the peer.
   * @param {string} ciphertext - base64-encoded encrypted payload
   */
  sendChatMessage(ciphertext) {
    if (!this._conn || !this._connected) {
      throw new Error('Not connected to peer');
    }
    this._conn.send(JSON.stringify({ type: 'chat', ciphertext }));
  }

  /**
   * Send our ECDH public key to the peer.
   * @param {string} publicKeyBase64 - base64 SPKI public key
   */
  sendPublicKey(publicKeyBase64) {
    if (!this._conn || !this._connected) {
      throw new Error('Not connected to peer');
    }
    this._conn.send(JSON.stringify({ type: 'key-exchange', publicKey: publicKeyBase64 }));
  }

  /**
   * Close the connection and destroy the peer.
   */
  destroy() {
    this._connected = false;
    if (this._conn) {
      try { this._conn.close(); } catch { /* ignore */ }
      this._conn = null;
    }
    if (this._peer) {
      try { this._peer.destroy(); } catch { /* ignore */ }
      this._peer = null;
    }
  }

  /**
   * Set up event listeners on a DataConnection.
   * @private
   */
  _setupConnection(conn) {
    conn.on('open', () => {
      this._connected = true;
      this.dispatchEvent(new CustomEvent('connected'));
    });

    conn.on('data', (rawData) => {
      try {
        const data = JSON.parse(rawData);
        if (data.type === 'chat') {
          this.dispatchEvent(new CustomEvent('chat-message', {
            detail: { ciphertext: data.ciphertext }
          }));
        } else if (data.type === 'key-exchange') {
          this.dispatchEvent(new CustomEvent('key-exchange', {
            detail: { publicKey: data.publicKey }
          }));
        }
      } catch (e) {
        console.error('[WebRTC] Failed to parse message:', e);
      }
    });

    conn.on('close', () => {
      this._connected = false;
      this.dispatchEvent(new CustomEvent('disconnected'));
    });

    conn.on('error', (err) => {
      this._handleError(err);
    });
  }

  /**
   * @private
   */
  _handleError(err) {
    console.error('[WebRTC] Error:', err);
    this.dispatchEvent(new CustomEvent('error', {
      detail: { message: err.message || String(err) }
    }));
  }

  /** @returns {boolean} */
  isConnected() {
    return this._connected;
  }
}

/**
 * Generate a 6-character alphanumeric session code (uppercase).
 * @returns {string}
 */
function generateSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude ambiguous chars
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => chars[b % chars.length]).join('');
}

export { WebRTCManager, generateSessionCode };
