# 🔐 SecureLink — Serverless P2P E2EE Chat

[![CI / Deploy](https://github.com/deeyeti/e2ee-chat-trng/actions/workflows/deploy.yml/badge.svg)](https://github.com/deeyeti/e2ee-chat-trng/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-7b2fff.svg)](LICENSE)

> **A serverless, peer-to-peer, end-to-end encrypted chat application using browser Web Crypto for ephemeral key generation and ECDH session establishment. Device motion collection is optional and auditable.**

🌐 **Live App**: [https://deeyeti.github.io/e2ee-chat-trng](https://deeyeti.github.io/e2ee-chat-trng)
<img width="1919" height="893" alt="image" src="https://github.com/user-attachments/assets/d6c94d82-6f91-4152-a631-5c78e8d0139d" />


<img width="1919" height="891" alt="image" src="https://github.com/user-attachments/assets/a9ed959e-7163-40d7-bfee-e778dcf4d109" />
<img width="1919" height="899" alt="image" src="https://github.com/user-attachments/assets/3bf49da6-e2e3-4241-8767-a003354bbbb5" />



---

## Features

| Feature | Detail |
|---|---|
| **Device Entropy Audit** | Collects and exports motion samples for user-visible diagnostics and audit |
| **Von Neumann Debiasing** | Reduces bias in the collected sensor bit stream |
| **SHA-256 Whitening** | Conditions the captured sensor stream for audit reporting |
| **ECDH P-256 Key Exchange** | Browser-CSPRNG-generated ephemeral Diffie-Hellman key pair per session |
| **HKDF-SHA-256 KDF** | Derives the AES key from the shared ECDH secret and canonical public-key transcript |
| **AES-GCM-256 E2EE** | Every message encrypted with a fresh 96-bit random IV |
| **WebRTC P2P** | Direct browser-to-browser via PeerJS signaling (signaling server dropped after handshake) |
| **Zero-Knowledge** | No keys, messages, or metadata ever touch `localStorage`, `sessionStorage`, or IndexedDB |
| **Static Hosting** | 100% client-side — hosted on GitHub Pages, no backend ever |
| **Entropy Audit** | Export raw sensor data as JSON to verify physical entropy origin |

---

## 🏗️ Architecture

```
Browser A (Initiator)                    Browser B (Joiner)
┌─────────────────────────┐              ┌─────────────────────────┐
│  1. Device audit sample │              │  1. Device audit sample │
│     LSB extraction      │              │     LSB extraction      │
│     Von Neumann debias  │              │     Von Neumann debias  │
│     SHA-256 whitening   │              │     SHA-256 whitening   │
│                         │              │                         │
│  2. ECDH P-256 keygen   │              │  2. ECDH P-256 keygen   │
│                         │              │                         │
│  3. PeerJS signaling ───┼─── SDP/ICE ─┼──────────────────────── │
│     (dropped after)     │              │     (dropped after)     │
│                         │              │                         │
│  4. WebRTC DataChannel ─┼─── P2P ─────┼──────────────────────── │
│     ECDH pub key xchg   │              │     ECDH pub key xchg   │
│                         │              │                         │
│  5. HKDF shared key     │              │  5. HKDF shared key     │
│  6. AES-GCM-256 E2EE   │◄─ messages ─►│  6. AES-GCM-256 E2EE   │
└─────────────────────────┘              └─────────────────────────┘
         ↑ signaling only during handshake ↑
         PeerJS server (0.peerjs.com)
```

---

## 🔑 Cryptographic Pipeline

### Step 1 — Optional Device Entropy Collection

```
Sensor readings (60 Hz)
    │
    ▼
Scale sensor readings to fixed point and extract low-order binary bits
    │  X-axis: 9.812 → 9812 → bits: 0100...
    │  Y-axis: 0.235 → 235  → bits: 1011...
    │  Z-axis: 1.988 → 1988 → bits: 0100...
    ▼
Von Neumann extractor (removes bias)
    │  (0,1) → emit 0  |  (1,0) → emit 1  |  (0,0),(1,1) → discard
    ▼
Accumulate 256 debiased bits
    ▼
SHA-256(raw_bytes) → conditioned audit sample
```

> Device samples drive the progress display and optional audit log. They never alter a shared session key unless both peers possess the same material.

### Step 2 — Key Exchange

```
Browser CSPRNG → ephemeral ECDH P-256 key pair
    │
    │    Public Key ──── over WebRTC DataChannel ────► Peer
    │         ◄─── Peer's Public Key ─────────────────
    │
    ▼
ECDH Shared Secret (256 bits) + sorted pair of public keys
    │
SHA-256(public-key transcript) → HKDF salt
    │
HKDF-SHA-256(shared secret, transcript salt, info: "securelink-session-v2")
    │
    ▼
AES-GCM-256 Session Key (non-extractable CryptoKey)
```

### Step 3 — Message Encryption

```
Plaintext → AES-GCM-256(key, iv=random_96_bits) → [IV | Ciphertext]
                                                        │
                                                   base64-encode
                                                        │
                                                   WebRTC DataChannel
```

---

## 📁 Project Structure

```
e2ee-chat-trng/
├── index.html                  # App shell — 4-phase single-page app
├── css/
│   └── styles.css              # Full design system (dark/neon theme)
├── js/
│   ├── trng.js                 # Hardware entropy harvester
│   ├── crypto.js               # ECDH + HKDF + AES-GCM engine
│   ├── webrtc.js               # PeerJS/WebRTC connection manager
│   ├── ui.js                   # UI controller + oscilloscope viz
│   └── app.js                  # State machine orchestrator
├── .github/
│   └── workflows/
│       └── deploy.yml          # CI: lint + tag + deploy to GitHub Pages
├── .eslintrc.json
├── .gitignore
├── package.json
└── README.md
```

---

## 🚀 Deployment

The app is automatically deployed to GitHub Pages on every push to `main` via GitHub Actions:

1. **Lint** — ESLint validates all JS files
2. **Zero-Knowledge check** — CI fails if any storage API is found in source
3. **Tag** — Semantic version tag created (`v1.x.x` with changelog)
4. **Release** — GitHub Release created automatically
5. **Deploy** — Static files pushed to `gh-pages` environment

---

## 🛠️ Local Development

```bash
# Install dev dependencies (ESLint)
npm install

# Run linter
npm run lint

# Serve locally (any static server)
npx serve .
# or
python -m http.server 8080
```

> **Note**: The app uses ES Modules (`type="module"`), so it must be served over HTTP — opening `index.html` directly as a `file://` URL will not work due to CORS restrictions on modules.

---

## ⚠️ Device Requirements

| Requirement | Detail |
|---|---|
| **Device audit mode** | Mobile/tablet with accelerometer or gyroscope; optional on supported laptops |
| **Key generation** | All devices — browser Web Crypto CSPRNG and ephemeral ECDH |
| **Browser** | Chrome 90+, Firefox 90+, Safari 15+ |
| **Connection** | Both peers need internet for WebRTC signaling (via PeerJS) |

---

## 🔒 Security Notes

- **Session isolation**: Every session generates unique ephemeral ECDH keys. No key reuse.
- **Forward secrecy**: ECDH keys are ephemeral — a compromised session does not expose other sessions.
- **Shared derivation**: The AES key is derived only from the shared ECDH secret and a deterministic public-key transcript, so both peers calculate the same key.
- **Device samples**: Local motion samples remain local/auditable and are never mixed asymmetrically into a shared key.
- **Zero-knowledge**: Keys exist only in JavaScript heap memory. Closing the tab destroys all key material.
- **DTLS + AES-GCM**: Double-layer encryption (WebRTC DTLS transport + AES-GCM application layer).
- **No signaling data**: The PeerJS signaling server only sees your peer ID and SDP — never any messages or keys.

---

## 📋 Changelog

### v1.4.0 — Metadata-Free Manual WebRTC & MITM Detection

**Security Enhancements**
- **Session Fingerprint (MITM Detection):** Cryptographic hash of both public keys (Signal-style). Both users see the exact same 16-hex-character string. If read aloud over a separate channel and they match, a MITM attack is mathematically impossible.
- **Manual Signaling Mode (No Server):** Users can now bypass PeerJS entirely by manually copying and pasting raw WebRTC SDP offer/answer text. This guarantees 100% metadata privacy, as no signaling server is ever contacted.

### v1.3.0 — TRNG Engine Overhaul & UI Bug Fixes

**Bug fixes**
- **All-zeros entropy on phones (critical):** Replaced fixed digit-position string slicing (`digits[4-7]`) with modular integer arithmetic (`Math.floor(|value| × 1e4) & 0xFF`). Mobile sensors typically only return 3–4 decimal places so positions 4+ were always `undefined → 0`, producing 256 bits of zeros. New method extracts real sensor noise regardless of decimal precision.
- **Progress bar 0→100 jump (fallback path):** CSPRNG fallback now animates across 20 steps over ~1.2 s with live status labels (`Seeding CSPRNG…` → `SHA-256 whitening…`).
- **Progress bar 0→100 jump (sensor path):** Progress events are now emitted on every `devicemotion` callback, not only when milestones are crossed.

**New TRNG features**
- `requiresPermissionGesture()` — detects iOS 13+ before asking for permission so the call is always inside a user gesture.
- `exportAuditLog()` — structured JSON export with version, timestamp, axis-named samples (`ax, ay, az, ra, rb, rg`), bit counts, and a hex preview of the debiased bytes. Replaces bare `rawBits` array.
- `status` events at meaningful milestones: `Entropy flowing…`, `Half way…`, `SHA-256 whitening complete`, etc.
- Safety timeout unchanged at 30 s; supplements with CSPRNG and emits a `status` event before finalising.

---

### v1.2.0 — Corrected Session Key Derivation


**Security**
- Removed asymmetric local-entropy mixing that could make peers derive different AES session keys.
- Derive the session key from the shared ECDH secret and a SHA-256 hash of the canonical public-key transcript via HKDF-SHA-256.
- Generate ephemeral ECDH keys exclusively through the browser/operating-system CSPRNG.

**Entropy collection & auditability**
- Fixed live entropy progress on orientation-only devices and added clear collection-stage status updates.
- Added the iOS motion-permission action required before sensor collection can start.
- Reworked fixed-point LSB extraction for quantised mobile sensor readings and record named raw sensor samples in audit exports.
- Moved the entropy audit download to the connection screen; exports never include final entropy, session keys, or messages.

**Chat**
- Simplified the connected-chat input placeholder to `Message…`.

---

### v1.1.0 — UI Overhaul
> Monochrome redesign · Editorial aesthetic · Glassmorphism

**UI / UX**
- Complete CSS rewrite: monochromatic grey/black/white palette replacing neon cyan/purple
- Typography upgrade to **Inter** (UI) + **JetBrains Mono** (data/code) from Google Fonts
- Replaced heavy rounded card containers with flat, borderless editorial layout
- Tab-based role switcher (Create / Join) replacing two separate role cards
- Oscilloscope redrawn in white-on-black with subtle noise texture background
- Progress bar redesigned as a hairline with a travelling dot indicator
- Chat bubbles: solid white (sent) vs glassmorphism (received), no heavy borders
- Send action changed from icon button to minimal text button
- Status indicator redesigned as a subtle pill with a 5px status dot
- Minimal header — wordmark only, removed logo icon
- Handshake steps redesigned as a clean borderline step list

**Technical**
- `ui.js` fully rewritten to match new DOM structure and class names
- Oscilloscope canvas updated to white palette with soft scan line
- `app.js` minor updates for consistent label text

---

### v1.0.0 — Initial Release
> First fully functional implementation per SRS

- Hardware TRNG pipeline: DeviceMotionEvent → LSB extraction → Von Neumann debiasing → SHA-256 whitening
- ECDH P-256 key exchange with TRNG entropy mixing via HKDF-SHA-256
- AES-GCM-256 application-layer E2EE (Web Crypto API)
- WebRTC P2P via PeerJS (signaling dropped post-handshake)
- Zero-knowledge architecture: no storage API usage (CI-enforced)
- GitHub Actions CI/CD: ESLint + zero-knowledge policy check + semantic versioning + GitHub Pages deploy

---

## 📜 License

MIT © 2026 — See [LICENSE](LICENSE)
