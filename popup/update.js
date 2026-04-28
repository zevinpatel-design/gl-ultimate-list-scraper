// update.js — GitHub Releases-driven update detection and apply flow.
// Runs in popup context. Mirror of the same logic runs in the service worker for periodic checks.
// Storage keys are namespaced ule_* and used by both popup.js and background.js.

(function (root) {
  'use strict';

  const OWNER = 'zevinpatel-design';
  const REPO = 'gl-ultimate-list-scraper';
  const RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
  const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
  const ASSET_NAME_PATTERN = /^ultimate-scraper-v\d+\.\d+\.\d+\.zip$/;
  const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
  const LOG_RING_SIZE = 20;

  // ─── Version comparison ──────────────────────────────────────────────

  function compareVersions(a, b) {
    const pa = String(a || '').replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const ai = pa[i] || 0;
      const bi = pb[i] || 0;
      if (ai > bi) return 1;
      if (ai < bi) return -1;
    }
    return 0;
  }

  // ─── Build channel detection ─────────────────────────────────────────
  // Web Store-installed extensions populate update_url automatically. Unpacked / GitHub-distributed
  // builds omit it. This is the signal — no `management` permission required.

  function isWebStoreInstall() {
    try {
      return Boolean(chrome.runtime.getManifest().update_url);
    } catch (_) {
      return false;
    }
  }

  // ─── Update log (rotating ring buffer in chrome.storage.local) ───────

  async function appendLog(entry) {
    try {
      const { ule_update_log = [] } = await chrome.storage.local.get('ule_update_log');
      const next = ule_update_log.concat([{ at: Date.now(), ...entry }]).slice(-LOG_RING_SIZE);
      await chrome.storage.local.set({ ule_update_log: next });
    } catch (_) { /* swallow */ }
  }

  // ─── Release lookup ──────────────────────────────────────────────────

  function parseReleaseBody(body) {
    if (!body) return { sha256: null, changelog: '' };
    const m = body.match(/SHA256:\s*([a-fA-F0-9]{64})/);
    const sha256 = m ? m[1].toLowerCase() : null;
    const stripped = body.replace(/SHA256:\s*[a-fA-F0-9]{64}\s*/g, '').trim();
    return { sha256, changelog: stripped };
  }

  async function fetchLatestRelease() {
    const resp = await fetch(RELEASES_URL, {
      headers: { 'Accept': 'application/vnd.github+json' },
      cache: 'no-store',
    });

    if (resp.status === 403) {
      const reset = resp.headers.get('X-RateLimit-Reset');
      const err = new Error('rate_limited');
      err.code = 'rate_limited';
      err.resetAt = reset ? parseInt(reset, 10) * 1000 : null;
      throw err;
    }
    if (resp.status === 404) {
      const err = new Error('no_releases');
      err.code = 'no_releases';
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`github_${resp.status}`);
      err.code = 'github_error';
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    const asset = (data.assets || []).find(a => ASSET_NAME_PATTERN.test(a.name));
    if (!asset) {
      const err = new Error('no_asset');
      err.code = 'no_asset';
      throw err;
    }

    const { sha256, changelog } = parseReleaseBody(data.body);
    return {
      latestVersion: String(data.tag_name || '').replace(/^v/, ''),
      tagName: data.tag_name,
      downloadUrl: asset.browser_download_url,
      assetName: asset.name,
      assetSize: asset.size,
      sha256,
      changelog,
      releaseNotesUrl: data.html_url,
      publishedAt: data.published_at,
    };
  }

  // ─── Public: checkForUpdates ─────────────────────────────────────────

  async function checkForUpdates(opts) {
    const { silent = false, force = false } = opts || {};
    const current = chrome.runtime.getManifest().version;

    if (isWebStoreInstall()) {
      return { status: 'webstore', current };
    }

    if (!force) {
      const { ule_update_check } = await chrome.storage.local.get('ule_update_check');
      if (ule_update_check && (Date.now() - ule_update_check.checkedAt) < CACHE_TTL_MS) {
        const cmp = compareVersions(ule_update_check.latestVersion, current);
        return {
          status: cmp > 0 ? 'available' : 'up-to-date',
          current,
          latest: ule_update_check.latestVersion,
          downloadUrl: ule_update_check.downloadUrl,
          sha256: ule_update_check.sha256,
          changelog: ule_update_check.changelog,
          releaseNotesUrl: ule_update_check.releaseNotesUrl,
          checkedAt: ule_update_check.checkedAt,
          cached: true,
        };
      }
    }

    try {
      const release = await fetchLatestRelease();
      const record = { ...release, checkedAt: Date.now() };
      await chrome.storage.local.set({ ule_update_check: record });

      const cmp = compareVersions(release.latestVersion, current);
      const status = cmp > 0 ? 'available' : 'up-to-date';
      await appendLog({ action: 'check', ok: true, status, latest: release.latestVersion, current });

      return {
        status,
        current,
        latest: release.latestVersion,
        downloadUrl: release.downloadUrl,
        sha256: release.sha256,
        changelog: release.changelog,
        releaseNotesUrl: release.releaseNotesUrl,
        checkedAt: record.checkedAt,
        cached: false,
      };
    } catch (err) {
      await appendLog({ action: 'check', ok: false, errorCode: err.code || 'unknown', message: err.message });
      const { ule_update_check } = await chrome.storage.local.get('ule_update_check');
      return {
        status: 'error',
        errorCode: err.code || 'unknown',
        errorMessage: err.message,
        current,
        cached: ule_update_check || null,
      };
    }
  }

  // ─── SHA-256 helper ──────────────────────────────────────────────────

  async function sha256Hex(arrayBuffer) {
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ─── Public: downloadAndVerify ───────────────────────────────────────

  async function downloadAndVerify(release) {
    if (!release || !release.downloadUrl) {
      throw Object.assign(new Error('missing_download_url'), { code: 'missing_download_url' });
    }

    const resp = await fetch(release.downloadUrl, { cache: 'no-store' });
    if (!resp.ok) {
      throw Object.assign(new Error(`download_${resp.status}`), { code: 'download_failed', status: resp.status });
    }
    const buf = await resp.arrayBuffer();

    if (release.sha256) {
      const actual = await sha256Hex(buf);
      if (actual !== release.sha256.toLowerCase()) {
        await appendLog({
          action: 'download',
          ok: false,
          errorCode: 'integrity_check_failed',
          expected: release.sha256,
          actual,
        });
        throw Object.assign(new Error('integrity_check_failed'), {
          code: 'integrity_check_failed',
          expected: release.sha256,
          actual,
        });
      }
    }

    const blob = new Blob([buf], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);

    const downloadId = await chrome.downloads.download({
      url,
      filename: 'ultimate-scraper-update.zip',
      conflictAction: 'overwrite',
      saveAs: false,
    });

    await chrome.storage.local.set({
      ule_update_session: {
        stage: 'downloading',
        downloadId,
        expectedVersion: release.latestVersion || release.tagName,
        startedAt: Date.now(),
      },
    });

    await appendLog({ action: 'download', ok: true, version: release.latestVersion, downloadId });
    return { downloadId, blobUrl: url };
  }

  function waitForDownloadComplete(downloadId, timeoutMs = 5 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(handler);
        reject(Object.assign(new Error('download_timeout'), { code: 'download_timeout' }));
      }, timeoutMs);

      function handler(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === 'complete') {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(handler);
          resolve();
        }
        if (delta.state && delta.state.current === 'interrupted') {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(handler);
          reject(Object.assign(new Error('download_interrupted'), {
            code: 'download_interrupted',
            reason: delta.error && delta.error.current,
          }));
        }
      }

      chrome.downloads.onChanged.addListener(handler);
      chrome.downloads.search({ id: downloadId }, (items) => {
        if (items && items[0] && items[0].state === 'complete') {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(handler);
          resolve();
        }
      });
    });
  }

  // ─── Public: applyUpdate ─────────────────────────────────────────────

  async function applyUpdate(expectedVersion) {
    await chrome.storage.local.set({
      ule_pending_apply: {
        expectedVersion,
        attemptedAt: Date.now(),
        fromVersion: chrome.runtime.getManifest().version,
      },
      ule_update_session: { stage: 'applying', expectedVersion },
    });
    await appendLog({ action: 'apply_start', expectedVersion });
    chrome.runtime.reload();
  }

  // ─── Public: resumeSession ───────────────────────────────────────────

  async function resumeSession() {
    const { ule_update_session } = await chrome.storage.local.get('ule_update_session');
    return ule_update_session || null;
  }

  // ─── Public: clearSession ────────────────────────────────────────────

  async function clearSession() {
    await chrome.storage.local.remove('ule_update_session');
  }

  // ─── Cross-profile drift ─────────────────────────────────────────────

  async function checkCrossProfileDrift() {
    const current = chrome.runtime.getManifest().version;
    try {
      const { ule_apply_completed_at, ule_apply_completed_version } =
        await chrome.storage.sync.get(['ule_apply_completed_at', 'ule_apply_completed_version']);
      if (!ule_apply_completed_at || !ule_apply_completed_version) return null;
      if (compareVersions(ule_apply_completed_version, current) > 0) {
        return {
          siblingProfileVersion: ule_apply_completed_version,
          siblingAppliedAt: ule_apply_completed_at,
          thisProfileVersion: current,
        };
      }
    } catch (_) { /* sync may be unavailable */ }
    return null;
  }

  // ─── Exports ─────────────────────────────────────────────────────────

  const api = {
    OWNER, REPO, REPO_URL,
    compareVersions,
    isWebStoreInstall,
    checkForUpdates,
    downloadAndVerify,
    waitForDownloadComplete,
    applyUpdate,
    resumeSession,
    clearSession,
    checkCrossProfileDrift,
    appendLog,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ULEUpdate = api;
  }
})(typeof self !== 'undefined' ? self : this);
