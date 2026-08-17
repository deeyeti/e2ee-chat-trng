/**
 * app.js — Main Orchestrator / State Machine
 *
 * State Machine:
 *   INIT → TRNG → CONNECTING → KEY_EXCHANGE → CHATTING → ENDED
 *
 * Wires TRNG, CryptoEngine, WebRTCManager, and UIController together.
 * Handles the full session lifecycle and ensures zero-knowledge cleanup.
 */

import { TRNG } from './trng.js';
import { CryptoEngine } from './crypto.js';
import { WebRTCManager } from './webrtc.js';
import { UIController } from './ui.js';

/**
 * AppState enum
 * @enum {string}
 */
const AppState = {
  INIT:         'INIT',
  TRNG:         'TRNG',
  CONNECTING:   'CONNECTING',
  KEY_EXCHANGE: 'KEY_EXCHANGE',
  CHATTING:     'CHATTING',
  ENDED:        'ENDED',
};

class App {
  constructor() {
    this._state = AppState.INIT;
    this._trng = new TRNG();
    this._crypto = new CryptoEngine();
    this._webrtc = new WebRTCManager();
    this._ui = new UIController();

    /** @type {Uint8Array|null} */
    this._entropy = null;
    /** @type {string|null} */
    this._myPublicKey = null;
    /** @type {boolean} */
    this._isInitiator = false;
    /** @type {string|null} */
    this._sessionCode = null;
  }

  /**
   * Bootstrap the application.
   * Checks URL params for auto-join and starts the TRNG phase.
   */
  async init() {
    this._bindGlobalEvents();

    // Check if we're joining via URL param ?join=XXXXXX
    const urlParams = new URLSearchParams(window.location.search);
    const joinCode = urlParams.get('join');
    if (joinCode) {
      document.getElementById('join-code-input').value = joinCode.toUpperCase();
    }

    this._transition(AppState.TRNG);
    await this._runTRNG();
  }

  // ── Phase Handlers ──────────────────────────────────────────────────────────

  /**
   * Phase 1: Run the TRNG entropy harvester.
   */
  async _runTRNG() {
    const hasSensors = this._trng.hasSensors();
    this._ui.showTRNGPhase(hasSensors);

    // Wire progress updates to UI
    this._trng.addEventListener('progress', (e) => {
      const { percent, /* bitsCollected */ } = e.detail;
      this._ui.updateEntropyProgress(percent, this._trng.exportRawData().slice(-20));
    });

    this._trng.addEventListener('complete', async (e) => {
      const { entropy, usedSensor } = e.detail;
      this._entropy = entropy;
      this._ui.showEntropyComplete(usedSensor);

      // Small delay to let the user see the 100% state
      await sleep(800);
      this._transition(AppState.CONNECTING);
      await this._runConnectPhase();
    });

    try {
      await this._trng.harvest();
    } catch (err) {
      this._ui.showError(`TRNG Error: ${err.message}`);
      console.error('[App] TRNG failed:', err);
    }
  }

  /**
   * Phase 2: Show the connect screen and handle role selection.
   */
  async _runConnectPhase() {
    // Check if auto-join code is pre-filled
    const joinInput = document.getElementById('join-code-input');
    const preFilledCode = joinInput?.value?.trim();

    if (preFilledCode) {
      // Auto-join
      this._isInitiator = false;
      this._ui.showConnectPhase(null, false);
      await this._connectAsJoiner(preFilledCode);
    } else {
      // Show role picker
      this._ui.showConnectPhase(null, null);
    }
  }

  /**
   * Connect as the session initiator.
   */
  async _connectAsInitiator() {
    this._isInitiator = true;
    this._ui.setStatusSignaling();

    try {
      const sessionCode = await this._webrtc.initAsInitiator();
      this._sessionCode = sessionCode;
      this._ui.showConnectPhase(sessionCode, true);
      this._bindWebRTCEvents();
    } catch (err) {
      this._ui.showError(`Connection error: ${err.message}`);
    }
  }

  /**
   * Connect as a joiner using the provided session code.
   * @param {string} code
   */
  async _connectAsJoiner(code) {
    this._isInitiator = false;
    this._ui.setStatusSignaling();
    this._ui.showConnectPhase(code, false);

    try {
      this._bindWebRTCEvents();
      await this._webrtc.joinSession(code);
    } catch (err) {
      this._ui.showError(`Join error: ${err.message}`);
    }
  }

