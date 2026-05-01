// Content script — handles element selection, human-like scrolling, and data extraction.
// Runs on the actual web page. Persists state to chrome.storage so the popup can
// restore UI after closing/reopening.
//
// v2.0.0 — VDB (React Native Web) compatibility patch
// Ported from ZP WebScraper v11.2.0 patterns:
//   - CSS overflow container detection (works when scrollHeight == clientHeight)
//   - Triple-nudge scroll trigger (scrollTop + WheelEvent + scroll event)
//   - Incremental row capture via captureNewRows() during scroll
//   - Pattern-based field mapping for div[dir="auto"] cells
//   - Deduplication by item ID

(() => {
  'use strict';

  let state = {
    selectionMode: false,
    selectedElement: null,
    scrolling: false,
    hoveredElement: null,
    // VDB incremental capture state
    vdbSeen: new Set(),
    vdbRows: [],
  };

  // ─── Storage helpers ─────────────────────────────────────────────────

  async function saveToStorage(updates) {
    try {
      await chrome.storage.local.set(updates);
    } catch (_) { /* ignore */ }
  }

  async function clearStorage() {
    try {
      await chrome.storage.local.remove([
        'ule_selected', 'ule_scrolling', 'ule_data', 'ule_selecting'
      ]);
    } catch (_) { /* ignore */ }
  }

  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  // ─── VDB Detection ────────────────────────────────────────────────────
  // Returns true if the current page has VDB-style item-detail links
  function isVdbPage() {
    return document.querySelectorAll('a[href*="/item-detail/"]').length > 0;
  }

  // ─── Element Selection ────────────────────────────────────────────────

  function startSelectionMode() {
    state.selectionMode = true;
    document.body.classList.add('ule-selection-mode');
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('mouseout', onHoverOut, true);
    document.addEventListener('click', onSelect, true);
    document.addEventListener('keydown', onEscape, true);
    saveToStorage({ ule_selecting: true });
  }

  function stopSelectionMode() {
    state.selectionMode = false;
    document.body.classList.remove('ule-selection-mode');
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('mouseout', onHoverOut, true);
    document.removeEventListener('click', onSelect, true);
    document.removeEventListener('keydown', onEscape, true);
    clearHighlight();
    saveToStorage({ ule_selecting: false });
  }

  function onHover(e) {
    if (!state.selectionMode) return;
    e.stopPropagation();
    clearHighlight();
    state.hoveredElement = e.target;
    e.target.classList.add('ule-highlight');
  }

  function onHoverOut(e) {
    if (!state.selectionMode) return;
    e.target.classList.remove('ule-highlight');
  }

  function onSelect(e) {
    if (!state.selectionMode) return;
    e.preventDefault();
    e.stopPropagation();

    clearHighlight();
    if (state.selectedElement) {
      state.selectedElement.classList.remove('ule-selected');
    }

    state.selectedElement = e.target;
    const scrollable = findScrollableParent(e.target);
    if (scrollable) {
      state.selectedElement = scrollable;
    }

    state.selectedElement.classList.add('ule-selected');
    stopSelectionMode();

    const selector = describeElement(state.selectedElement);
    saveToStorage({ ule_selected: selector, ule_data: null, ule_scrolling: false });
    safeSend({ action: 'elementSelected', selector });
  }

  function onEscape(e) {
    if (e.key === 'Escape') stopSelectionMode();
  }

  function clearHighlight() {
    document.querySelectorAll('.ule-highlight').forEach(el =>
      el.classList.remove('ule-highlight')
    );
  }

  // ─── Scrollable Container Detection (v2.0 — VDB-aware) ────────────────
  //
  // FIX 1: CSS overflow detection for React Native Web virtualized lists.
  // RN-Web sets overflow-y: auto|scroll on its ScrollView container div
  // EVEN when scrollHeight == clientHeight (virtualizer manages content).
  // The old code required scrollHeight > clientHeight, which always fails
  // on virtualized lists that only render ~60 rows at a time.

  function findScrollableParent(el) {
    let current = el;
    for (let i = 0; i < 50 && current; i++) {
      if (isScrollable(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function isScrollable(el) {
    if (!el) return false;
    if (el === document.documentElement || el === document.body) return false;
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const overflowYScrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    // Original check: CSS overflow + actual scroll content
    if (overflowYScrollable && el.scrollHeight > el.clientHeight + 4) return true;
    // VDB FIX: CSS overflow alone is enough for virtualized containers
    // (scrollHeight == clientHeight because only visible rows are in DOM)
    if (overflowYScrollable && el.clientHeight > 100) return true;
    return false;
  }

  // VDB-specific: find scroll container by walking up from item-detail links
  // Uses the CSS overflow + stickiness hybrid from ZP scraper v11.0.2
  function findVdbScrollContainer() {
    const links = document.querySelectorAll('a[href*="/item-detail/"]');
    if (links.length === 0) return null;

    let container = null;
    let el = links[0].parentElement;
    let depth = 0;
    let cssOverflowCandidate = null;

    while (el && el !== document.body && el !== document.documentElement) {
      depth++;

      // PRIMARY: CSS overflow detection
      if (!cssOverflowCandidate && el.clientHeight > 100) {
        try {
          const cs = getComputedStyle(el);
          const oy = cs.overflowY || cs.overflow || '';
          if (oy === 'auto' || oy === 'scroll') {
            cssOverflowCandidate = el;
          }
        } catch (_) {}
      }

      // SECONDARY: stickiness test (scrollTop sticks when scrollHeight > clientHeight)
      if (el.clientHeight > 50) {
        const before = el.scrollTop;
        try { el.scrollTop = 100; } catch (_) {}
        const moved = el.scrollTop > 0;
        try { el.scrollTop = before; } catch (_) {}
        if (moved && el.scrollHeight > el.clientHeight + 10) {
          container = el;
          break;
        }
      }

      el = el.parentElement;
    }

    // Priority: sticky+overflow > CSS overflow (for RN-Web virtualized lists)
    if (!container && cssOverflowCandidate) container = cssOverflowCandidate;

    // Brute-force fallback: largest div with CSS overflow containing item-detail links
    if (!container) {
      let bestEl = null, bestScore = 0;
      for (const div of document.querySelectorAll('div')) {
        if (div.clientHeight < 200 || div.clientWidth < 200) continue;
        try {
          const cs = getComputedStyle(div);
          const oy = cs.overflowY || cs.overflow || '';
          if (oy !== 'auto' && oy !== 'scroll') continue;
        } catch (_) { continue; }
        if (!div.querySelector('a[href*="/item-detail/"]')) continue;
        const score = (div.scrollHeight || div.clientHeight) * (div.clientWidth / Math.max(window.innerWidth, 1));
        if (score > bestScore) { bestScore = score; bestEl = div; }
      }
      if (bestEl) container = bestEl;
    }

    return container;
  }

  // ─── Scroll Context (unchanged from v1 for non-VDB pages) ─────────────

  function findScrollContext(el) {
    if (isScrollable(el)) return makeElementContext(el);
    const parent = findScrollableParent(el);
    if (parent) return makeElementContext(parent);
    if (document.documentElement.scrollHeight > window.innerHeight + 4) {
      return makeWindowContext();
    }
    return makeWindowContext();
  }

  function makeElementContext(el) {
    return {
      kind: 'element',
      el,
      get scrollTop() { return el.scrollTop; },
      get scrollHeight() { return el.scrollHeight; },
      get clientHeight() { return el.clientHeight; },
      scrollBy(dy) { el.scrollBy({ top: dy, behavior: 'auto' }); },
    };
  }

  function makeWindowContext() {
    const docEl = document.documentElement;
    return {
      kind: 'window',
      el: docEl,
      get scrollTop() { return window.scrollY || docEl.scrollTop || document.body.scrollTop || 0; },
      get scrollHeight() {
        return Math.max(docEl.scrollHeight, document.body.scrollHeight,
          docEl.offsetHeight, document.body.offsetHeight, docEl.clientHeight);
      },
      get clientHeight() { return window.innerHeight; },
      scrollBy(dy) { window.scrollBy({ top: dy, behavior: 'auto' }); },
    };
  }

  // ─── Re-acquire selection ─────────────────────────────────────────────

  function reacquireSelection() {
    if (state.selectedElement && document.body.contains(state.selectedElement)) {
      return state.selectedElement;
    }
    return new Promise((resolve) => {
      chrome.storage.local.get('ule_selected').then((stored) => {
        const selector = stored && stored.ule_selected;
        if (!selector) { resolve(null); return; }
        const candidate = querySelectorFromDescription(selector);
        if (candidate) {
          state.selectedElement = candidate;
          resolve(candidate);
        } else {
          resolve(null);
        }
      }).catch(() => resolve(null));
    });
  }

  function querySelectorFromDescription(desc) {
    if (!desc) return null;
    const tryQuery = (sel) => {
      try { return document.querySelector(sel); } catch (_) { return null; }
    };
    let hit = tryQuery(desc);
    if (hit) return hit;
    const parts = desc.split('.');
    while (parts.length > 1) {
      parts.pop();
      hit = tryQuery(parts.join('.'));
      if (hit) return hit;
    }
    const tagOnly = desc.split('#')[0];
    if (tagOnly && tagOnly !== desc) {
      hit = tryQuery(tagOnly);
      if (hit) return hit;
    }
    return null;
  }

  function nextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function describeElement(el) {
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += `#${el.id}`;
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(/\s+/).filter(c => !c.startsWith('ule-')).slice(0, 3);
      if (classes.length) desc += '.' + classes.join('.');
    }
    return desc;
  }

  // ─── FIX 2: Triple-Nudge Scroll for React Native Web ──────────────────
  // From ZP scraper v11.1 — fires three signals so the virtualized list
  // mounts new rows:
  //   1. scrollTop mutation — moves the DOM scroll offset
  //   2. WheelEvent — wakes RN-Web FlatList virtualizer
  //   3. scroll event — wakes onScroll handlers
  function rnWebScrollNudge(el, deltaPx) {
    const before = el.scrollTop;
    const rect = (el === document.documentElement)
      ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      : el.getBoundingClientRect();
    const clientX = rect.left + Math.floor(rect.width / 2);
    const clientY = rect.top + Math.floor(rect.height / 2);

    // 1. Direct scrollTop
    try { el.scrollTop = before + deltaPx; } catch (_) {}

    // 2. WheelEvent — RN-Web FlatList listens to this
    try {
      el.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, composed: true, view: window,
        deltaX: 0, deltaY: deltaPx, deltaZ: 0, deltaMode: 0,
        clientX, clientY, screenX: clientX, screenY: clientY,
        button: 0, buttons: 0
      }));
    } catch (_) {}

    // 3. scroll event
    try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}

    // Fallback: scrollBy if scrollTop didn't move
    if (Math.abs(el.scrollTop - before) < 5) {
      try { el.scrollBy({ top: deltaPx, behavior: 'auto' }); } catch (_) {}
    }

    return Math.abs(el.scrollTop - before) >= 1;
  }

  // ─── FIX 3: VDB Row Capture (pattern-based field mapping) ─────────────
  // From ZP scraper captureNewRows() — reads a[href*="/item-detail/"] rows,
  // extracts text from div[dir="auto"] cells, and maps fields by regex
  // pattern matching instead of class names or position.
  function captureVdbRows() {
    const links = document.querySelectorAll('a[href*="/item-detail/"]');
    let newCount = 0;
    const rowBatch = [];

    for (const link of links) {
      const m = link.href.match(/item-detail\/(\d+)/);
      if (!m || state.vdbSeen.has(m[1])) continue;

      const textDivs = link.querySelectorAll('div[dir="auto"]');
      const vals = [];
      for (const td of textDivs) {
        const t = (td.textContent || '').trim();
        if (t.length > 0 && t.length < 200) vals.push(t);
      }
      if (vals.length < 1) continue;

      const row = { 'Item ID': m[1] };

      // ── Smart field mapping — regex pattern match (from ZP v11.2) ──
      // First pass: definitive patterns
      for (const v of vals) {
        if (/^(Round|Oval|Princess|Cushion|Emerald|Pear|Marquise|Radiant|Asscher|Heart|Trillion|Baguette|Other)$/i.test(v) && !row.Shape)
          row.Shape = v;
        else if (/^(FL|IF|VVS1|VVS2|VS1|VS2|SI1|SI2|I1|I2|I3)$/i.test(v) && !row.Clarity)
          row.Clarity = v;
        else if (/^(IGI|GIA|HRD|GCAL|NO[- ]?CERT|NOT CERTIFI)$/i.test(v) && !row.Lab)
          row.Lab = v;
        else if (/^(CVD|HPHT|Others?)$/i.test(v) && !row['Growth Type'])
          row['Growth Type'] = v;
        else if (/^(Excellent|Very Good|Good|Fair|Poor|Ideal|EX|VG|GD|FR|PR)$/i.test(v)) {
          if (!row.Cut) row.Cut = v;
          else if (!row.Polish) row.Polish = v;
          else if (!row.Symmetry) row.Symmetry = v;
        }
        else if (/^[D-M]$/.test(v) && !row.Color) row.Color = v;
        else if (/^\d+\.\d+\s*x\s*\d+\.\d+\s*x\s*\d+\.\d+$/.test(v) && !row.Measurements)
          row.Measurements = v;
        else if (/^\d+\.\d{2,3}$/.test(v) && parseFloat(v) < 30 && !row.Carat)
          row.Carat = v;
      }

      // Second pass: prices, percentages, ratio, cert numbers
      for (const v of vals) {
        if (v === row.Shape || v === row.Clarity || v === row.Lab ||
            v === row['Growth Type'] || v === row.Cut || v === row.Polish ||
            v === row.Symmetry || v === row.Color || v === row.Measurements ||
            v === row.Carat) continue;

        if (/^\$[\d,.]+$/.test(v) || (/^[\d,]+\.\d{2}$/.test(v) && parseFloat(v.replace(/,/g,'')) > 80)) {
          if (!row['Price/Ct']) row['Price/Ct'] = v;
          else if (!row.Total) row.Total = v;
        }
        else if (/^\d{1,3}\.\d%?$/.test(v) && parseFloat(v) >= 40 && parseFloat(v) <= 80) {
          if (!row.Depth) row.Depth = v;
          else if (!row.Table) row.Table = v;
        }
        else if (/^[01]\.\d{2}$/.test(v) && !row.Ratio) row.Ratio = v;
        else if (/^(LG|IGI|GIA|HRD)\d{5,}$/i.test(v) && !row['Cert#']) row['Cert#'] = v;
        else if (/^\d{7,12}$/.test(v) && !row['Cert#']) row['Cert#'] = v;
      }

      // Third pass: supplier, location, stock#
      for (const v of vals) {
        if (v === row.Shape || v === row.Clarity || v === row.Lab ||
            v === row['Growth Type'] || v === row.Cut || v === row.Polish ||
            v === row.Symmetry || v === row.Color || v === row.Measurements ||
            v === row.Carat || v === row['Price/Ct'] || v === row.Total ||
            v === row.Depth || v === row.Table || v === row.Ratio ||
            v === row['Cert#']) continue;

        if (/[a-zA-Z]/.test(v) && v.length > 2) {
          if (/^(LG|IGI|GIA|HRD)\d{5,}$/i.test(v)) {
            if (!row['Cert#']) row['Cert#'] = v;
          } else if (/India|Mumbai|Surat|Delhi|New York|United States|Angeles|Atlanta|Dubai|Hong Kong|Antwerp|Tel Aviv|Israel|Belgium|China|Thailand|Botswana|London|Ramat Gan/i.test(v)) {
            if (!row.Location) row.Location = v;
          } else if (v.length > 10 && v.includes(' ') && !row.Supplier) {
            row.Supplier = v;
          } else if (!row['Stock#'] && v.length <= 25) {
            row['Stock#'] = v;
          } else if (!row.Supplier && v.length > 3) {
            row.Supplier = v;
          } else if (!row.Location && v.length > 3) {
            row.Location = v;
          }
        }
      }

      if (!row['Stock#']) row['Stock#'] = m[1];

      // Quality gate: at least 3 critical fields present
      const criticals = ['Carat','Price/Ct','Total','Cert#','Clarity','Color','Shape','Lab'];
      const presentCount = criticals.reduce((n, k) => n + (row[k] ? 1 : 0), 0);
      if (presentCount < 3) continue;

      state.vdbSeen.add(m[1]);
      rowBatch.push(row);
      state.vdbRows.push(row);
      newCount++;
    }

    return { rowBatch, newCount };
  }

  // ─── Human-like Scrolling ─────────────────────────────────────────────

  const SPEED_CONFIG = {
    slow:   { baseDelay: 800, variance: 600, scrollStep: 150, pauseChance: 0.15, pauseMs: 2000 },
    medium: { baseDelay: 400, variance: 300, scrollStep: 300, pauseChance: 0.08, pauseMs: 1200 },
    fast:   { baseDelay: 150, variance: 100, scrollStep: 600, pauseChance: 0.03, pauseMs: 500 },
  };

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function humanDelay(config) {
    return config.baseDelay + randomBetween(-config.variance / 2, config.variance);
  }

  async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── FIX 4: VDB-Aware Scrolling with Incremental Capture ──────────────

  async function startScrolling(speed) {
    const target = await reacquireSelection();
    if (!target) {
      safeSend({
        action: 'scrollError',
        errorCode: 'no_selection',
        message: 'Selection lost. Click "Re-select" on the page and try again.',
      });
      return;
    }
    state.selectedElement = target;
    state.scrolling = true;
    await saveToStorage({ ule_scrolling: true, ule_data: null });

    const config = SPEED_CONFIG[speed] || SPEED_CONFIG.medium;
    const vdb = isVdbPage();

    if (vdb) {
      await startVdbScrolling(config);
    } else {
      await startGenericScrolling(target, config);
    }
  }

  // ─── VDB Scroll Path (ported from ZP scraper v11.1) ───────────────────
  async function startVdbScrolling(config) {
    // Reset VDB capture state
    state.vdbSeen = new Set();
    state.vdbRows = [];

    // Find VDB scroll container
    const container = findVdbScrollContainer() || document.documentElement;

    // Initial capture of visible rows
    captureVdbRows();
    safeSend({
      action: 'scrollProgress',
      percent: 0,
      message: `VDB mode: ${state.vdbRows.length} rows captured so far…`,
    });

    const SCROLL_STEP = 150;  // 150px — avoids skipping virtualized rows
    const MAX_STALE = 60;
    let stale = 0;
    let step = 0;

    while (state.scrolling && step < 5000) {
      const beforeTop = container.scrollTop;

      // Triple-nudge scroll (FIX 2)
      rnWebScrollNudge(container, SCROLL_STEP + randomBetween(-20, 20));

      await nextFrame();
      await sleep(humanDelay(config));

      // Capture any new rows that the virtualizer mounted
      const { newCount } = captureVdbRows();

      const percent = Math.min(99, Math.round((step / Math.max(step + 20, 100)) * 100));
      safeSend({
        action: 'scrollProgress',
        percent,
        message: `VDB: ${state.vdbRows.length} rows (step ${step}, +${newCount} new)`,
      });

      // Stale detection: no new rows AND scroll didn't move
      if (newCount === 0 && Math.abs(container.scrollTop - beforeTop) < 2) {
        stale++;
      } else {
        stale = 0;
      }

      // Escalation: big jump at stale=30
      if (stale === 30) {
        rnWebScrollNudge(container, 2000);
        await nextFrame();
        await sleep(300);
        captureVdbRows();
      }

      if (stale >= MAX_STALE) break;

      // Random pause for stealth
      if (Math.random() < config.pauseChance) {
        await sleep(randomBetween(config.pauseMs, config.pauseMs * 2));
      }

      step++;
    }

    // ── Final sweep: scroll back to top and re-scan (from ZP v10.3) ──
    if (state.scrolling) {
      rnWebScrollNudge(container, -Math.max(container.scrollTop, 10000));
      await nextFrame();
      await sleep(500);

      let sweepStale = 0;
      const SWEEP_STEP = 200;
      while (state.scrolling && sweepStale < 25) {
        const { newCount } = captureVdbRows();
        if (newCount === 0) sweepStale++;
        else sweepStale = 0;
        rnWebScrollNudge(container, SWEEP_STEP);
        await nextFrame();
        await sleep(humanDelay(config));
      }
      // One last capture at sweep bottom
      captureVdbRows();
    }

    state.scrolling = false;

    // Build structured output from captured VDB rows
    const VDB_HEADERS = [
      'Item ID', 'Supplier', 'Location', 'Lab', 'Shape', 'Carat',
      'Color', 'Clarity', 'Cut', 'Polish', 'Symmetry',
      'Price/Ct', 'Total', 'Depth', 'Table', 'Measurements',
      'Ratio', 'Growth Type', 'Stock#', 'Cert#'
    ];

    const data = {
      headers: VDB_HEADERS,
      rows: state.vdbRows,
    };

    await saveToStorage({ ule_scrolling: false, ule_data: data });
    safeSend({ action: 'scrollComplete', data });
  }

  // ─── Generic Scroll Path (original behavior for non-VDB pages) ────────
  async function startGenericScrolling(target, config) {
    const ctx = findScrollContext(target);
    const maxScrollAttempts = 5000;
    let lastScrollTop = -1;
    let noChangeCount = 0;
    let scrollCount = 0;
    let lastObservedHeight = ctx.scrollHeight;
    let activeCtx = ctx;

    while (state.scrolling && scrollCount < maxScrollAttempts) {
      if (activeCtx.kind === 'element' && !document.body.contains(activeCtx.el)) {
        const reacquired = await reacquireSelection();
        if (reacquired) {
          state.selectedElement = reacquired;
          activeCtx = findScrollContext(reacquired);
          lastObservedHeight = activeCtx.scrollHeight;
          lastScrollTop = -1;
          noChangeCount = 0;
        } else { break; }
      }

      const currentScroll = activeCtx.scrollTop;
      const maxScroll = Math.max(0, activeCtx.scrollHeight - activeCtx.clientHeight);
      const percent = maxScroll > 0 ? Math.min(100, Math.round((currentScroll / maxScroll) * 100)) : 100;
      safeSend({ action: 'scrollProgress', percent, message: `Scrolling… ${percent}% (${scrollCount} steps)` });

      if (activeCtx.scrollHeight > lastObservedHeight + 1) {
        noChangeCount = 0;
        lastObservedHeight = activeCtx.scrollHeight;
      }

      if (currentScroll >= maxScroll - 5) noChangeCount++;
      else if (currentScroll === lastScrollTop) noChangeCount++;
      else noChangeCount = 0;

      if (noChangeCount > 8) break;

      lastScrollTop = currentScroll;
      const step = config.scrollStep + randomBetween(-50, 50);
      activeCtx.scrollBy(step);
      await nextFrame();
      await sleep(humanDelay(config));

      if (Math.random() < config.pauseChance) {
        safeSend({ action: 'scrollProgress', percent, message: 'Pausing briefly…' });
        await sleep(randomBetween(config.pauseMs, config.pauseMs * 2));
      }
      scrollCount++;
    }

    state.scrolling = false;
    const finalTarget = await reacquireSelection();
    const data = extractListData(finalTarget || state.selectedElement);
    await saveToStorage({ ule_scrolling: false, ule_data: data });
    safeSend({ action: 'scrollComplete', data });
  }

  function stopScrolling() {
    state.scrolling = false;
  }

  // ─── Data Extraction (enhanced with VDB detection) ────────────────────

  function extractListData(container) {
    if (!container) return { headers: [], rows: [] };

    // FIX 5: Check for VDB structure FIRST
    if (isVdbPage()) {
      // If we already have VDB rows from incremental capture, use those
      if (state.vdbRows.length > 0) {
        const VDB_HEADERS = [
          'Item ID', 'Supplier', 'Location', 'Lab', 'Shape', 'Carat',
          'Color', 'Clarity', 'Cut', 'Polish', 'Symmetry',
          'Price/Ct', 'Total', 'Depth', 'Table', 'Measurements',
          'Ratio', 'Growth Type', 'Stock#', 'Cert#'
        ];
        return { headers: VDB_HEADERS, rows: state.vdbRows };
      }
      // Otherwise do a one-shot capture of visible rows
      state.vdbSeen = new Set();
      state.vdbRows = [];
      captureVdbRows();
      if (state.vdbRows.length > 0) {
        const VDB_HEADERS = [
          'Item ID', 'Supplier', 'Location', 'Lab', 'Shape', 'Carat',
          'Color', 'Clarity', 'Cut', 'Polish', 'Symmetry',
          'Price/Ct', 'Total', 'Depth', 'Table', 'Measurements',
          'Ratio', 'Growth Type', 'Stock#', 'Cert#'
        ];
        return { headers: VDB_HEADERS, rows: state.vdbRows };
      }
    }

    // Strategy 1: table structure
    const table = container.querySelector('table') || (container.tagName === 'TABLE' ? container : null);
    if (table) return extractFromTable(table);

    // Strategy 2: repeated children
    return extractFromRepeatedChildren(container);
  }

  function extractFromTable(table) {
    const headers = [];
    const rows = [];
    const thElements = table.querySelectorAll('thead th, thead td, tr:first-child th');
    if (thElements.length > 0) {
      thElements.forEach(th => headers.push(cleanText(th.textContent)));
    }
    const trElements = table.querySelectorAll('tbody tr, tr');
    trElements.forEach((tr, idx) => {
      if (idx === 0 && thElements.length > 0 && tr.closest('thead')) return;
      if (tr.querySelectorAll('th').length === tr.children.length && idx === 0) return;
      const cells = tr.querySelectorAll('td, th');
      if (cells.length === 0) return;
      const rowData = {};
      cells.forEach((cell, i) => {
        const header = headers[i] || `Column ${i + 1}`;
        if (!headers[i] && !headers.includes(header)) headers.push(header);
        rowData[header] = cleanText(cell.textContent);
      });
      rows.push(rowData);
    });
    if (headers.length === 0) {
      const maxCols = Math.max(...rows.map(r => Object.keys(r).length), 0);
      for (let i = 0; i < maxCols; i++) headers.push(`Column ${i + 1}`);
    }
    return { headers, rows };
  }

  function extractFromRepeatedChildren(container) {
    const children = Array.from(container.children);
    if (children.length === 0) return { headers: [], rows: [] };

    const tagGroups = {};
    children.forEach(child => {
      const tag = child.tagName;
      if (!tagGroups[tag]) tagGroups[tag] = [];
      tagGroups[tag].push(child);
    });

    let listItems = children;
    let maxCount = 0;
    for (const [, items] of Object.entries(tagGroups)) {
      if (items.length > maxCount) { maxCount = items.length; listItems = items; }
    }

    const sampleItem = listItems[0];
    const fieldSelectors = detectFieldStructure(sampleItem, listItems);
    const headers = fieldSelectors.map(f => f.label);
    const rows = [];

    listItems.forEach(item => {
      const rowData = {};
      fieldSelectors.forEach(field => {
        const el = field.selector ? item.querySelector(field.selector) : item;
        if (el) {
          rowData[field.label] = field.attr
            ? (el.getAttribute(field.attr) || '')
            : cleanText(el.textContent);
        } else {
          rowData[field.label] = '';
        }
      });
      if (Object.values(rowData).some(v => String(v).trim())) rows.push(rowData);
    });

    return { headers, rows };
  }

  function detectFieldStructure(sampleItem, allItems) {
    const fields = [];
    const candidates = [
      { selector: 'h1, h2, h3, h4, h5, h6', label: 'Title' },
      { selector: 'a', label: 'Link Text' },
      { selector: 'img', label: 'Image', attr: 'src' },
      { selector: 'time', label: 'Date' },
      { selector: '[class*="price"], [class*="cost"], [class*="amount"]', label: 'Price' },
      { selector: '[class*="name"], [class*="title"]', label: 'Name' },
      { selector: '[class*="desc"], [class*="description"], [class*="summary"]', label: 'Description' },
      { selector: '[class*="status"]', label: 'Status' },
      { selector: '[class*="email"]', label: 'Email' },
      { selector: '[class*="phone"]', label: 'Phone' },
    ];

    const usedLabels = new Set();
    candidates.forEach(c => {
      const match = sampleItem.querySelector(c.selector);
      if (match) {
        let label = c.label;
        if (usedLabels.has(label)) {
          let i = 2;
          while (usedLabels.has(`${label} ${i}`)) i++;
          label = `${label} ${i}`;
        }
        usedLabels.add(label);
        fields.push({ selector: c.selector, label, attr: c.attr });
      }
    });

    if (fields.length === 0) {
      const directChildren = Array.from(sampleItem.children);
      if (directChildren.length > 1 && directChildren.length <= 15) {
        directChildren.forEach((child, i) => {
          const text = cleanText(child.textContent);
          if (text.length > 0 && text.length < 200) {
            let label = deriveLabel(child) || `Field ${i + 1}`;
            if (usedLabels.has(label)) label = `${label} ${i + 1}`;
            usedLabels.add(label);
            fields.push({
              selector: `:scope > ${child.tagName.toLowerCase()}:nth-child(${i + 1})`,
              label,
            });
          }
        });
      }
    }

    if (fields.length === 0) {
      fields.push({ selector: null, label: 'Content' });
    }

    const firstLink = sampleItem.querySelector('a[href]');
    if (firstLink && !fields.some(f => f.label === 'URL')) {
      fields.push({ selector: 'a[href]', label: 'URL', attr: 'href' });
    }

    return fields;
  }

  function deriveLabel(el) {
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.split(/\s+/).find(c =>
        /name|title|price|desc|date|status|email|phone|id|count|num|type|cat/i.test(c)
      );
      if (cls) {
        return cls.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\b\w/g, c => c.toUpperCase()).trim();
      }
    }
    return null;
  }

  function cleanText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  // ─── Message Handler ──────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case 'startSelection':
        startSelectionMode();
        sendResponse({ success: true, message: 'Selection mode started' });
        break;

      case 'startScroll':
        startScrolling(msg.speed);
        sendResponse({ success: true });
        break;

      case 'stopScroll':
        stopScrolling();
        sendResponse({ success: true });
        break;

      case 'getState':
        sendResponse({
          success: true,
          hasSelection: !!state.selectedElement,
          scrolling: state.scrolling,
        });
        break;

      case 'extractNow':
        if (state.selectedElement) {
          const data = extractListData(state.selectedElement);
          saveToStorage({ ule_data: data });
          sendResponse({ success: true, data });
        } else {
          sendResponse({ success: false, message: 'No element selected' });
        }
        break;

      case 'reset':
        stopScrolling();
        stopSelectionMode();
        if (state.selectedElement) {
          state.selectedElement.classList.remove('ule-selected');
          state.selectedElement = null;
        }
        state.vdbSeen = new Set();
        state.vdbRows = [];
        clearStorage();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, message: 'Unknown action' });
    }
    return true;
  });
})();
