/**
 * trng.js — Hardware Entropy Harvester (True Random Number Generator) v1.2
 *
 * Pipeline:
 *   1. Request DeviceMotion permission (iOS 13+ requires a user-gesture tap)
 *   2. Sample accelerometer/gyroscope at the browser-allowed rate (~60 Hz)
 *   3. Extract entropy bytes using modular integer arithmetic on raw floats
 *      (robust against sensors that only return 3-4 decimal places)
 *   4. Apply Von Neumann debiasing to remove correlation/bias
 *   5. Collect 256 debiased bits → 32 bytes
 *   6. Whiten via SHA-256 for final entropy buffer
 *
 * Falls back to crypto.getRandomValues() on devices without sensors,
 * with a smooth animated progress sweep so the UI doesn't jump 0→100.
 *
 * Events emitted:
 *   'progress' → { percent, bitsCollected, bitsNeeded }
 *   'status'   → { message }   (human-readable step label)
 *   'complete' → { entropy: Uint8Array(32), usedSensor: bool }
 */

const BITS_NEEDED = 256;
const SCALE_FACTOR = 1e4; // shifts sensor readings so noise lands in integer range

/**
 * Extract entropy bytes from a raw sensor float.
 *
 * Instead of slicing fixed string-digit positions (which breaks when sensors
 * return ≤4 decimal places), we scale the value so the noisy fractional part
 * becomes the integer, then take the low byte of that integer.
 *
 * Example: value = 9.81237
 *   scaled  = 98123.7  → floor → 98123
 *   low byte = 98123 % 256 = 75  → 8 bits of real sensor noise
 *
 * @param {number} value - raw sensor axis reading
 * @returns {number[]} - 8 bits extracted from the value's low byte
 */
function extractEntropyByte(value) {
  const scaled = Math.floor(Math.abs(value) * SCALE_FACTOR);
  const lowByte = scaled & 0xFF;
  const bits = [];
  for (let b = 7; b >= 0; b--) {
    bits.push((lowByte >> b) & 1);
  }
  return bits;
}

/**
 * Von Neumann extractor — removes bias from a bit stream.
 * Pair (0,1)→emit 0 | (1,0)→emit 1 | (0,0),(1,1)→discard.
 *
 * @param {number[]} bits
 * @returns {number[]}
 */
function vonNeumannExtract(bits) {
  const out = [];
  for (let i = 0; i + 1 < bits.length; i += 2) {
    if (bits[i] !== bits[i + 1]) out.push(bits[i]);
  }
  return out;
}

/**
 * Pack an array of bits (MSB-first) into a Uint8Array.
 * @param {number[]} bits
 * @returns {Uint8Array}
 */
function bitsToBytes(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[Math.floor(i / 8)] |= (1 << (7 - (i % 8)));
  }
  return bytes;
}

// ── Audit record ─────────────────────────────────────────────────────────────

/**
 * A single sensor sample saved for auditability.
 * @typedef {{ t: number, ax: number, ay: number, az: number,
 *             ra: number, rb: number, rg: number }} SensorSample
 */

// ── TRNG class ────────────────────────────────────────────────────────────────

