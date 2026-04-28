# Update Guide

## How updates work

The extension checks GitHub for new releases:
- On every popup open (cached for 4 hours)
- Every 4 hours in the background (via a Chrome alarm)
- Manually any time, via the **Check for Updates** button in the About panel

When a newer release exists, a small **Update vX.Y.Z** pill appears in the popup header. Click it to start the 3-step flow.

## The three steps

### Step A — Download

The extension fetches the new ZIP from GitHub, computes a SHA-256 hash of the bytes, and compares it to the hash published in the release notes. If they don't match, the update is aborted (no file is saved). If they match, the ZIP is saved to your **Downloads** folder as `ultimate-scraper-update.zip`.

You'll see "Downloaded and verified." when this succeeds.

### Step B — Replace files

This is the only step that requires manual action — Chrome cannot replace the unpacked extension folder on disk for you (browser security model).

The modal will detect your platform (Windows or macOS) and show a copy-pastable snippet you can run, plus a plain-language alternative.

#### Windows — File Explorer way

1. Open File Explorer → `Downloads`.
2. Right-click `ultimate-scraper-update.zip` → **Extract All…** → choose a temporary location (the default is fine).
3. Open the extracted folder. Press `Ctrl+A` to select all files inside.
4. Cut (`Ctrl+X`) → navigate to your extension folder (the path you saved in About) → paste (`Ctrl+V`).
5. When prompted "Replace or Skip Files," choose **Replace the files in the destination**.

#### Windows — PowerShell snippet

The modal copies this for you. Replace `<your path>` with the path you saved in About:

```powershell
Expand-Archive -Force "$HOME\Downloads\ultimate-scraper-update.zip" "$HOME\Downloads\ule-update"
Copy-Item -Recurse -Force "$HOME\Downloads\ule-update\*" "<your path>"
```

#### macOS — Finder way

1. Open Finder → `Downloads`.
2. Double-click `ultimate-scraper-update.zip` to extract. A folder appears next to the ZIP.
3. Open the extracted folder. Press `Cmd+A` to select all files inside.
4. Drag them onto your extension folder. Hold `Option` while releasing to **Replace** existing files.

#### macOS — Terminal snippet

The modal copies this for you. Replace `<your path>` with the path you saved in About:

```bash
unzip -o ~/Downloads/ultimate-scraper-update.zip -d ~/Downloads/ule-update && rsync -a ~/Downloads/ule-update/ "<your path>/"
```

### Step C — Apply

Once the files are replaced, click **Apply Update** in the modal.

What happens behind the scenes:
1. The extension writes a `ule_pending_apply` sentinel to `chrome.storage.local` recording the version it expects after reload.
2. It calls `chrome.runtime.reload()`. The popup closes; the extension restarts on the new files.
3. The new service worker boots and reads the sentinel. If `chrome.runtime.getManifest().version` matches the expected version, you successfully replaced the files. The next popup open shows a green **"Updated to vX.Y.Z ✓"** toast.
4. If the version doesn't match (you forgot to replace, or replaced the wrong folder), you'll see a **"Replace didn't take"** alert at the next popup open. Repeat Step B and try again.

## Multi-Chrome-profile users

If you have several Chrome profiles (e.g. personal + work) all pointing at the same unpacked extension folder, only the profile in which you clicked **Apply** will reload immediately. Other profiles will continue running the old code in memory until you reload them.

The extension detects this. After a sibling profile applies an update, switching to a stale profile shows a **"Files updated by another Chrome profile — please reload this profile's extension at chrome://extensions"** alert. Visit `chrome://extensions/`, find the extension, click the circular reload icon, and you're back in sync.

The cross-profile signal uses `chrome.storage.sync` (your Google account), so it works as long as Chrome Sync is enabled in both profiles.

## What if the update flow itself fails?

The flow is conservative — it never overwrites anything other than the downloaded ZIP. Possible failure modes:

| Symptom | Cause | Fix |
|---|---|---|
| Pill doesn't appear despite a new release | 4-hour cache hasn't expired, or GitHub is unreachable | Open About → click **Check for Updates** |
| "Integrity check failed" | The downloaded ZIP didn't match the published SHA-256 | Try again; if it persists, the release on GitHub may be partial — check the release page |
| "Update is being prepared" | The release was created without a ZIP asset attached | Wait for CI to finish (usually <1 minute); refresh check |
| "Couldn't reach GitHub" | Network offline, VPN blocking `api.github.com`, or rate limit (60 req/hr/IP) | Wait, then retry. The cached check from earlier is still shown |
| "Download interrupted" | Network blip mid-download | Retry from Step A |

## Sharing logs with ZP

Open the extension popup → expand **About** → the **Recent activity** list shows the last 5 update events from `chrome.storage.local.ule_update_log` (a 20-entry rolling buffer).

For deeper debugging, open `chrome://extensions/`, click the extension's **Service worker** link to open DevTools, then run in the console:

```javascript
chrome.storage.local.get(null).then(s => copy(JSON.stringify(s, null, 2)))
```

This copies all extension storage to your clipboard. Paste it to ZP for inspection. (The data only contains version history, install path you set, and your extracted-list captures — no credentials or PII from sites you visit.)

## When the extension finally goes to the Chrome Web Store (v1.3.0)

You'll receive a one-time install link. Install it from the Web Store. From that point onward:
- Auto-updates are silent and immediate (no replace step, no clicks needed).
- The in-extension update pill self-disables.
- The About panel switches **Distribution** to "Chrome Web Store (auto-updates)".
- Your previous extracted lists and settings carry over (the `key` field in the manifest locks the extension ID across the unpacked → Web Store transition).
