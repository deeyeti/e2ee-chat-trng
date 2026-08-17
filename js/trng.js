/**
 * trng.js — Hardware Entropy Harvester (True Random Number Generator)
 *
 * Pipeline:
 *   1. Request DeviceMotion/Orientation permission (iOS 13+)
 *   2. Sample accelerometer/gyroscope at the browser-allowed rate (~60 Hz)
 *   3. Extract Least Significant Bits (LSBs) from each axis reading
 *   4. Apply Von Neumann debiasing to remove correlation/bias
 *   5. Collect 256 debiased bits → 32 bytes
 *   6. Whiten via SHA-256 (cryptographic hash) for final key material
 *
 * Falls back to crypto.getRandomValues() on devices without sensors.
 *
 * Events emitted on the returned EventTarget:
 *   - 'progress'  → { detail: { percent: 0-100, bitsCollected, bitsNeeded } }
 *   - 'status'    → { detail: { message } }
 *   - 'complete'  → { detail: { entropy: Uint8Array(32), usedSensor: bool } }
 *   - 'error'     → { detail: { message: string } }
 */

const BITS_NEEDED = 256;       // 256-bit AES key
const SENSOR_SCALE = 1000;     // retain milligravity / millidegree sensor detail
const BITS_PER_READING = 12;
const SENSOR_TIMEOUT_MS = 30000;
const MAX_AUDIT_SAMPLES = 2048;

/**
 * Extract low-order binary bits from a fixed-point sensor reading. Fixed-point
 * extraction works with phones that quantise their readings to a few decimal
 * places, where the former decimal-digit approach produced only zeroes.
 *
 * @param {number} value - raw sensor reading
 * @returns {number[]} - array of extracted bits (0 or 1)
 */
function extractLSBs(value) {
  const fixedPoint = Math.round(Math.abs(value) * SENSOR_SCALE) >>> 0;
  const bits = [];

  for (let bit = 0; bit < BITS_PER_READING; bit++) {
    bits.push((fixedPoint >>> bit) & 1);
  }
  return bits;
}

/**
 * Von Neumann extractor — removes bias from a bit stream.
 * Processes pairs of bits: (0,1)→0, (1,0)→1, (0,0) and (1,1)→discard.
 *
 * @param {number[]} bits - raw bit array
 * @returns {number[]} - debiased bit array (shorter)
 */
function vonNeumannExtract(bits) {
  const output = [];
  for (let i = 0; i + 1 < bits.length; i += 2) {
    if (bits[i] !== bits[i + 1]) {
      output.push(bits[i]);
    }
  }
  return output;
}

/**
 * Pack a bit array into a Uint8Array (MSB first).
 *
 * @param {number[]} bits
 * @returns {Uint8Array}
 */
function bitsToBytes(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      bytes[Math.floor(i / 8)] |= (1 << (7 - (i % 8)));
    }
  }
  return bytes;
}

/**
 * TRNG class — manages the full entropy harvesting lifecycle.
 */
class TRNG extends EventTarget {
  constructor() {
    super();
    this._rawBits = [];
    this._debiasedBits = [];
    this._sampleInterval = null;
    this._lastReading = null;
    this._running = false;
    this._usedSensor = false;
    this._auditSamples = [];
    this._auditSamplesDropped = 0;
    this._lastHarvestMode = null;
  }

  /**
   * Request sensor permissions (required on iOS 13+).
   * @returns {Promise<boolean>} - true if sensor access granted
   */
  async requestPermission() {
    const sensorEventTypes = [
      globalThis.DeviceMotionEvent,
      globalThis.DeviceOrientationEvent,
    ].filter(Boolean);

    if (sensorEventTypes.length === 0) return false;

    const permissionRequests = sensorEventTypes
      .filter(EventType => typeof EventType.requestPermission === 'function')
      // Invoke every request synchronously so iOS still treats this as the
      // button's user gesture before either permission prompt resolves.
      .map(EventType => EventType.requestPermission());

    if (permissionRequests.length === 0) return true; // Android / non-iOS

    try {
      const results = await Promise.all(permissionRequests);
      return results.includes('granted');
    } catch {
      return false;
    }
  }

