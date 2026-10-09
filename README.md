<p align="center">
  <img src="assets/afrobat-icon.png" alt="アフロバット" width="128" />
</p>

<h1 align="center">PDF Edit Lite</h1>

<p align="center">
  Cross-platform desktop PDF editor with WYSIWYG text and image editing.<br/>
  Fully offline — no cloud, no subscriptions, no account required.
</p>

---

## Download

This repository does not have a packaged installer yet. The current development build runs from source on Windows after the native PDFium addon is built.

---

## Features

- **Edit text** directly on the PDF — double-click any text to modify it
- **Replace images** — swap embedded images with your own PNG or JPEG files
- **Undo / Redo** — full edit history with Ctrl+Z / Ctrl+Shift+Z
- **Multi-page** — navigate, zoom, and edit any page
- **Save & Save As** — Ctrl+S overwrites; Ctrl+Shift+S saves a copy
- **Thumbnails** — sidebar page previews for quick navigation
- **100% offline** — no internet connection needed, your files never leave your computer
- **Open source** — MIT licensed

---

## For Developers

Built with **Electron**, **PDFium** (native N-API addon), and **TypeScript**.

### Quick Start

```bash
npm install
npm start
```

Development mode (DevTools open):
```bash
npm run dev
```

### Build

```bash
# Compile TypeScript only
npm run build

# Build native PDFium addon (requires node-gyp and PDFium headers)
npm run build:native

# Package for current OS
npm run pack

# Create distributable installer
npm run dist
```

### Packaging Targets

| Platform | Format | Notes |
|----------|--------|-------|
| Windows  | MSI (WiX) + NSIS | `electron-wix-msi` for enterprise deployment |
| macOS    | DMG | Hardened runtime, notarised |
| Linux    | AppImage | Universal, no-install |

### Architecture

```
src/
├── main/            # Electron main process
│   ├── index.ts           # App lifecycle, window creation, CSP enforcement
│   ├── ipc-handlers.ts    # IPC handler registration (typed, validated)
│   └── pdfium.ts          # PdfiumEngine façade (wraps native addon)
├── preload/         # Preload bridge (contextBridge → window.api)
│   └── index.ts
├── renderer/        # UI (no Node/Electron access)
│   ├── index.html         # Document shell with toolbar, canvas viewer
│   ├── styles.css         # Dark theme, canvas, overlays
│   └── app.ts             # Viewer, zoom/pan, editing, undo/redo
└── shared/          # Types, constants, IPC schema shared across processes
    ├── constants.ts
    └── ipc-schema.ts
native/
└── pdfium/          # C++ N-API addon wrapping PDFium
    ├── binding.gyp
    └── src/
```

#### PDFium Engine

The rendering and editing engine is **PDFium** (Chromium's PDF library), exposed to Node.js via a native N-API addon. The `PdfiumEngine` TypeScript façade manages document handles, validates inputs, normalises errors, and provides typed async methods.

Key features:
- **Canvas rendering:** Pages rendered to RGBA bitmaps via `FPDF_RenderPageBitmap`
- **LRU bitmap cache:** Bounded by `MAX_BITMAP_CACHE_BYTES` (256 MB default)
- **Render queue:** Concurrent renders limited by `RENDER_CONCURRENCY_LIMIT`
- **Object inspection:** `listPageObjects` returns text/image bounding boxes
- **Text editing:** `editTextObject` modifies glyph content via PDFium edit API
- **Image replacement:** `replaceImageObject` swaps embedded images (PNG/JPEG)
- **Save:** `FPDF_SaveAsCopy` serialisation with dirty-state tracking

#### Security Model

| Layer               | Protection                                       |
|---------------------|--------------------------------------------------|
| `nodeIntegration`   | **Disabled** — renderer has no Node access        |
| `contextIsolation`  | **Enabled** — preload runs in isolated context    |
| `sandbox`           | **Enabled** — OS-level renderer sandboxing        |
| CSP                 | Enforced via response headers and meta tag        |
| IPC                 | Typed schema; channel allow-list; unknown rejected|
| Navigation          | Blocked; `window.open` denied                     |
| Single instance     | Second launch focuses existing window             |
| Offline             | No network calls; auto-update disabled by default |

### Packaging & Distribution

#### Build Installers

```bash
# Build for current platform
npm run dist

# Build for specific platform
npm run dist:win     # Windows NSIS installer
npm run dist:mac     # macOS DMG
npm run dist:linux   # Linux AppImage
```

Installers are written to the `release/` directory.

#### Windows MSI (Enterprise)

For enterprise environments requiring MSI packages:

```bash
# 1. Build unpacked app first
npm run pack

# 2. Compile MSI (requires WiX Toolset v3)
npm run build:msi
```

**Prerequisites:** Install [WiX Toolset v3](https://wixtoolset.org/docs/wix3/) and ensure the `WIX` environment variable is set or WiX `bin/` is on PATH.

#### Native Addon in Packaged Builds

The native PDFium addon (`pdfium.node` + shared library) is automatically extracted from the asar archive via `asarUnpack`. The addon loader in `src/main/pdfium.ts` detects packaged mode (`app.isPackaged`) and resolves the path to `app.asar.unpacked/native/pdfium/build/Release/`.

#### Code Signing & Notarization

##### Windows (Authenticode)

Set the following environment variables before running `npm run dist:win`:

| Variable | Description |
|----------|-------------|
| `CSC_LINK` | Path to `.pfx` certificate file (or base64-encoded) |
| `CSC_KEY_PASSWORD` | Certificate password |
| `WIN_CSC_LINK` | *(optional)* Override for Windows-specific cert |

electron-builder will sign the EXE automatically when these are set.

##### macOS (Apple Notarization)

Set the following environment variables:

| Variable | Description |
|----------|-------------|
| `CSC_LINK` | Path to `.p12` Developer ID certificate (or base64) |
| `CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (generate at appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character Team ID from developer.apple.com |

The build uses `build/entitlements.mac.plist` which grants:
- `com.apple.security.cs.allow-jit` — required by V8/Chromium
- `com.apple.security.cs.allow-unsigned-executable-memory` — required by Electron
- `com.apple.security.cs.disable-library-validation` — required for the prebuilt PDFium shared library

##### Linux

No code signing is typically required for AppImage distribution. For package managers (deb, rpm), GPG signing can be configured separately.

#### CI/CD Notes

- Store signing certificates as **encrypted secrets** in your CI system (GitHub Actions, Azure DevOps, etc.)
- Never commit `.pfx`, `.p12`, or password files to the repository
- The `publish` field in `package.json` is set to `null` (auto-update disabled). Set it to a GitHub/S3/generic provider when ready to enable auto-updates.

## Upstream and license

This repository incorporates the Electron/PDFium editor implementation from [kudosscience/pdf-chisel](https://github.com/kudosscience/pdf-chisel), retrieved from its `main` branch on 2026-10-09. The upstream project declares MIT licensing. This project keeps the upstream architecture and adds product-specific work on top.

The PDFium native binaries are downloaded separately by `npm run download:pdfium` and are not committed to this repository.

## License

MIT
