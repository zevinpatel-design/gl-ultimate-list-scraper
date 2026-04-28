// Popup controller — uses chrome.storage to persist state across popup open/close cycles.
// The popup closes whenever the user clicks on the page, so all state must survive that.

const $ = (sel) => document.querySelector(sel);

let capturedData = null;

// ─── Helpers ───────────────────────────────────────────────────────────────

function showStep(stepId) {
  document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
  $(stepId).classList.remove('hidden');
}

function getActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]);
}

async function sendToContent(action, data = {}) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, { action, ...data });
}

function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.round(diff / 60_000) + ' min ago';
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + ' hr ago';
  return Math.round(diff / 86_400_000) + ' d ago';
}

function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

// Build a child element with given tag, classes, and text content. Safe — no innerHTML.
function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.cls) node.className = opts.cls;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// Set text on an element by selector. Safe replacement for innerHTML when only text is needed.
function setText(sel, text) {
  const node = $(sel);
  if (node) node.textContent = text;
}

// ─── State Restoration (runs every time popup opens) ─────────────────────

async function restoreState() {
  try {
    const stored = await chrome.storage.local.get([
      'ule_selected', 'ule_data', 'ule_scrolling', 'ule_selecting'
    ]);

    const selection = stored.ule_selected;
    const data = stored.ule_data;
    const scrolling = stored.ule_scrolling;

    if (data && data.rows && data.rows.length > 0) {
      capturedData = data;
      if (selection) {
        $('#selected-element').textContent = selection;
        $('#selected-info').classList.remove('hidden');
        setSelectButtonLabel('Re-select');
      }
      showStep('#step-select');
      $('#step-scroll').classList.remove('hidden');
      $('#step-export').classList.remove('hidden');
      $('#item-count').textContent = data.rows.length;
      $('#scroll-status').textContent = `Done! ${data.rows.length} items captured.`;
      $('#btn-reset').classList.remove('hidden');
      renderPreview(data);
      return;
    }

    if (selection) {
      $('#selected-element').textContent = selection;
      $('#selected-info').classList.remove('hidden');
      setSelectButtonLabel('Re-select');
      showStep('#step-select');
      $('#step-scroll').classList.remove('hidden');

      if (scrolling) {
        $('#btn-scroll').classList.add('hidden');
        $('#btn-stop').classList.remove('hidden');
        $('#scroll-progress').classList.remove('hidden');
        $('#scroll-status').textContent = 'Scrolling… (reopen to check progress)';
      }
      return;
    }
  } catch (err) {
    console.error('State restore error:', err);
  }
}

// Replace the select button's contents with an icon + text label, no innerHTML.
function setSelectButtonLabel(text) {
  const btn = $('#btn-select');
  btn.replaceChildren(
    el('span', { cls: 'btn-icon', text: '◎' }),
    document.createTextNode(' ' + text)
  );
}

restoreState();

// ─── About panel + update flow init ──────────────────────────────────────

async function initAbout() {
  const m = chrome.runtime.getManifest();
  $('#about-version').textContent = 'v' + m.version;
  $('#repo-link').href = ULEUpdate.REPO_URL;
  $('#about-channel').textContent = ULEUpdate.isWebStoreInstall()
    ? 'Chrome Web Store (auto-updates)'
    : 'GitHub (unpacked)';

  const { ule_install_path_hint } = await chrome.storage.local.get('ule_install_path_hint');
  if (ule_install_path_hint) $('#install-path-input').value = ule_install_path_hint;

  $('#install-path-input').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ ule_install_path_hint: e.target.value.trim() });
  });

  $('#btn-check-now').addEventListener('click', async () => {
    $('#btn-check-now').disabled = true;
    $('#btn-check-now').textContent = 'Checking…';
    const result = await ULEUpdate.checkForUpdates({ force: true });
    await renderUpdateState(result);
    $('#btn-check-now').disabled = false;
    $('#btn-check-now').textContent = 'Check for Updates';
  });

  await renderUpdateLog();
}

