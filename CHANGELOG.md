# Changelog

All notable changes to the Ultimate List Extractor are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The release CI (`.github/workflows/release.yml`) reads the section matching the pushed tag (e.g. `v1.2.0` matches `## [1.2.0]`) and prepends a `SHA256:` line for the in-extension integrity check.

## [1.1.0] - 2026-04-29

### Added
- **In-extension update flow.** A new pill in the popup header surfaces when a newer GitHub release is detected. Clicking it opens a 3-step modal: download (with SHA256 integrity verification), replace folder (platform-aware copy snippets for Windows and macOS), and apply (calls `chrome.runtime.reload()`).
- **About panel.** Collapsible `<details>` at the bottom of the popup shows version, last-checked timestamp, distribution channel (GitHub-unpacked vs Chrome Web Store), an editable install-path hint, a "Check for Updates" button, and a rolling log of the last 5 update events.
- **Periodic background check.** Service worker uses `chrome.alarms` to query GitHub for new releases every 4 hours. Cached in `chrome.storage.local` with a TTL so popup opens are instant.
- **Cross-profile drift detection.** When one Chrome profile applies an update, sibling profiles pointing at the same unpacked folder see a "Files updated by another profile — please reload" hint. Coordinated via `chrome.storage.sync`.
- **Telemetry, privacy-first.** All update events log to `chrome.storage.local.ule_update_log` (rotating 20-entry ring buffer). No third-party analytics. About panel surfaces the most recent 5 for debugging.

### Changed
- `manifest.json` — bumped to 1.1.0; added `homepage_url`, `host_permissions` for `api.github.com` and `*.githubusercontent.com`, and the `alarms` permission. No new user-facing permission prompts beyond what is needed for the update API.
- `background/background.js` — now imports `update.js` via `importScripts`. Top-level boot code evaluates a `ule_pending_apply` sentinel set by the popup before reload, so the post-reload service worker can record whether the on-disk file replacement actually succeeded.

### Security
- Update ZIP downloads are verified against a SHA256 hash published in the release notes before being saved. A mismatch aborts the update and surfaces an `integrity_check_failed` error in the About log.

### Notes for end users
- The update flow can detect, download, and apply new versions on the user's command — but Chrome cannot replace the unpacked extension folder on disk for you. The modal walks through the brief manual step (Windows: PowerShell snippet provided; macOS: Terminal snippet provided).
- For true silent auto-updates, watch for v1.3.0 — the extension will be published to the Chrome Web Store as Unlisted.

## [1.0.0] - 2026-04-09

### Added
- Initial MVP: visual element selector, human-like auto-scroll with three speed presets (slow/medium/fast) including randomized variance and pause chance, smart data extraction (table-first, repeated-children fallback), CSV / Excel / PDF export, persistent state across popup open/close cycles via `chrome.storage.local`.

[Unreleased]: https://github.com/zevinpatel-design/gl-ultimate-list-scraper/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/zevinpatel-design/gl-ultimate-list-scraper/releases/tag/v1.1.0
[1.0.0]: https://github.com/zevinpatel-design/gl-ultimate-list-scraper/releases/tag/v1.0.0
