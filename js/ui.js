/**
 * ui.js — UI Controller (v1.1 — Monochrome redesign)
 *
 * Manages DOM interactions across 4 phases:
 *   Phase 1: TRNG — entropy harvesting + oscilloscope
 *   Phase 2: CONNECT — tab-based role picker
 *   Phase 3: KEY_EXCHANGE — handshake step list
 *   Phase 4: CHAT — minimal message interface
 */

class UIController {
  constructor() {
    this._phase = 'TRNG';
    this._oscAnim = null;
    this._oscData = Array(200).fill(0);
    this._msgCount = 0;
    this._handshakeTimer = null;
  }

  // ── Phase Transitions ───────────────────────────────────

  showTRNGPhase(isSensorAvailable, requiresPermissionGesture = false) {
    this._phase = 'TRNG';
    this._setActive('section-trng');

    const notice = document.getElementById('sensor-status-msg');
    const startButton = document.getElementById('btn-start-entropy');
    if (notice) {
      if (isSensorAvailable && requiresPermissionGesture) {
        notice.textContent = 'Motion access needs your approval before collection can begin.';
        notice.className = 'sensor-notice ok';
      } else if (isSensorAvailable) {
        notice.textContent = 'Motion sensors detected — move or shake your device to harvest entropy.';
        notice.className = 'sensor-notice ok';
      } else {
        notice.textContent = 'No motion sensors available — using CSPRNG fallback with SHA-256 whitening.';
        notice.className = 'sensor-notice fallback';
      }
    }

    if (startButton) {
      startButton.hidden = !(isSensorAvailable && requiresPermissionGesture);
      startButton.disabled = false;
      startButton.textContent = 'Enable motion collection';
    }

    this._startOscilloscope();
  }

  showConnectPhase(sessionCode, isInitiator) {
    this._phase = 'CONNECT';
    this._stopOscilloscope();
    this._setActive('section-connect');

    if (isInitiator === true) {
      // Show initiator panel inside the create tab
      const cta = document.getElementById('create-cta');
      const panel = document.getElementById('initiator-panel');
      if (cta)   cta.style.display   = 'none';
      if (panel) panel.style.display = 'block';

      const codeEl = document.getElementById('session-code-display');
      if (codeEl) codeEl.textContent = sessionCode;

      // Populate share link
      const linkEl = document.getElementById('share-link');
      const shareRow = document.getElementById('share-row');
      if (linkEl) {
        const url = `${window.location.origin}${window.location.pathname}?join=${sessionCode}`;
        linkEl.textContent = url;
        if (shareRow) shareRow.style.display = 'flex';
      }
    }
  }

  showKeyExchangePhase() {
    this._phase = 'KEY_EXCHANGE';
    this._setActive('section-handshake');
    this._animateHandshakeSteps();
  }

  showChatPhase(isInitiator, fingerprint) {
    this._phase = 'CHAT';
    this._setActive('section-chat');
    this._updateStatus('connected');

    const sub = document.getElementById('my-peer-label');
    if (sub) sub.textContent = isInitiator ? 'You are the host' : 'You are the guest';

    if (fingerprint) this._showFingerprint(fingerprint);

    document.getElementById('chat-input')?.focus();
  }

  /** Populate and reveal the fingerprint verify row. */
  _showFingerprint(fingerprint) {
    const row = document.getElementById('fingerprint-row');
    const val = document.getElementById('fingerprint-value');
    if (val) val.textContent = fingerprint;
    if (row) row.hidden = false;
  }

  // ── TRNG Visualization ──────────────────────────────────

  updateEntropyProgress(percent, rawBits = [], bitsCollected = null, bitsNeeded = 256) {
    const bar     = document.getElementById('entropy-bar');
    const pct     = document.getElementById('entropy-percent');
    const bits    = document.getElementById('bits-collected');
    const progBar = document.querySelector('[role="progressbar"]');

    if (bar)     bar.style.width = `${percent}%`;
    if (pct)     pct.textContent = `${percent}%`;
    if (bits) {
      const collected = bitsCollected ?? Math.floor((percent / 100) * bitsNeeded);
      bits.textContent = `${Math.min(collected, bitsNeeded)} / ${bitsNeeded} bits`;
    }
    if (progBar) progBar.setAttribute('aria-valuenow', percent);

    // Feed oscilloscope
    if (rawBits.length > 0) {
      const sample = rawBits.slice(-10).reduce((a, b) => a + b, 0) / 10;
      this._oscData.shift();
      this._oscData.push(sample);
    }
  }