async function renderUpdateLog() {
  const { ule_update_log = [] } = await chrome.storage.local.get('ule_update_log');
  const recent = ule_update_log.slice(-5).reverse();
  const list = $('#about-log-list');
  list.replaceChildren();
  if (recent.length === 0) {
    $('#about-recent').classList.add('hidden');
    return;
  }
  $('#about-recent').classList.remove('hidden');
  for (const entry of recent) {
    const time = relativeTime(entry.at);
    const okMark = entry.ok === false ? '✗' : (entry.ok === true ? '✓' : '·');
    const detail = entry.errorCode
      ? entry.errorCode
      : entry.action + (entry.latest ? ' v' + entry.latest : '') + (entry.version ? ' v' + entry.version : '');
    list.appendChild(el('li', { text: `${okMark} ${detail} — ${time}` }));
  }
}

async function renderUpdateState(result) {
  if (!result) return;

  if (result.checkedAt) {
    $('#about-checked').textContent = relativeTime(result.checkedAt);
  }

  if (result.status === 'webstore') {
    $('#update-pill').classList.add('hidden');
    return;
  }

  if (result.status === 'available') {
    $('#update-pill').classList.remove('hidden');
    $('#update-pill-version').textContent = 'v' + result.latest;
  } else {
    $('#update-pill').classList.add('hidden');
  }

  if (result.status === 'error') {
    const map = {
      rate_limited: 'GitHub rate limit hit. Retry later.',
      no_releases: 'No releases published yet.',
      no_asset: 'Update is being prepared — try again in a few minutes.',
      github_error: 'GitHub responded with an error.',
    };
    const msg = map[result.errorCode] || ('Couldn’t reach GitHub: ' + (result.errorMessage || 'unknown'));
    $('#about-checked').textContent = msg;
  }

  await renderUpdateLog();
}

async function checkApplyOutcome() {
  const { ule_last_update_outcome, ule_just_updated } =
    await chrome.storage.local.get(['ule_last_update_outcome', 'ule_just_updated']);

  if (ule_just_updated && ule_just_updated.currentVersion) {
    $('#updated-toast-version').textContent = ule_just_updated.currentVersion;
    $('#updated-toast').classList.remove('hidden');
    await chrome.storage.local.remove('ule_just_updated');
    $('#updated-toast-close').addEventListener('click', () => {
      $('#updated-toast').classList.add('hidden');
    });
  }

  if (ule_last_update_outcome && ule_last_update_outcome.ok === false) {
    $('#apply-failed').classList.remove('hidden');
    $('#apply-failed-dismiss').addEventListener('click', async () => {
      $('#apply-failed').classList.add('hidden');
      await chrome.storage.local.remove('ule_last_update_outcome');
    });
  }
}

async function checkProfileDrift() {
  const drift = await ULEUpdate.checkCrossProfileDrift();
  if (drift) {
    $('#profile-drift').classList.remove('hidden');
    $('#profile-drift-dismiss').addEventListener('click', () => {
      $('#profile-drift').classList.add('hidden');
    });
  }
}

// ─── Update modal wiring ─────────────────────────────────────────────────

function modalSetStep(letter) {
  ['A', 'B', 'C'].forEach((L) => {
    const node = document.getElementById('modal-step-' + L);
    if (!node) return;
    node.classList.remove('active');
    if (L === letter) node.classList.add('active');
    if (['A', 'B', 'C'].indexOf(L) < ['A', 'B', 'C'].indexOf(letter)) {
      node.classList.add('complete');
    } else {
      node.classList.remove('complete');
    }
  });
}

function modalShowError(message) {
  const e = $('#modal-error');
  e.textContent = message;
  e.classList.remove('hidden');
}

function modalClearError() {
  $('#modal-error').classList.add('hidden');
}

