# Ultimate List Extractor

A Chrome extension that extracts scrollable lists from any webpage. Select a list container, auto-scroll to capture all items, and export to CSV, Excel, or PDF — with built-in self-update from GitHub.

[![Latest Release](https://img.shields.io/github/v/release/zevinpatel-design/gl-ultimate-list-scraper?label=release)](https://github.com/zevinpatel-design/gl-ultimate-list-scraper/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](manifest.json)

## Features

- **Visual element selector** — hover and click to pick any scrollable list container.
- **Human-like auto-scroll** — randomized delays, variable step sizes, and natural pauses to avoid bot-detection patterns. Three speed presets (Slow / Medium / Fast).
- **Smart data extraction** — auto-detects tables, repeated list items, and structured content. Falls back to direct-children parsing when no obvious table exists.
- **Multiple export formats** — CSV, Excel (.xls), PDF — all generated client-side, no external services.
- **Stealth-first** — no API calls, no headless behavior, no third-party analytics. Only `chrome.storage.local` for state, plus the GitHub Releases API for update checks.
- **In-extension self-update from GitHub** *(new in v1.1.0)* — a small pill in the popup header surfaces when a new release is available. SHA-256 integrity verification before save. Platform-aware replace instructions (Windows PowerShell / macOS Terminal). Cross-profile drift detection.

## Quick install

1. Download the [latest ZIP](https://github.com/zevinpatel-design/gl-ultimate-list-scraper/releases/latest).
2. Extract the ZIP somewhere durable.
3. Open `chrome://extensions/` → toggle **Developer mode** on → click **Load unpacked** → select the extracted folder.
4. Open the popup → expand **About** → paste your extracted folder path into the *Install path* field (so future updates can tell you exactly which folder to replace).

Full install walkthrough with screenshots: [`docs/INSTALL.md`](docs/INSTALL.md).

## How updates work

When ZP publishes a new release (`git tag vX.Y.Z && git push --tags`):

1. CI builds a versioned ZIP, computes its SHA-256, and creates a GitHub Release with the ZIP attached and the SHA published in the release body.
2. Within 4 hours, every teammate's extension detects the new version on its next popup open or background check.
3. The popup shows an **Update vX.Y.Z** pill in the header.
4. Clicking the pill opens a 3-step modal:
   - **A** — extension downloads the ZIP, verifies the SHA-256, saves to Downloads.
   - **B** — clear instructions (with platform-specific snippets) for replacing the extension folder contents.
   - **C** — click **Apply** → `chrome.runtime.reload()` → new version active.
5. Cross-profile drift is detected via `chrome.storage.sync`; sibling profiles see a "please reload this profile's extension" hint.

Full update walkthrough: [`docs/UPDATE.md`](docs/UPDATE.md).

## Architecture

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3, permissions: `activeTab`, `storage`, `downloads`, `alarms`. Host permissions: `api.github.com`, `*.githubusercontent.com`. |
| `popup/popup.html` | UI markup: 3 step cards (Select / Scroll / Export), header with version + update pill, modal for the apply flow, collapsible About panel. |
| `popup/popup.js` | UI controller. State machine restored from `chrome.storage.local` on every popup open (popup closes during element selection). Wires the update modal. Hand-built CSV / XLS / PDF exporters with zero dependencies. |
| `popup/popup.css` | Dark theme. v1.1.0 keeps existing v1.0.0 styles untouched; new update UI styling is appended. v1.2.0 will refresh the whole visual language. |
| `popup/update.js` | Version compare, GitHub Releases lookup with caching, SHA-256 verify (Web Crypto), download wrapper, apply (`runtime.reload()` with sentinel), session resume, cross-profile drift detection. Also loaded by the service worker via `importScripts`. |
| `content/content.js` | DOM interaction inside the page: element-selection overlay, human-like scrolling, data extraction. Persists state to `chrome.storage.local` so the popup can restore. |
| `content/content.css` | Hover-highlight and selection ring styles for the in-page selection overlay. |
| `background/background.js` | Service worker. Top-level boot evaluates the post-reload `ule_pending_apply` sentinel (the only place this can run, because `runtime.reload()` destroys the popup). `chrome.alarms` schedules background update checks every 4h. |
| `scripts/build.sh` | Deterministic ZIP builder. Used by `release.yml` and (later) `webstore.yml`. |
| `.github/workflows/release.yml` | On `v*.*.*` tag push: verifies tag matches manifest version, builds ZIP, computes SHA-256, extracts CHANGELOG section, creates GitHub Release with ZIP asset and SHA in release body. |
| `.github/workflows/webstore.yml.disabled` | Stub for v1.3.0. Rename to enable Chrome Web Store auto-publish. |

## Roadmap

- **v1.1.0** — GitHub-driven update mechanism *(this release)*
- **v1.2.0** — Visual refresh aligned to ZP brand (architectural / precision-engineered): polished-platinum primary, locally-bundled Fraunces + Inter Variable, single-signature scribed-hairline microinteraction, Windows-DPI-safe inset borders, inline SVG icons.
- **v1.3.0** — Chrome Web Store Unlisted publication for true silent auto-updates.

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Development

```bash
# Build a local ZIP for testing
./scripts/build.sh

# Tag and trigger a release (CI builds + publishes)
git tag v1.1.0
git push origin v1.1.0
```

## License

[MIT](LICENSE) © 2026 Zevin Patel