  showEntropyComplete(usedSensor) {
    this.updateEntropyProgress(100);
    const status = document.getElementById('trng-status');
    const startButton = document.getElementById('btn-start-entropy');
    if (status) {
      status.textContent = usedSensor ? 'Device samples captured' : 'CSPRNG audit sample ready';
      status.className = 'trng-complete';
    }
    if (startButton) startButton.hidden = true;
  }

  /** Display the current entropy-processing step. */
  setEntropyStatus(message) {
    const status = document.getElementById('trng-status');
    if (!status) return;

    status.textContent = message;
    status.className = '';
  }

  /**
   * Run the supplied callback from the permission button's click event.
   * This preserves the user gesture required by iOS motion permissions.
   * @param {() => void} onStart
   */
  setEntropyStartHandler(onStart) {
    const startButton = document.getElementById('btn-start-entropy');
    if (!startButton || startButton.hidden) return;

    startButton.addEventListener('click', () => {
      startButton.disabled = true;
      startButton.textContent = 'Requesting access…';
      onStart();
    }, { once: true });
  }

  // ── Connection UI ───────────────────────────────────────

  bindConnModeToggle(onModeChange) {
    const btnAuto = document.getElementById('btn-mode-auto');
    const btnManual = document.getElementById('btn-mode-manual');
    if (!btnAuto || !btnManual) return;

    btnAuto.addEventListener('click', () => {
      btnAuto.classList.add('active');
      btnManual.classList.remove('active');
      this._updateConnModeUI('auto');
      if (onModeChange) onModeChange('auto');
    });

    btnManual.addEventListener('click', () => {
      btnManual.classList.add('active');
      btnAuto.classList.remove('active');
      this._updateConnModeUI('manual');
      if (onModeChange) onModeChange('manual');
    });
  }

  getConnMode() {
    const btnManual = document.getElementById('btn-mode-manual');
    return btnManual?.classList.contains('active') ? 'manual' : 'auto';
  }

  _updateConnModeUI(mode) {
    const isAuto = mode === 'auto';
    
    // Create tab
    document.getElementById('create-auto').style.display = isAuto ? 'block' : 'none';
    document.getElementById('create-manual').style.display = isAuto ? 'none' : 'block';

    // Join tab
    document.getElementById('join-auto').style.display = isAuto ? 'block' : 'none';
    document.getElementById('join-manual').style.display = isAuto ? 'none' : 'block';
  }

  bindManualConnection(callbacks) {
    // Initiator
    const btnGenOffer = document.getElementById('btn-generate-manual-offer');
    const btnCopyOffer = document.getElementById('btn-copy-manual-offer');
    const btnConnectInit = document.getElementById('btn-connect-manual-initiator');
    const displayOffer = document.getElementById('manual-offer-display');
    const inputAnswer = document.getElementById('manual-answer-input');

    if (btnGenOffer) {
      btnGenOffer.addEventListener('click', async () => {
        btnGenOffer.disabled = true;
        btnGenOffer.textContent = 'Generating...';
        const offer = await callbacks.onGenerateOffer();
        displayOffer.value = offer;
        btnGenOffer.style.display = 'none';
        btnCopyOffer.style.display = 'block';
        document.getElementById('manual-create-step2').style.display = 'block';
      });
    }

    if (btnCopyOffer) {
      btnCopyOffer.addEventListener('click', async () => {
        await navigator.clipboard.writeText(displayOffer.value);
        btnCopyOffer.textContent = 'Copied!';
        setTimeout(() => btnCopyOffer.textContent = 'Copy Offer', 2000);
      });
    }

    if (btnConnectInit) {
      btnConnectInit.addEventListener('click', () => {
        if (!inputAnswer.value.trim()) return;
        callbacks.onAcceptAnswer(inputAnswer.value.trim());
      });
    }

    // Joiner
    const btnGenAnswer = document.getElementById('btn-generate-manual-answer');
    const btnCopyAnswer = document.getElementById('btn-copy-manual-answer');
    const inputOffer = document.getElementById('manual-offer-input');
    const displayAnswer = document.getElementById('manual-answer-display');

    if (btnGenAnswer) {
      btnGenAnswer.addEventListener('click', async () => {
        if (!inputOffer.value.trim()) return;
        btnGenAnswer.disabled = true;
        btnGenAnswer.textContent = 'Generating...';
        try {
          const answer = await callbacks.onGenerateAnswer(inputOffer.value.trim());
          displayAnswer.value = answer;
          btnGenAnswer.style.display = 'none';
          document.getElementById('manual-join-step2').style.display = 'block';
        } catch (e) {
          this.showError('Invalid offer: ' + e.message);
          btnGenAnswer.disabled = false;
          btnGenAnswer.textContent = 'Generate Answer';
        }
      });
    }

    if (btnCopyAnswer) {
      btnCopyAnswer.addEventListener('click', async () => {
        await navigator.clipboard.writeText(displayAnswer.value);
        btnCopyAnswer.textContent = 'Copied!';
        setTimeout(() => btnCopyAnswer.textContent = 'Copy Answer', 2000);
      });
    }
  }

