/**
 * ui.js — UI Controller & Visualizations
 *
 * Manages all DOM interactions and visual feedback across 4 phases:
 *   Phase 1: TRNG — entropy harvesting progress + oscilloscope canvas
 *   Phase 2: CONNECT — session ID display, copy button, join field
 *   Phase 3: KEY_EXCHANGE — handshake animation
 *   Phase 4: CHAT — full chat interface with message bubbles
 *
 * The UI is purely reactive — it listens to events and updates state.
 * No direct calls to crypto or webrtc from here.
 */

class UIController {
  constructor() {
    this._phase = 'TRNG';
    this._oscilloscopeAnim = null;
    this._oscilloscopeData = Array(200).fill(0);
    this._messageCount = 0;
  }

  // ── Phase Transitions ───────────────────────────────────────────────────────

  /** Show Phase 1: TRNG harvesting */
  showTRNGPhase(isSensorAvailable) {
    this._phase = 'TRNG';
    this._setActiveSection('section-trng');

    const sensorMsg = document.getElementById('sensor-status-msg');
    if (sensorMsg) {
      sensorMsg.textContent = isSensorAvailable
        ? '📡 Motion sensors detected — shake or move your device'
        : '⚠️ No motion sensors — using CSPRNG fallback';
      sensorMsg.className = isSensorAvailable ? 'sensor-ok' : 'sensor-fallback';
    }

    this._startOscilloscope();
  }

  /** Show Phase 2: Connect (waiting for peer) */
  showConnectPhase(sessionCode, isInitiator) {
    this._phase = 'CONNECT';
    this._stopOscilloscope();
    this._setActiveSection('section-connect');

    const initiatorPanel = document.getElementById('initiator-panel');
    const joinerPanel = document.getElementById('joiner-panel');

    if (isInitiator) {
      initiatorPanel.style.display = 'block';
      joinerPanel.style.display = 'none';
      document.getElementById('session-code-display').textContent = sessionCode;
      document.getElementById('share-link').textContent =
        `${window.location.href}?join=${sessionCode}`;
    } else {
      initiatorPanel.style.display = 'none';
      joinerPanel.style.display = 'block';
    }
  }

  /** Show Phase 3: Key exchange handshake */
  showKeyExchangePhase() {
    this._phase = 'KEY_EXCHANGE';
    this._setActiveSection('section-handshake');
    this._animateHandshake();
  }

  /** Show Phase 4: Chat */
  showChatPhase(isInitiator) {
    this._phase = 'CHAT';
    this._setActiveSection('section-chat');
    this._updateStatus('connected');

    const myLabel = document.getElementById('my-peer-label');
    if (myLabel) {
      myLabel.textContent = isInitiator ? 'You (Host)' : 'You (Guest)';
    }

    document.getElementById('chat-input').focus();
  }

  // ── TRNG Visualization ──────────────────────────────────────────────────────

  /**
   * Update entropy progress bar and oscilloscope data.
   * @param {number} percent - 0 to 100
   * @param {number[]} [rawBits] - latest raw sensor bits for visualization
   */
  updateEntropyProgress(percent, rawBits = []) {
    const bar = document.getElementById('entropy-bar');
    const label = document.getElementById('entropy-percent');
    const bitsLabel = document.getElementById('bits-collected');

    if (bar) bar.style.width = `${percent}%`;
    if (label) label.textContent = `${percent}%`;
    if (bitsLabel) {
      const bits = Math.floor(percent * 2.56);
      bitsLabel.textContent = `${bits} / 256 bits`;
    }

    // Feed oscilloscope
    if (rawBits.length > 0) {
      const sample = rawBits.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
      this._oscilloscopeData.shift();
      this._oscilloscopeData.push(sample);
    }
  }

  /**
   * Show TRNG completion state.
   * @param {boolean} usedSensor
   */
  showEntropyComplete(usedSensor) {
    const statusEl = document.getElementById('trng-status');
    if (statusEl) {
      statusEl.textContent = usedSensor
        ? '✅ 256-bit hardware entropy captured'
        : '✅ 256-bit entropy ready (CSPRNG)';
      statusEl.className = 'trng-complete';
    }
    this.updateEntropyProgress(100);
  }

  // ── Connection Status ───────────────────────────────────────────────────────

  /**
   * @param {'idle'|'signaling'|'connected'|'error'} state
   * @param {string} [message]
   */
  _updateStatus(state, message) {
    const statusBar = document.getElementById('status-bar');
    if (!statusBar) return;

    const icons = {
      idle:      { icon: '○', text: message || 'Not connected',       cls: 'status-idle' },
      signaling: { icon: '◎', text: message || 'Signaling…',          cls: 'status-signaling' },
      connected: { icon: '🔒', text: message || 'E2EE Active',         cls: 'status-connected' },
      error:     { icon: '✕', text: message || 'Connection error',     cls: 'status-error' },
    };

    const s = icons[state] || icons.idle;
    statusBar.className = `status-bar ${s.cls}`;
    statusBar.querySelector('.status-icon').textContent = s.icon;
    statusBar.querySelector('.status-text').textContent = s.text;
  }

