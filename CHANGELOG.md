# Changelog

All notable changes to the Ultimate List Extractor are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The release CI (`.github/workflows/release.yml`) reads the section matching the pushed tag (e.g. `v1.2.0` matches `## [1.2.0]`) and prepends a `SHA256:` line for the in-extension integrity check.

## [1.1.1] - 2026-04-29

### Fixed
- **Scroller no longer fails silently after page reload.** Before: clicking *Start Scrolling* did nothing if the page had reloaded since selection — `state.selectedElement` was null but the popup UI thought selection persisted (it lives in `chrome.storage.local`). Now the content script re-acquires the live DOM node from the stored selector on each `startScroll`, and surfaces a clear "Selection lost — please re-select" message if it can't.
- **Scroller no longer exits early at "Fast" speed.** Before: `scrollBy({ behavior: 'smooth' })` returned immediately while the scroll was still in flight, the next loop iteration read `scrollTop` mid-transit, saw the same value as last time, incremented `noChangeCount`, and exited after 8 false stuck-reads — sometimes capturing only the first ~10% of a list. Now the scroller uses `behavior: 'auto'` (instant) and waits one paint frame before reading the new position. Position reads are stable; the early-exit heuristic is sound again.
- **Scroller now handles document/window-level scrolling.** Before: if the user clicked an element with no `overflow-y: auto` parent within 10 levels, the scroller fell back to `document.documentElement` and called `scrollBy` on it — which works on some pages but not when `body` is the actual scroll target. Now there's a unified `findScrollContext()` helper that returns either an element-scroll handle or a window-scroll handle, with a 50-level parent walk and a final document-level fallback that reads from `window.scrollY` and writes via `window.scrollBy`.
- **Scroller now survives SPA re-renders that detach the selected container.** Before: many list-heavy SPAs (including VDB) re-render the list during scroll, detaching the original element from the DOM. The old code kept calling `scrollTop` on the detached node — always 0 — and exited early. Now there's a per-iteration `document.body.contains(...)` check; on detachment, the scroller re-acquires from storage and rebuilds the scroll context.
- **Scroller now waits out lazy-loading.** Before: when scroll position stalled near the bottom, the scroller exited within 8 iterations even if more items were loading. Now we also watch for `scrollHeight` growth across iterations and reset the stuck-counter on growth — giving lazy-loaders time to land.

### Added
- `chrome.storage.local.ule_scroll_debug` — rotating 80-entry log of scroll start/recovery/end events for troubleshooting. Open the service worker DevTools and run `chrome.storage.local.get('ule_scroll_debug').then(r => console.table(r.ule_scroll_debug))` to inspect.
- `scrollError` message from content script → popup (with `errorCode: 'no_selection'` etc.) so the user sees a clear status message when scrolling can't start, instead of the prior silent-no-op behaviour.

### Notes
- v1.1.0 is the version teammates need to be on for the in-extension Update flow to deliver this patch automatically. Anyone still on v1.0.0 will need to download v1.1.1 manually from the release page.

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