// Build the platform-specific help block using safe DOM construction (no innerHTML).
function renderPlatformHelp(platform) {
  const help = $('#modal-platform-help');
  help.replaceChildren();

  const tag = (label) => el('div', { cls: 'platform-tag', text: label });
  const para = (text) => el('p', { text });
  const pre = (text) => el('pre', { cls: 'snippet', text });

  if (platform === 'windows') {
    help.append(
      tag('Windows'),
      para('Right-click the ZIP → Extract All. Copy everything inside the extracted folder over your existing extension folder, allowing replacement.'),
      para('Or paste this into PowerShell (replace <your path>):'),
      pre('Expand-Archive -Force "$HOME\\Downloads\\ultimate-scraper-update.zip" "$HOME\\Downloads\\ule-update"; Copy-Item -Recurse -Force "$HOME\\Downloads\\ule-update\\*" "<your path>"')
    );
  } else if (platform === 'mac') {
    help.append(
      tag('macOS'),
      para('Double-click the ZIP to extract. Copy everything inside the extracted folder over your existing extension folder, allowing replacement.'),
      para('Or paste this into Terminal (replace <your path>):'),
      pre('unzip -o ~/Downloads/ultimate-scraper-update.zip -d ~/Downloads/ule-update && rsync -a ~/Downloads/ule-update/ "<your path>/"')
    );
  } else {
    help.append(
      tag('Linux / other'),
      para('Extract the ZIP and copy its contents over your existing extension folder.')
    );
  }
}

async function openUpdateModal() {
  modalClearError();
  const { ule_update_check } = await chrome.storage.local.get('ule_update_check');
  if (!ule_update_check || !ule_update_check.latestVersion) {
    modalShowError('No update info available. Try Check for Updates first.');
    $('#update-modal').classList.remove('hidden');
    return;
  }
  $('#modal-version').textContent = ule_update_check.latestVersion;

  const { ule_install_path_hint } = await chrome.storage.local.get('ule_install_path_hint');
  if (ule_install_path_hint) {
    $('#modal-path-display').textContent = ule_install_path_hint;
    $('#modal-path-row').classList.remove('hidden');
  }

  renderPlatformHelp(detectPlatform());

  modalSetStep('A');
  $('#btn-download-update').disabled = false;
  $('#btn-download-update').textContent = 'Download Update';
  $('#modal-download-status').textContent = 'Ready to download.';
  $('#modal-download-progress').classList.add('hidden');

  $('#update-modal').classList.remove('hidden');
}

function closeUpdateModal() {
  $('#update-modal').classList.add('hidden');
}

async function startDownload() {
  modalClearError();
  const { ule_update_check } = await chrome.storage.local.get('ule_update_check');
  if (!ule_update_check) {
    modalShowError('No update info to download.');
    return;
  }

  $('#btn-download-update').disabled = true;
  $('#btn-download-update').textContent = 'Downloading…';
  $('#modal-download-status').textContent = 'Fetching ZIP and verifying integrity…';
  $('#modal-download-progress').classList.remove('hidden');
  $('#modal-download-fill').style.width = '40%';

  try {
    const { downloadId } = await ULEUpdate.downloadAndVerify(ule_update_check);
    $('#modal-download-fill').style.width = '70%';
    $('#modal-download-status').textContent = 'Saving to Downloads folder…';
    await ULEUpdate.waitForDownloadComplete(downloadId);
    $('#modal-download-fill').style.width = '100%';
    $('#modal-download-status').textContent = 'Downloaded and verified.';
    await chrome.storage.local.set({
      ule_update_session: { stage: 'awaiting_apply', expectedVersion: ule_update_check.latestVersion },
    });
    modalSetStep('B');
  } catch (err) {
    const codeMessages = {
      integrity_check_failed: 'Integrity check failed. The downloaded file did not match the expected SHA256. Update aborted for safety.',
      download_failed: 'Download failed: GitHub returned an error.',
      download_interrupted: 'Download was interrupted. Try again.',
      download_timeout: 'Download timed out. Try again.',
      missing_download_url: 'No download URL in the release. Check that the release has a ZIP asset attached.',
    };
    modalShowError(codeMessages[err.code] || ('Download error: ' + err.message));
    $('#btn-download-update').disabled = false;
    $('#btn-download-update').textContent = 'Retry Download';
    $('#modal-download-status').textContent = 'Failed.';
    $('#modal-download-fill').style.width = '0%';
  }
}

