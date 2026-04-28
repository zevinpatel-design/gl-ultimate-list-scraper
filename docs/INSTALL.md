# Install Guide

## TL;DR

1. Download the latest ZIP from [Releases](https://github.com/zevinpatel-design/gl-ultimate-list-scraper/releases/latest).
2. Extract it somewhere stable (e.g. `~/Documents/extensions/ultimate-scraper/` on Mac, `C:\Users\<you>\Documents\extensions\ultimate-scraper\` on Windows).
3. Open Chrome → `chrome://extensions/` → toggle **Developer mode** on (top right).
4. Click **Load unpacked** → select the extracted folder.
5. The "Ultimate List Extractor" icon appears in your toolbar.
6. (Recommended) Open the extension → expand **About** → paste the path of your extracted folder into the *Install path* field. The Update flow uses this to tell you exactly which folder to replace next time.

## Step-by-step (Windows 10+)

1. Download `ultimate-scraper-vX.Y.Z.zip` from the [latest release](https://github.com/zevinpatel-design/gl-ultimate-list-scraper/releases/latest).
2. Right-click the ZIP → **Extract All…** → choose a destination, e.g. `C:\Users\<you>\Documents\extensions\`.
3. Open Chrome. Type `chrome://extensions/` in the address bar.
4. Toggle **Developer mode** on (top right).
5. Click **Load unpacked**.
6. Navigate to the folder you extracted (it must contain `manifest.json` directly inside).
7. Click **Select Folder**.
8. The extension is loaded. Pin it to the toolbar via the puzzle-piece icon for easy access.

### Windows tips

- If Chrome warns "Disable developer mode extensions" on every launch, you can ignore it — that's normal for unpacked installs.
- Don't move the extracted folder after loading. If you do, Chrome will mark the extension as broken; reload from the new path.
- If your company manages Chrome via Group Policy and unpacked extensions are blocked, you'll need to wait for the v1.3.0 Chrome Web Store release (Unlisted) and ask IT to allow the share link.

## Step-by-step (macOS)

1. Download `ultimate-scraper-vX.Y.Z.zip` from the [latest release](https://github.com/zevinpatel-design/gl-ultimate-list-scraper/releases/latest).
2. Double-click the ZIP to extract. Move the resulting folder to a stable location, e.g. `~/Documents/extensions/`.
3. Open Chrome. Type `chrome://extensions/` in the address bar.
4. Toggle **Developer mode** on (top right).
5. Click **Load unpacked**.
6. Navigate to the extracted folder (it must contain `manifest.json` directly inside).
7. Click **Select**.
8. The extension is loaded. Pin it to the toolbar via the puzzle-piece icon for easy access.

### macOS tips

- Gatekeeper does not interfere with Chrome extensions — they live in your Chrome profile, not in `/Applications`.
- The Spotlight-default `~/Downloads/` is a fine location too, but if you ever clear Downloads, the extension breaks. Move it somewhere durable.

## Verify the install

1. Visit any page with a long scrollable list (e.g. an internal CRM, a search results page).
2. Click the toolbar icon. The popup should open showing **Step 1 — Select List Container**.
3. Expand **About** at the bottom. You should see:
   - Version: `v1.1.0` or higher
   - Distribution: `GitHub (unpacked)`
   - Last checked: `just now` or a recent timestamp

## Recording your install path

Open the popup → expand **About** → paste the full path to your extension folder into the **Install path** field. Hit Enter or click outside.

This is **optional but strongly recommended.** The path is stored locally only (`chrome.storage.local.ule_install_path_hint`) — it's never sent anywhere. When a future update arrives, the Update modal will tell you exactly which folder to replace, removing the most common mistake (replacing the wrong folder).

## What to do when an update is published

See [UPDATE.md](UPDATE.md).

## Troubleshooting

- **"Manifest is missing or unreadable"** — make sure you selected the folder that *contains* `manifest.json`, not its parent.
- **Icon not showing in toolbar** — click the puzzle-piece icon in Chrome's toolbar and pin Ultimate List Extractor.
- **Extension shows "Errors" button** — click it to see the error. Most often this means a syntax-broken manifest or a missing file. Reinstall the latest release.
- **Multiple Chrome profiles** — install the extension separately in each profile, OR point all profiles at the same folder. If you go the shared-folder route, see the cross-profile section in [UPDATE.md](UPDATE.md).
- **"Couldn't reach GitHub"** in the About panel — the GitHub Releases API is unreachable. Check Wi-Fi; corporate VPN/proxy can block API requests. The popup will continue to work; you just won't see new-version notifications until connectivity returns.
