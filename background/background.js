// Background service worker — extension lifecycle, periodic update checks, post-reload verdict.
//
// IMPORTANT: this file's TOP-LEVEL code runs on every service-worker boot, including the
// boot triggered by chrome.runtime.reload() during the update apply. So this is the only
// surface where we can confirm whether the user actually replaced the files on disk.

importScripts('../popup/update.js');

const ALARM_NAME = 'ule-update-check';
const ALARM_PERIOD_MIN = 240;

// ─── Post-reload apply verdict ───────────────────────────────────────────
// Runs every SW boot. If the previous popup-driven flow set ule_pending_apply,
// compare the running manifest version to the expected version. Record the outcome,
// surface a "just updated" toast key for the popup, and write the cross-profile
// completion timestamp into chrome.storage.sync so other Chrome profiles can detect
// that this profile picked up new files.

(async function evaluatePendingApply() {
  try {
    const { ule_pending_apply } = await chrome.storage.local.get('ule_pending_apply');
    if (!ule_pending_apply) return;

    const expected = String(ule_pending_apply.expectedVersion || '').replace(/^v/, '');
    const actual = chrome.runtime.getManifest().version;
    const fromVersion = ule_pending_apply.fromVersion || null;
    const at = Date.now();

    if (expected && expected === actual) {
      await chrome.storage.local.set({
        ule_last_update_outcome: { ok: true, fromVersion, toVersion: actual, at, errorCode: null },
        ule_just_updated: { previousVersion: fromVersion, currentVersion: actual, at },
      });
      try {
        await chrome.storage.sync.set({
          ule_apply_completed_at: at,
          ule_apply_completed_version: actual,
        });
      } catch (_) { /* sync may be unavailable */ }
      await ULEUpdate.appendLog({ action: 'apply_ok', ok: true, fromVersion, toVersion: actual });
      // Clear the cached "update available" record so the pill doesn't immediately reappear.
      await chrome.storage.local.remove('ule_update_check');
    } else {
      await chrome.storage.local.set({
        ule_last_update_outcome: {
          ok: false,
          fromVersion,
          toVersion: actual,
          at,
          errorCode: 'replace_didnt_take',
          expected,
        },
      });
      await ULEUpdate.appendLog({
        action: 'apply_failed',
        ok: false,
        errorCode: 'replace_didnt_take',
        expected,
        actual,
      });
    }

    await chrome.storage.local.remove(['ule_pending_apply', 'ule_update_session']);
  } catch (err) {
    // Never let a boot-time error wedge the worker.
    console.error('evaluatePendingApply error:', err);
  }
})();

// ─── Periodic update check ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Ultimate List Extractor installed.');
  } else if (details.reason === 'update') {
    // The chrome runtime fires this on every reload too, not just true updates.
    // The post-reload verdict above is the source of truth for our flow.
  }
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN, when: Date.now() + 60_000 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN, when: Date.now() + 60_000 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    await ULEUpdate.checkForUpdates({ silent: true, force: true });
  } catch (err) {
    console.warn('Background update check failed:', err);
  }
});

// ─── Message relay (legacy compatibility) ────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content-to-popup messages reach the popup directly via chrome.runtime.onMessage.
  // No forwarding needed; this listener is kept as a no-op extension point.
  return true;
});