async function applyNow() {
  modalClearError();
  const { ule_update_check } = await chrome.storage.local.get('ule_update_check');
  if (!ule_update_check) {
    modalShowError('No update info available.');
    return;
  }
  $('#btn-apply-update').disabled = true;
  $('#btn-apply-update').textContent = 'Reloading…';
  await ULEUpdate.applyUpdate(ule_update_check.latestVersion);
}

async function resumeIfInProgress() {
  const session = await ULEUpdate.resumeSession();
  if (!session) return;

  if (session.stage === 'downloading' && session.downloadId != null) {
    $('#update-modal').classList.remove('hidden');
    modalSetStep('A');
    $('#modal-download-progress').classList.remove('hidden');
    $('#modal-download-fill').style.width = '50%';
    $('#modal-download-status').textContent = 'Resuming download…';
    try {
      await ULEUpdate.waitForDownloadComplete(session.downloadId);
      $('#modal-download-fill').style.width = '100%';
      $('#modal-download-status').textContent = 'Downloaded and verified.';
      await chrome.storage.local.set({
        ule_update_session: { stage: 'awaiting_apply', expectedVersion: session.expectedVersion },
      });
      modalSetStep('B');
    } catch (_) {
      $('#modal-download-status').textContent = 'Download did not complete. Try again.';
      $('#btn-download-update').disabled = false;
    }
    return;
  }

  if (session.stage === 'awaiting_apply') {
    $('#update-modal').classList.remove('hidden');
    modalSetStep('B');
    const { ule_update_check } = await chrome.storage.local.get('ule_update_check');
    if (ule_update_check) $('#modal-version').textContent = ule_update_check.latestVersion;
  }
}

// ─── Wire up everything ──────────────────────────────────────────────────

(async function initUpdateUI() {
  await initAbout();
  await checkApplyOutcome();
  await checkProfileDrift();

  const cached = await ULEUpdate.checkForUpdates({ silent: true });
  await renderUpdateState(cached);

  $('#update-pill').addEventListener('click', openUpdateModal);
  $('#modal-close').addEventListener('click', closeUpdateModal);
  $('#btn-download-update').addEventListener('click', startDownload);
  $('#btn-apply-update').addEventListener('click', applyNow);

  await resumeIfInProgress();
})();

// ─── Step 1: Select ───────────────────────────────────────────────────────

$('#btn-select').addEventListener('click', async () => {
  $('#btn-select').textContent = 'Click an element on the page…';
  $('#btn-select').disabled = true;

  try {
    await sendToContent('startSelection');
    window.close();
  } catch (err) {
    console.error('Selection error:', err);
    setSelectButtonLabel('Select Area');
    $('#btn-select').disabled = false;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'elementSelected') {
    $('#selected-element').textContent = msg.selector;
    $('#selected-info').classList.remove('hidden');
    $('#step-scroll').classList.remove('hidden');
    setSelectButtonLabel('Re-select');
    $('#btn-select').disabled = false;
    sendResponse({ received: true });
  }

  if (msg.action === 'scrollProgress') {
    $('#scroll-progress').classList.remove('hidden');
    $('#scroll-progress-fill').style.width = msg.percent + '%';
    $('#scroll-status').textContent = msg.message;
  }

  if (msg.action === 'scrollComplete') {
    capturedData = msg.data;
    $('#btn-scroll').classList.remove('hidden');
    $('#btn-stop').classList.add('hidden');
    $('#scroll-status').textContent = `Done! ${msg.data.rows.length} items captured.`;

    $('#step-export').classList.remove('hidden');
    $('#item-count').textContent = msg.data.rows.length;
    $('#btn-reset').classList.remove('hidden');

    renderPreview(msg.data);
  }

  return true;
});