  // ── Status ──────────────────────────────────────────────

  _updateStatus(state, message) {
    const bar  = document.getElementById('status-bar');
    const text = bar?.querySelector('.status-text');
    if (!bar || !text) return;

    const labels = {
      idle:      'Idle',
      signaling: 'Signaling…',
      connected: 'E2EE active',
      error:     message || 'Error',
    };

    bar.className = `status-bar status-${state}`;
    text.textContent = labels[state] ?? state;
  }

  setStatusSignaling() { this._updateStatus('signaling'); }
  setStatusConnected() { this._updateStatus('connected'); }
  setStatusError(msg)  { this._updateStatus('error', msg); }

  // ── Chat ────────────────────────────────────────────────

  appendMessage(text, sender, timestamp = new Date()) {
    const log = document.getElementById('message-log');
    if (!log) return;

    const wrap = document.createElement('div');
    wrap.className = `message message-${sender}`;
    wrap.id = `msg-${++this._msgCount}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrap.appendChild(bubble);
    wrap.appendChild(time);
    log.appendChild(wrap);
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });

    requestAnimationFrame(() => wrap.classList.add('visible'));
  }

  showPeerDisconnected() {
    const log = document.getElementById('message-log');
    if (log) {
      const sys = document.createElement('div');
      sys.className = 'system-msg';
      sys.textContent = 'Peer disconnected — session ended';
      log.appendChild(sys);
      log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    }

    const input = document.getElementById('chat-input');
    const send  = document.getElementById('send-btn');
    if (input) input.disabled = true;
    if (send)  send.disabled  = true;

    this._updateStatus('error', 'Peer disconnected');
  }

  showError(message) {
    const toast = document.getElementById('error-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
  }

  // ── Oscilloscope ────────────────────────────────────────

  _startOscilloscope() {
    const canvas = document.getElementById('oscilloscope');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let t = 0;

    const draw = () => {
      this._oscAnim = requestAnimationFrame(draw);
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x < width; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 0; y < height; y += 25) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }

      // Waveform
      const data = this._oscData;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;

      for (let i = 0; i < data.length; i++) {
        const x = (i / data.length) * width;
        const noise = Math.sin(t * 0.08 + i * 0.25) * 0.08;
        const y = height / 2 - (data[i] + noise) * (height * 0.38);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Scan line
      const scanX = ((t % 180) / 180) * width;
      const grad = ctx.createLinearGradient(scanX - 30, 0, scanX + 5, 0);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, 'rgba(255,255,255,0.06)');
      ctx.fillStyle = grad;
      ctx.fillRect(scanX - 30, 0, 35, height);

      t++;
    };

    draw();
  }

  _stopOscilloscope() {
    if (this._oscAnim) {
      cancelAnimationFrame(this._oscAnim);
      this._oscAnim = null;
    }
  }

  // ── Handshake Steps ─────────────────────────────────────

  _animateHandshakeSteps() {
    const steps = [
      { id: 'hs-step-1', delay: 0    },
      { id: 'hs-step-2', delay: 700  },
      { id: 'hs-step-3', delay: 1400 },
      { id: 'hs-step-4', delay: 2100 },
      { id: 'hs-step-5', delay: 2800 },
    ];

    steps.forEach(({ id, delay }) => {
      setTimeout(() => {
        const el = document.getElementById(id);
        if (el) {
          el.classList.add('hs-done');
          el.querySelector('.hs-step-icon').textContent = '✓';
        }
      }, delay);
    });
  }

  // ── Helpers ─────────────────────────────────────────────

  _setActive(sectionId) {
    document.querySelectorAll('.app-section').forEach(s => {
      s.classList.toggle('active', s.id === sectionId);
    });
  }

  getJoinCode() {
    return (document.getElementById('join-code-input')?.value ?? '').trim().toUpperCase();
  }

  getChatInput() {
    return document.getElementById('chat-input')?.value ?? '';
  }

  clearChatInput() {
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
  }
}

export { UIController };