  setStatusSignaling() { this._updateStatus('signaling'); }
  setStatusConnected() { this._updateStatus('connected', '🔒 P2P + E2EE Active'); }
  setStatusError(msg)  { this._updateStatus('error', msg); }

  // ── Chat Interface ──────────────────────────────────────────────────────────

  /**
   * Append a message bubble to the chat log.
   * @param {string} text - decrypted plaintext
   * @param {'me'|'peer'} sender
   * @param {Date} [timestamp]
   */
  appendMessage(text, sender, timestamp = new Date()) {
    const log = document.getElementById('message-log');
    if (!log) return;

    const msgEl = document.createElement('div');
    msgEl.className = `message message-${sender}`;
    msgEl.id = `msg-${++this._messageCount}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgEl.appendChild(bubble);
    msgEl.appendChild(time);
    log.appendChild(msgEl);

    // Smooth scroll to bottom
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });

    // Animate in
    requestAnimationFrame(() => msgEl.classList.add('visible'));
  }

  /**
   * Show "peer is disconnected" system message.
   */
  showPeerDisconnected() {
    const log = document.getElementById('message-log');
    if (!log) return;

    const sysEl = document.createElement('div');
    sysEl.className = 'system-message';
    sysEl.textContent = '⚠️ Peer disconnected — session ended';
    log.appendChild(sysEl);
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });

    document.getElementById('chat-input').disabled = true;
    document.getElementById('send-btn').disabled = true;
    this._updateStatus('error', 'Peer disconnected');
  }

  /** Show an error toast */
  showError(message) {
    const toast = document.getElementById('error-toast');
    if (!toast) return;
    toast.textContent = `⚠️ ${message}`;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
  }

  // ── Oscilloscope Animation ──────────────────────────────────────────────────

  _startOscilloscope() {
    const canvas = document.getElementById('oscilloscope');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let t = 0;

    const draw = () => {
      this._oscilloscopeAnim = requestAnimationFrame(draw);
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      // Background grid
      ctx.strokeStyle = 'rgba(0, 245, 212, 0.06)';
      ctx.lineWidth = 1;
      for (let x = 0; x < width; x += 30) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 0; y < height; y += 20) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }

      // Waveform from collected data
      const data = this._oscilloscopeData;
      ctx.beginPath();
      ctx.strokeStyle = '#00f5d4';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00f5d4';
      ctx.shadowBlur = 8;

      for (let i = 0; i < data.length; i++) {
        const x = (i / data.length) * width;
        // Add noise-like motion to idle state
        const noise = Math.sin(t * 0.1 + i * 0.3) * 0.1;
        const y = height / 2 - (data[i] + noise) * (height * 0.4);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Scan line effect
      const scanX = ((t % 120) / 120) * width;
      const grad = ctx.createLinearGradient(scanX - 40, 0, scanX + 10, 0);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, 'rgba(0,245,212,0.15)');
      ctx.fillStyle = grad;
      ctx.fillRect(scanX - 40, 0, 50, height);

      t++;
    };

    draw();
  }

  _stopOscilloscope() {
    if (this._oscilloscopeAnim) {
      cancelAnimationFrame(this._oscilloscopeAnim);
      this._oscilloscopeAnim = null;
    }
  }

  // ── Handshake Animation ─────────────────────────────────────────────────────

  _animateHandshake() {
    const steps = [
      { id: 'hs-step-1', text: 'Generating ECDH key pair…',    delay: 0 },
      { id: 'hs-step-2', text: 'Exchanging public keys…',       delay: 800 },
      { id: 'hs-step-3', text: 'Deriving shared secret…',       delay: 1600 },
      { id: 'hs-step-4', text: 'Mixing TRNG entropy via HKDF…', delay: 2400 },
      { id: 'hs-step-5', text: 'AES-GCM-256 key ready',         delay: 3200 },
    ];

    steps.forEach(({ id, text, delay }) => {
      setTimeout(() => {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = `✓ ${text}`;
          el.classList.add('hs-done');
        }
      }, delay);
    });
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  _setActiveSection(sectionId) {
    document.querySelectorAll('.app-section').forEach(s => {
      s.classList.toggle('active', s.id === sectionId);
    });
  }

  /**
   * Get the value from the session code input (joiner flow).
   * @returns {string}
   */
  getJoinCode() {
    return (document.getElementById('join-code-input')?.value ?? '').trim().toUpperCase();
  }

  /**
   * Get the current chat message input value.
   * @returns {string}
   */
  getChatInput() {
    return document.getElementById('chat-input')?.value ?? '';
  }

  /** Clear the chat input field */
  clearChatInput() {
    const input = document.getElementById('chat-input');
    if (input) input.value = '';
  }
}

export { UIController };