// ─── Step 2: Scroll ───────────────────────────────────────────────────────

$('#btn-scroll').addEventListener('click', async () => {
  const speed = $('#scroll-speed').value;
  $('#btn-scroll').classList.add('hidden');
  $('#btn-stop').classList.remove('hidden');
  $('#scroll-progress').classList.remove('hidden');
  $('#scroll-progress-fill').style.width = '0%';
  $('#scroll-status').textContent = 'Scrolling…';

  try {
    await sendToContent('startScroll', { speed });
  } catch (err) {
    console.error('Scroll error:', err);
    $('#btn-scroll').classList.remove('hidden');
    $('#btn-stop').classList.add('hidden');
    $('#scroll-status').textContent = 'Error starting scroll.';
  }
});

$('#btn-stop').addEventListener('click', async () => {
  await sendToContent('stopScroll');
  $('#btn-scroll').classList.remove('hidden');
  $('#btn-stop').classList.add('hidden');
  $('#scroll-status').textContent = 'Stopped by user.';
});

// ─── Step 3: Export ───────────────────────────────────────────────────────

$('#btn-csv').addEventListener('click', () => {
  if (!capturedData) return;
  exportCSV(capturedData);
});

$('#btn-xlsx').addEventListener('click', () => {
  if (!capturedData) return;
  exportXLSX(capturedData);
});

$('#btn-pdf').addEventListener('click', () => {
  if (!capturedData) return;
  exportPDF(capturedData);
});

// ─── Preview (rebuilt with safe DOM construction) ────────────────────────

function renderPreview(data) {
  const { headers, rows } = data;
  if (!rows.length) return;

  const head = $('#preview-head');
  head.replaceChildren();
  const headTr = el('tr');
  headers.forEach(h => headTr.appendChild(el('th', { text: h })));
  head.appendChild(headTr);

  const body = $('#preview-body');
  body.replaceChildren();
  rows.slice(0, 20).forEach(row => {
    const tr = el('tr');
    headers.forEach(h => tr.appendChild(el('td', { text: row[h] || '' })));
    body.appendChild(tr);
  });

  $('#preview-container').classList.remove('hidden');
}

// ─── Export: CSV ──────────────────────────────────────────────────────────

function exportCSV(data) {
  const { headers, rows } = data;
  const csvLines = [
    headers.map(h => csvEscape(h)).join(','),
    ...rows.map(row => headers.map(h => csvEscape(row[h] || '')).join(','))
  ];
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, 'extracted-list.csv');
}