  /**
   * Phase 3: Key exchange — generate key pair, send public key, wait for peer's.
   */
  async _runKeyExchange() {
    this._transition(AppState.KEY_EXCHANGE);
    this._ui.showKeyExchangePhase();

    try {
      // Generate ECDH key pair seeded with TRNG entropy
      this._myPublicKey = await this._crypto.generateKeyPair(this._entropy);

      // Clear entropy from memory now that key pair is generated
      if (this._entropy) {
        this._entropy.fill(0);
        this._entropy = null;
      }

      // Send our public key to peer
      await sleep(500); // small delay for handshake UI
      this._webrtc.sendPublicKey(this._myPublicKey);
    } catch (err) {
      this._ui.showError(`Key exchange error: ${err.message}`);
    }
  }

  /**
   * Phase 4: Start chat session.
   */
  _startChat() {
    this._transition(AppState.CHATTING);
    this._ui.showChatPhase(this._isInitiator);
    this._ui.setStatusConnected();
  }

  // ── WebRTC Event Wiring ─────────────────────────────────────────────────────

  _bindWebRTCEvents() {
    this._webrtc.addEventListener('connected', async () => {
      await this._runKeyExchange();
    });

    this._webrtc.addEventListener('key-exchange', async (e) => {
      const { publicKey } = e.detail;
      try {
        await this._crypto.deriveSharedKey(publicKey);

        // Allow handshake animation to complete
        await sleep(3600);

        this._startChat();
      } catch (err) {
        this._ui.showError(`Key derivation failed: ${err.message}`);
      }
    });

    this._webrtc.addEventListener('chat-message', async (e) => {
      if (this._state !== AppState.CHATTING) return;
      try {
        const plaintext = await this._crypto.decrypt(e.detail.ciphertext);
        this._ui.appendMessage(plaintext, 'peer');
      } catch (err) {
        this._ui.showError('Failed to decrypt message');
        console.error('[App] Decrypt error:', err);
      }
    });

    this._webrtc.addEventListener('disconnected', () => {
      this._ui.showPeerDisconnected();
      this._transition(AppState.ENDED);
    });

    this._webrtc.addEventListener('error', (e) => {
      this._ui.showError(e.detail.message);
    });
  }

  // ── Global Event Bindings ───────────────────────────────────────────────────

  _bindGlobalEvents() {
    // Role selection buttons
    document.getElementById('btn-create-session')?.addEventListener('click', () => {
      this._connectAsInitiator();
    });

    document.getElementById('btn-join-session')?.addEventListener('click', () => {
      const code = this._ui.getJoinCode();
      if (!code || code.length !== 6) {
        this._ui.showError('Please enter a valid 6-character session code');
        return;
      }
      this._connectAsJoiner(code);
    });

    // Copy session code to clipboard
    document.getElementById('btn-copy-code')?.addEventListener('click', async () => {
      const code = document.getElementById('session-code-display')?.textContent;
      if (code) {
        await navigator.clipboard.writeText(code).catch(() => {});
        const btn = document.getElementById('btn-copy-code');
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy code'; }, 2000);
      }
    });

    // Copy share link to clipboard
    document.getElementById('btn-copy-link')?.addEventListener('click', async () => {
      const link = document.getElementById('share-link')?.textContent;
      if (link) {
        await navigator.clipboard.writeText(link).catch(() => {});
        const btn = document.getElementById('btn-copy-link');
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
      }
    });

    // Send message
    document.getElementById('send-btn')?.addEventListener('click', () => {
      this._sendMessage();
    });

    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });

    // Export raw entropy data (SRS §4.2 auditability)
    document.getElementById('btn-export-entropy')?.addEventListener('click', () => {
      const raw = this._trng.exportRawData();
      const blob = new Blob([JSON.stringify({ rawBits: raw, timestamp: Date.now() }, null, 2)],
        { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `entropy-audit-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Zero-knowledge cleanup on tab close (SRS §3.2, §4.2)
    window.addEventListener('beforeunload', () => {
      this._destroy();
    });

    // Also handle visibility change
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this._state === AppState.ENDED) {
        this._destroy();
      }
    });
  }

  // ── Send Message ────────────────────────────────────────────────────────────

  async _sendMessage() {
    if (this._state !== AppState.CHATTING) return;

    const text = this._ui.getChatInput().trim();
    if (!text) return;

    try {
      const ciphertext = await this._crypto.encrypt(text);
      this._webrtc.sendChatMessage(ciphertext);
      this._ui.appendMessage(text, 'me');
      this._ui.clearChatInput();
    } catch (err) {
      this._ui.showError(`Failed to send: ${err.message}`);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  _transition(newState) {
    console.log(`[App] ${this._state} → ${newState}`);
    this._state = newState;
  }

  /** Destroy all keys and connections (zero-knowledge cleanup). */
  _destroy() {
    this._crypto.destroy();
    this._webrtc.destroy();
    if (this._entropy) {
      this._entropy.fill(0);
      this._entropy = null;
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
