# 🔐 SecureLink — Serverless P2P E2EE Chat with Hardware TRNG

[![CI / Deploy](https://github.com/deeyeti/e2ee-chat-trng/actions/workflows/deploy.yml/badge.svg)](https://github.com/deeyeti/e2ee-chat-trng/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-7b2fff.svg)](LICENSE)

> **A serverless, peer-to-peer, end-to-end encrypted chat application where encryption keys are derived from true physical entropy harvested from your device's motion sensors.**

🌐 **Live App**: [https://deeyeti.github.io/e2ee-chat-trng](https://deeyeti.github.io/e2ee-chat-trng)
<img width="1919" height="893" alt="image" src="https://github.com/user-attachments/assets/d6c94d82-6f91-4152-a631-5c78e8d0139d" />


<img width="1919" height="891" alt="image" src="https://github.com/user-attachments/assets/a9ed959e-7163-40d7-bfee-e778dcf4d109" />


---

## Features

| Feature | Detail |
|---|---|
| **True Hardware TRNG** | Extracts least-significant bits from accelerometer/gyroscope sensor readings |
| **Von Neumann Debiasing** | Removes correlation and bias from the raw sensor bit stream |
| **SHA-256 Whitening** | Final cryptographic hash pass over collected entropy |
| **ECDH P-256 Key Exchange** | Ephemeral Diffie-Hellman key pair per session |
| **HKDF-SHA-256 KDF** | Mixes ECDH shared secret with TRNG entropy for the final AES key |
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
│  1. TRNG harvest        │              │  1. TRNG harvest        │
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

### Step 1 — TRNG Entropy Extraction

```
Sensor readings (60 Hz)
    │
    ▼
Extract decimal digits 4–7 (LSBs — thermal + quantization noise)
    │  X-axis: 9.812345[6789...]  →  bits: 0110...
    │  Y-axis: 0.234567[8901...]  →  bits: 1010...
    │  Z-axis: 1.987654[3210...]  →  bits: 0101...
    ▼
Von Neumann extractor (removes bias)
    │  (0,1) → emit 0  |  (1,0) → emit 1  |  (0,0),(1,1) → discard
    ▼
Accumulate 256 debiased bits
    ▼
SHA-256(raw_bytes) → 32-byte conditioned entropy
```

### Step 2 — Key Exchange

```
TRNG Entropy (32 bytes)
    │
    ├─── ECDH P-256 keygen (browser CSPRNG + entropy mixing)
    │         │
    │    Public Key ──── over WebRTC DataChannel ────► Peer
    │         ◄─── Peer's Public Key ─────────────────
    │
    ▼
ECDH Shared Secret (256 bits)
    │
XOR with TRNG entropy
    │
HKDF-SHA-256(salt, info: "e2ee-chat-trng-session-v1")
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
| **TRNG mode** | Mobile/tablet with accelerometer + gyroscope |
| **Fallback mode** | Desktop — uses `crypto.getRandomValues()` CSPRNG with SHA-256 whitening |
| **Browser** | Chrome 90+, Firefox 90+, Safari 15+ |
| **Connection** | Both peers need internet for WebRTC signaling (via PeerJS) |

---

## 🔒 Security Notes

- **Session isolation**: Every session generates unique ephemeral ECDH keys. No key reuse.
- **Forward secrecy**: ECDH keys are ephemeral — a compromised session does not expose other sessions.
- **Zero-knowledge**: Keys exist only in JavaScript heap memory. Closing the tab destroys all key material.
- **DTLS + AES-GCM**: Double-layer encryption (WebRTC DTLS transport + AES-GCM application layer).
- **No signaling data**: The PeerJS signaling server only sees your peer ID and SDP — never any messages or keys.

---

## 📋 Changelog

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