function csvEscape(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ─── Export: XLSX ─────────────────────────────────────────────────────────

function exportXLSX(data) {
  const { headers, rows } = data;

  const xmlRows = [
    '<Row>' + headers.map(h => `<Cell><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`).join('') + '</Row>',
    ...rows.map(row =>
      '<Row>' + headers.map(h => {
        const val = row[h] || '';
        const type = isNumeric(val) ? 'Number' : 'String';
        return `<Cell><Data ss:Type="${type}">${xmlEscape(val)}</Data></Cell>`;
      }).join('') + '</Row>'
    )
  ];

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#1e293b" ss:Pattern="Solid"/>
   <Font ss:Color="#ffffff"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Extracted Data">
  <Table>
   ${xmlRows[0].replace('<Row>', '<Row ss:StyleID="header">')}
   ${xmlRows.slice(1).join('\n   ')}
  </Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  downloadBlob(blob, 'extracted-list.xls');
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isNumeric(val) {
  return !isNaN(val) && !isNaN(parseFloat(val)) && val.toString().trim() !== '';
}

// ─── Export: PDF ──────────────────────────────────────────────────────────

function exportPDF(data) {
  const { headers, rows } = data;

  const lines = [];
  lines.push(headers.join(' | '));
  lines.push('-'.repeat(Math.min(headers.join(' | ').length, 80)));
  rows.forEach(row => {
    lines.push(headers.map(h => (row[h] || '').substring(0, 40)).join(' | '));
  });

  const textLines = lines;
  const pdf = buildMinimalPDF('Extracted List Data', textLines);
  const blob = new Blob([pdf], { type: 'application/pdf' });
  downloadBlob(blob, 'extracted-list.pdf');
}

function buildMinimalPDF(title, lines) {
  const pageHeight = 792;
  const pageWidth = 612;
  const margin = 50;
  const lineHeight = 12;
  const fontSize = 8;
  const maxLinesPerPage = Math.floor((pageHeight - 2 * margin) / lineHeight);

  const pages = [];
  for (let i = 0; i < lines.length; i += maxLinesPerPage) {
    pages.push(lines.slice(i, i + maxLinesPerPage));
  }

  let objCount = 0;
  const objects = [];
  const offsets = [];

  function addObj(content) {
    objCount++;
    objects.push(content);
    return objCount;
  }

  addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  addObj('');
  addObj('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj');

  const pageObjIds = [];
  pages.forEach((pageLines, idx) => {
    let stream = `BT\n/F1 10 Tf\n${margin} ${pageHeight - margin} Td\n`;
    if (idx === 0) {
      stream += `(${pdfEscape(title)}) Tj\n0 -${lineHeight * 2} Td\n`;
    }
    stream += `/F1 ${fontSize} Tf\n`;
    pageLines.forEach(line => {
      stream += `(${pdfEscape(line.substring(0, 120))}) Tj\n0 -${lineHeight} Td\n`;
    });
    stream += 'ET';

    const streamId = addObj(
      `${objCount + 1} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`
    );

    const pageId = addObj(
      `${objCount + 1} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${streamId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj`
    );
    pageObjIds.push(pageId);
  });

  const kidsStr = pageObjIds.map(id => `${id} 0 R`).join(' ');
  objects[1] = `2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${pageObjIds.length} >>\nendobj`;

  let pdf = '%PDF-1.4\n';
  objects.forEach((obj) => {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  });

  const xrefOffset = pdf.length;
  pdf += 'xref\n';
  pdf += `0 ${objCount + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach(off => {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  });
  pdf += 'trailer\n';
  pdf += `<< /Size ${objCount + 1} /Root 1 0 R >>\n`;
  pdf += 'startxref\n';
  pdf += xrefOffset + '\n';
  pdf += '%%EOF';

  return pdf;
}

function pdfEscape(str) {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// ─── Download helper ──────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: true
  }, () => {
    URL.revokeObjectURL(url);
  });
}

// ─── Reset ────────────────────────────────────────────────────────────────

$('#btn-reset').addEventListener('click', async () => {
  capturedData = null;
  showStep('#step-select');
  $('#step-scroll').classList.add('hidden');
  $('#step-export').classList.add('hidden');
  $('#btn-reset').classList.add('hidden');
  $('#selected-info').classList.add('hidden');
  $('#scroll-progress').classList.add('hidden');
  $('#scroll-status').textContent = '';
  $('#preview-container').classList.add('hidden');
  $('#btn-scroll').classList.remove('hidden');
  $('#btn-stop').classList.add('hidden');
  setSelectButtonLabel('Select Area');

  try {
    await sendToContent('reset');
  } catch (_) {
    await chrome.storage.local.remove([
      'ule_selected', 'ule_data', 'ule_scrolling', 'ule_selecting'
    ]);
  }
});