  /**
   * Check whether the device has motion sensor support.
   * @returns {boolean}
   */
  hasSensors() {
    return typeof DeviceMotionEvent !== 'undefined' ||
      typeof DeviceOrientationEvent !== 'undefined';
  }

  /**
   * Returns whether this browser requires an explicit user gesture before it
   * will show the motion-sensor permission prompt (notably iOS Safari).
   * @returns {boolean}
   */
  requiresPermissionGesture() {
    return [
      globalThis.DeviceMotionEvent,
      globalThis.DeviceOrientationEvent,
    ].some(EventType => typeof EventType?.requestPermission === 'function');
  }

  /**
   * Start harvesting entropy from sensors, or fall back to CSPRNG.
   * @returns {Promise<Uint8Array>} - 32-byte entropy buffer
   */
  async harvest() {
    if (this._running) throw new Error('TRNG already running');
    this._running = true;
    this._rawBits = [];
    this._debiasedBits = [];
    this._auditSamples = [];
    this._auditSamplesDropped = 0;
    this._lastHarvestMode = null;

    const hasSensors = this.hasSensors();
    this._emitProgress();
    this._emitStatus(hasSensors
      ? 'Requesting motion-sensor permission…'
      : 'Preparing Web Crypto fallback…');

    const permGranted = hasSensors ? await this.requestPermission() : false;

    if (!hasSensors || !permGranted) {
      return this._fallbackHarvest();
    }

    return this._sensorHarvest();
  }

  /**
   * Harvest entropy from device motion sensors.
   * @private
   */
  _sensorHarvest() {
    this._usedSensor = true;
    this._lastHarvestMode = 'device-sensors';
    this._emitStatus('Listening for device motion…');

    return new Promise((resolve) => {
      let isFinished = false;
      let timeoutId = null;

      const cleanup = () => {
        window.removeEventListener('devicemotion', onMotion);
        window.removeEventListener('deviceorientation', onOrientation);
        if (timeoutId) clearTimeout(timeoutId);
      };

      const finish = () => {
        if (isFinished) return;
        isFinished = true;
        cleanup();
        this._finalise(resolve);
      };

      const collect = (source, event, readings, sample) => {
        this._recordAuditSample(source, event.timeStamp, sample);

        if (readings.length === 0) return;

        const rawBits = readings.flatMap(extractLSBs);
        const debiasedBatch = vonNeumannExtract(rawBits);

        this._rawBits.push(...rawBits);
        this._debiasedBits.push(...debiasedBatch);

        this._emitProgress();

        if (this._debiasedBits.length >= BITS_NEEDED) finish();
      };

      const onMotion = (event) => {
        const acc = event.accelerationIncludingGravity || event.acceleration;
        const rot = event.rotationRate;
        const readings = [
          acc?.x, acc?.y, acc?.z,
          rot?.alpha, rot?.beta, rot?.gamma,
        ].filter(v => v !== null && v !== undefined && !isNaN(v) && v !== 0);

        collect('devicemotion', event, readings, {
          acceleration: this._serialiseAxes(acc, ['x', 'y', 'z']),
          rotationRate: this._serialiseAxes(rot, ['alpha', 'beta', 'gamma']),
        });
      };

      window.addEventListener('devicemotion', onMotion);

      // Also try deviceorientation as supplementary source
      const onOrientation = (event) => {
        const readings = [event.alpha, event.beta, event.gamma]
          .filter(v => v !== null && v !== undefined && !isNaN(v));

        collect('deviceorientation', event, readings, {
          orientation: this._serialiseAxes(event, ['alpha', 'beta', 'gamma']),
        });
      };
      window.addEventListener('deviceorientation', onOrientation);

      // Safety timeout — if no motion after 30s, fall back
      timeoutId = setTimeout(() => {
        if (this._debiasedBits.length < BITS_NEEDED) {
          console.warn('[TRNG] Sensor timeout, supplementing with CSPRNG');
          this._emitStatus('Sensor input was insufficient — adding CSPRNG entropy…');
          this._lastHarvestMode = 'device-sensors-with-csprng-supplement';
          this._supplementWithCSPRNG();
          finish();
        }
      }, SENSOR_TIMEOUT_MS);
    });
  }