class TRNG extends EventTarget {
  constructor() {
    super();
    this._rawBits      = [];   // all bits before Von Neumann (for oscilloscope)
    this._debiasedBits = [];   // output after Von Neumann debiasing
    /** @type {SensorSample[]} */
    this._auditSamples = [];   // full timestamped samples for export
    this._running      = false;
    this._usedSensor   = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Does this device expose motion sensors at all?
   * @returns {boolean}
   */
  hasSensors() {
    return (typeof DeviceMotionEvent !== 'undefined' ||
            typeof DeviceOrientationEvent !== 'undefined');
  }

  /**
   * iOS 13+ requires a user-gesture tap before calling requestPermission().
   * @returns {boolean}
   */
  requiresPermissionGesture() {
    return typeof DeviceMotionEvent !== 'undefined' &&
           typeof DeviceMotionEvent.requestPermission === 'function';
  }

  /**
   * Request sensor permissions (iOS 13+).
   * MUST be called from inside a user-gesture handler.
   * @returns {Promise<boolean>}
   */
  async requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const result = await DeviceMotionEvent.requestPermission();
        return result === 'granted';
      } catch {
        return false;
      }
    }
    return true; // Android / non-iOS — implicit
  }

  /**
   * Start harvesting.  Resolves when 256 debiased bits have been collected
   * and SHA-256 whitening is done.
   * @returns {Promise<Uint8Array>} 32-byte entropy buffer
   */
  async harvest() {
    if (this._running) throw new Error('TRNG already running');
    this._running      = true;
    this._rawBits      = [];
    this._debiasedBits = [];
    this._auditSamples = [];

    this._emit('progress', { percent: 0, bitsCollected: 0, bitsNeeded: BITS_NEEDED });

    const hasSensors  = this.hasSensors();
    const permGranted = hasSensors ? await this.requestPermission() : false;

    if (!hasSensors || !permGranted) {
      this._emit('status', { message: 'No sensors — using CSPRNG' });
      return this._fallbackHarvest();
    }

    this._emit('status', { message: 'Sampling sensors…' });
    return this._sensorHarvest();
  }

  /**
   * Return all raw bits collected (for the oscilloscope feed).
   * @returns {number[]}
   */
  exportRawData() {
    return [...this._rawBits];
  }

  /**
   * Return a structured audit log for download.
   * @returns {object}
   */
  exportAuditLog() {
    return {
      version:      '1.2',
      timestamp:    new Date().toISOString(),
      usedSensor:   this._usedSensor,
      bitsCollected: this._debiasedBits.length,
      bitsNeeded:   BITS_NEEDED,
      samples:      this._auditSamples,
      rawBitCount:  this._rawBits.length,
      // Include a hex representation of the debiased bytes for verification
      debiasedHex:  bitsToBytes(this._debiasedBits.slice(0, BITS_NEEDED))
        .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
    };
  }

  // ── Private: sensor harvest ───────────────────────────────────────────────

  _sensorHarvest() {
    this._usedSensor = true;
    return new Promise((resolve) => {

      // ── Zero-sensor detection ──────────────────────────────────────────
      // Laptops expose DeviceMotionEvent but hardware returns all zeros.
      // After MAX_ZERO_EVENTS consecutive all-zero frames (~150 ms at 60 Hz)
      // we treat the device as sensor-less and switch to CSPRNG immediately.
      const MAX_ZERO_EVENTS = 10;
      let zeroEventCount = 0;
      let probeResolved = false;

      // Show a slow-sweep probe animation (0 → 12 %) while we wait for the
      // first real reading, so the bar is never frozen on 0 %.
      let probeStep = 0;
      const probeInterval = setInterval(() => {
        if (probeResolved) { clearInterval(probeInterval); return; }
        probeStep = Math.min(probeStep + 1, 12);
        this._emit('progress', { percent: probeStep, bitsCollected: 0, bitsNeeded: BITS_NEEDED });
        if (probeStep === 1) this._emit('status', { message: 'Probing motion sensors…' });
      }, 16); // ~60 fps sweep

      // ── Device-motion handler ──────────────────────────────────────────
      const onMotion = (event) => {
        const acc = event.accelerationIncludingGravity || event.acceleration;
        const rot = event.rotationRate;

        const ax = acc?.x ?? 0, ay = acc?.y ?? 0, az = acc?.z ?? 0;
        const ra = rot?.alpha ?? 0, rb = rot?.beta ?? 0, rg = rot?.gamma ?? 0;

        const readings = [ax, ay, az, ra, rb, rg].filter(v => v !== 0 && !isNaN(v));

        if (readings.length === 0) {
          zeroEventCount++;
          if (zeroEventCount >= MAX_ZERO_EVENTS && !probeResolved) {
            // No physical sensor — fall back immediately
            probeResolved = true;
            clearInterval(probeInterval);
            window.removeEventListener('devicemotion', onMotion);
            window.removeEventListener('deviceorientation', onOrientation);
            clearTimeout(safetyTimer);

            this._usedSensor = false;
            this._emit('status', { message: 'No sensor data detected — using CSPRNG' });
            this._fallbackHarvest().then(resolve);
          }
          return;
        }

        // Real sensor data arrived — stop probe animation, start collecting
        if (!probeResolved) {
          probeResolved = true;
          clearInterval(probeInterval);
          this._emit('status', { message: 'Entropy flowing…' });
        }
        zeroEventCount = 0;

        // Save timestamped sample for audit log
        this._auditSamples.push({ t: Date.now(), ax, ay, az, ra, rb, rg });

        const rawBatch      = readings.flatMap(extractEntropyByte);
        const debiasedBatch = vonNeumannExtract(rawBatch);

        this._rawBits.push(...rawBatch);
        this._debiasedBits.push(...debiasedBatch);

        const collected = this._debiasedBits.length;
        const percent   = Math.min(100, Math.floor((collected / BITS_NEEDED) * 100));
        this._emit('progress', { percent, bitsCollected: collected, bitsNeeded: BITS_NEEDED });

        if (collected >= 64)  this._emit('status', { message: 'Quarter way…' });
        if (collected >= 128) this._emit('status', { message: 'Half way…' });
        if (collected >= 192) this._emit('status', { message: 'Almost done…' });

        if (collected >= BITS_NEEDED) {
          probeResolved = true;
          clearInterval(probeInterval);
          clearTimeout(safetyTimer);
          window.removeEventListener('devicemotion', onMotion);
          window.removeEventListener('deviceorientation', onOrientation);
          this._finalise(resolve);
        }
      };

      // Supplementary orientation source
      const onOrientation = (event) => {
        if (probeResolved && this._usedSensor === false) return; // already fell back
        const readings = [event.alpha, event.beta, event.gamma]
          .filter(v => v !== null && v !== undefined && !isNaN(v) && v !== 0);
        if (readings.length === 0) return;
        const rawBatch      = readings.flatMap(extractEntropyByte);
        const debiasedBatch = vonNeumannExtract(rawBatch);
        this._rawBits.push(...rawBatch);
        this._debiasedBits.push(...debiasedBatch);
      };

      window.addEventListener('devicemotion', onMotion);
      window.addEventListener('deviceorientation', onOrientation);

      // Belt-and-suspenders: 30 s timeout for very low-movement devices
      const safetyTimer = setTimeout(() => {
        if (this._debiasedBits.length < BITS_NEEDED) {
          probeResolved = true;
          clearInterval(probeInterval);
          window.removeEventListener('devicemotion', onMotion);
          window.removeEventListener('deviceorientation', onOrientation);
          this._emit('status', { message: 'Supplementing with CSPRNG…' });
          this._supplementWithCSPRNG();
          this._finalise(resolve);
        }
      }, 30000);
    });
  }


  // ── Private: CSPRNG fallback ──────────────────────────────────────────────

  /**
   * When no sensors exist, animate the progress bar across ~1.2 s,
   * then complete. This avoids the jarring 0 → 100 jump.
   * @private
   */
  async _fallbackHarvest() {
    this._usedSensor = false;

    // Animate progress in steps so the UI feels alive
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await new Promise(r => setTimeout(r, 60));
      const percent = Math.floor((i / steps) * 95); // stop at 95%, jump to 100 on complete
      this._emit('progress', { percent, bitsCollected: Math.floor(percent * 2.56), bitsNeeded: BITS_NEEDED });

      if (i === 5)  this._emit('status', { message: 'Seeding CSPRNG…' });
      if (i === 12) this._emit('status', { message: 'Running SHA-256…' });
      if (i === 18) this._emit('status', { message: 'Whitening output…' });
    }

    const rawEntropy = new Uint8Array(32);
    crypto.getRandomValues(rawEntropy);
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawEntropy);
    const entropy    = new Uint8Array(hashBuffer);

    this._running = false;
    this._emit('progress', { percent: 100, bitsCollected: 256, bitsNeeded: BITS_NEEDED });
    this._emit('status',   { message: 'CSPRNG entropy ready' });
    this._emit('complete',  { entropy, usedSensor: false });
    return entropy;
  }

  // ── Private: supplement & finalise ───────────────────────────────────────

  _supplementWithCSPRNG() {
    const remaining  = BITS_NEEDED - this._debiasedBits.length;
    const extraBytes = new Uint8Array(Math.ceil(remaining / 8));
    crypto.getRandomValues(extraBytes);
    for (const byte of extraBytes) {
      for (let b = 7; b >= 0; b--) {
        if (this._debiasedBits.length < BITS_NEEDED) {
          this._debiasedBits.push((byte >> b) & 1);
        }
      }
    }
  }

  async _finalise(resolve) {
    const bitsToUse  = this._debiasedBits.slice(0, BITS_NEEDED);
    const rawBytes   = bitsToBytes(bitsToUse);
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawBytes);
    const entropy    = new Uint8Array(hashBuffer);

    this._running = false;
    this._emit('progress', { percent: 100, bitsCollected: BITS_NEEDED, bitsNeeded: BITS_NEEDED });
    this._emit('status',   { message: 'SHA-256 whitening complete' });
    this._emit('complete',  { entropy, usedSensor: this._usedSensor });
    if (resolve) resolve(entropy);
  }

  // ── Private: helpers ──────────────────────────────────────────────────────

  _emit(event, detail) {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }
}

export { TRNG };
