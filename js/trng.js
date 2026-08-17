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
 *   - 'complete'  → { detail: { entropy: Uint8Array(32), usedSensor: bool } }
 *   - 'error'     → { detail: { message: string } }
 */

const BITS_NEEDED = 256;       // 256-bit AES key
const LSB_DIGITS = [4, 5, 6, 7]; // decimal digit positions to extract from sensor floats
const SAMPLE_INTERVAL_MS = 17; // ~60 Hz

/**
 * Extract target decimal digit bits from a floating-point sensor value.
 * We ignore integer part and top decimals, focusing on thermal/quantization noise
 * in the lower decimal places.
 *
 * @param {number} value - raw sensor reading
 * @returns {number[]} - array of extracted bits (0 or 1)
 */
function extractLSBs(value) {
  const bits = [];
  const absStr = Math.abs(value).toFixed(8);
  const decPart = absStr.split('.')[1] || '';

  for (const pos of LSB_DIGITS) {
    const digit = parseInt(decPart[pos] ?? '0', 10);
    // Extract 4 bits from each decimal digit
    bits.push((digit >> 3) & 1);
    bits.push((digit >> 2) & 1);
    bits.push((digit >> 1) & 1);
    bits.push(digit & 1);
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
  }

  /**
   * Request sensor permissions (required on iOS 13+).
   * @returns {Promise<boolean>} - true if sensor access granted
   */
  async requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') {
      return false;
    }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const result = await DeviceMotionEvent.requestPermission();
        return result === 'granted';
      } catch {
        return false;
      }
    }
    return true; // Android / non-iOS — permission implicit
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
   * Start harvesting entropy from sensors, or fall back to CSPRNG.
   * @returns {Promise<Uint8Array>} - 32-byte entropy buffer
   */
  async harvest() {
    if (this._running) throw new Error('TRNG already running');
    this._running = true;
    this._rawBits = [];
    this._debiasedBits = [];

    this._emitProgress();

    const hasSensors = this.hasSensors();
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
    return new Promise((resolve) => {
      const onMotion = (event) => {
        const acc = event.accelerationIncludingGravity || event.acceleration;
        const rot = event.rotationRate;
        const readings = [
          acc?.x, acc?.y, acc?.z,
          rot?.alpha, rot?.beta, rot?.gamma,
        ].filter(v => v != null && !isNaN(v) && v !== 0);

        if (readings.length === 0) return;

        const rawBits = readings.flatMap(extractLSBs);
        const debiasedBatch = vonNeumannExtract(rawBits);

        this._rawBits.push(...rawBits);
        this._debiasedBits.push(...debiasedBatch);

        this._emitProgress();

        if (this._debiasedBits.length >= BITS_NEEDED) {
          window.removeEventListener('devicemotion', onMotion);
          this._finalise(resolve);
        }
      };

      window.addEventListener('devicemotion', onMotion);

      // Also try deviceorientation as supplementary source
      const onOrientation = (event) => {
        const readings = [event.alpha, event.beta, event.gamma]
          .filter(v => v != null && !isNaN(v));
        if (readings.length === 0) return;

        const rawBits = readings.flatMap(extractLSBs);
        const debiasedBatch = vonNeumannExtract(rawBits);
        this._rawBits.push(...rawBits);
        this._debiasedBits.push(...debiasedBatch);
      };
      window.addEventListener('deviceorientation', onOrientation);

      // Safety timeout — if no motion after 30s, fall back
      setTimeout(() => {
        if (this._debiasedBits.length < BITS_NEEDED) {
          window.removeEventListener('devicemotion', onMotion);
          window.removeEventListener('deviceorientation', onOrientation);
          console.warn('[TRNG] Sensor timeout, supplementing with CSPRNG');
          this._supplementWithCSPRNG();
          this._finalise(resolve);
        }
      }, 30000);
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
    const rawEntropy = new Uint8Array(32);
    crypto.getRandomValues(rawEntropy);

    // Still pipe through SHA-256 for consistency
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawEntropy);
    const entropy = new Uint8Array(hashBuffer);

    this._running = false;
    this.dispatchEvent(new CustomEvent('progress', {
      detail: { percent: 100, bitsCollected: 256, bitsNeeded: BITS_NEEDED }
    }));
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
  _emitProgress(overridePercent = null) {
    const bitsCollected = this._debiasedBits.length;
    const percent = overridePercent ?? Math.min(100, Math.floor((bitsCollected / BITS_NEEDED) * 100));
    this.dispatchEvent(new CustomEvent('progress', {
      detail: { percent, bitsCollected, bitsNeeded: BITS_NEEDED }
    }));
  }

  /**
   * Export raw sensor samples for auditability (SRS §4.2).
   * @returns {number[][]} copy of raw bits grouped into bytes
   */
  exportRawData() {
    return [...this._rawBits];
  }
}

export { TRNG };