  /**
   * Supplement debiased bits with CSPRNG to reach 256 bits.
   * @private
   */
  _supplementWithCSPRNG() {
    const remaining = BITS_NEEDED - this._debiasedBits.length;
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

  /**
   * CSPRNG fallback when no sensors are available.
   * @private
   */
  async _fallbackHarvest() {
    this._usedSensor = false;
    this._lastHarvestMode = 'csprng-fallback';
    this._emitStatus('No usable motion sensor — generating CSPRNG entropy…');

    // Web Crypto completes almost immediately. Yield between real pipeline
    // stages so the loading screen can render meaningful progress updates.
    for (const percent of [20, 45, 70]) {
      this._emitProgress(percent);
      await wait(120);
    }

    const rawEntropy = new Uint8Array(32);
    crypto.getRandomValues(rawEntropy);

    // Still pipe through SHA-256 for consistency
    this._emitStatus('Conditioning entropy with SHA-256…');
    this._emitProgress(90);
    await wait(120);
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawEntropy);
    const entropy = new Uint8Array(hashBuffer);

    this._running = false;
    this._emitProgress(100, BITS_NEEDED);
    this.dispatchEvent(new CustomEvent('complete', {
      detail: { entropy, usedSensor: false, rawBits: [] }
    }));
    return entropy;
  }

  /**
   * Finalise: whiten collected bits through SHA-256 and emit complete.
   * @private
   */
  async _finalise(resolve) {
    const bitsToUse = this._debiasedBits.slice(0, BITS_NEEDED);
    const rawBytes = bitsToBytes(bitsToUse);

    // SHA-256 whitening pass
    this._emitStatus('Conditioning collected entropy with SHA-256…');
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawBytes);
    const entropy = new Uint8Array(hashBuffer);

    this._running = false;
    this._emitProgress(100);

    const completeEvent = new CustomEvent('complete', {
      detail: {
        entropy,
        usedSensor: this._usedSensor,
        rawBits: [...this._rawBits],
      }
    });
    this.dispatchEvent(completeEvent);
    if (resolve) resolve(entropy);
  }

  /**
   * Emit current progress as an event.
   * @private
   */
  _emitProgress(overridePercent = null, overrideBitsCollected = null) {
    const bitsCollected = overrideBitsCollected ?? this._debiasedBits.length;
    const percent = overridePercent ?? Math.min(100, Math.floor((bitsCollected / BITS_NEEDED) * 100));
    this.dispatchEvent(new CustomEvent('progress', {
      detail: { percent, bitsCollected, bitsNeeded: BITS_NEEDED }
    }));
  }

  /**
   * Emit a plain-language status update for the loading screen.
   * @param {string} message
   * @private
   */
  _emitStatus(message) {
    this.dispatchEvent(new CustomEvent('status', { detail: { message } }));
  }

  /**
   * Store a bounded copy of source samples for the user-initiated audit log.
   * @private
   */
  _recordAuditSample(source, timestamp, values) {
    if (this._auditSamples.length >= MAX_AUDIT_SAMPLES) {
      this._auditSamplesDropped++;
      return;
    }

    this._auditSamples.push({
      source,
      timestamp: Math.round(timestamp * 1000) / 1000,
      values,
    });
  }

  /**
   * Copy supported numeric axes into a JSON-safe object.
   * @private
   */
  _serialiseAxes(source, axes) {
    if (!source) return null;

    const result = {};
    for (const axis of axes) {
      const value = source[axis];
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[axis] = value;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Export raw sensor samples for auditability without exposing the final
   * entropy buffer or session keys.
   * @returns {object}
   */
  exportAuditLog() {
    return {
      format: 'securelink-entropy-audit-v1',
      generatedAt: new Date().toISOString(),
      source: this._lastHarvestMode,
      sensorSamplesCollected: this._auditSamples.length,
      sensorSamplesOmitted: this._auditSamplesDropped,
      debiasedBitsCollected: this._debiasedBits.length,
      samples: this._auditSamples.map(sample => ({
        ...sample,
        values: JSON.parse(JSON.stringify(sample.values)),
      })),
      note: 'Raw sensor samples only. Final entropy, derived keys, and messages are never exported.',
    };
  }

  /**
   * Return recent extracted bits for the oscilloscope only.
   * @returns {number[]}
   */
  exportRawData() {
    return [...this._rawBits];
  }
}

/** @param {number} ms @returns {Promise<void>} */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { TRNG };
