// Content script — handles element selection, human-like scrolling, and data extraction.
// Runs on the actual web page. Persists state to chrome.storage so the popup can
// restore UI after closing/reopening.

(() => {
  'use strict';

  let state = {
    selectionMode: false,
    selectedElement: null,
    scrolling: false,
    hoveredElement: null,
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

  // Send message to popup/background — popup may be closed, so swallow errors
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) { /* ignore */ }
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
    // Walk up to find a scrollable container
    const scrollable = findScrollableParent(e.target);
    if (scrollable) {
      state.selectedElement = scrollable;
    }

    state.selectedElement.classList.add('ule-selected');
    stopSelectionMode();

    const selector = describeElement(state.selectedElement);

    // Persist selection and clear any stale data
    saveToStorage({ ule_selected: selector, ule_data: null, ule_scrolling: false });

    // Notify popup (may be closed — that's fine)
    safeSend({ action: 'elementSelected', selector });
  }

  function onEscape(e) {
    if (e.key === 'Escape') {
      stopSelectionMode();
    }
  }

  function clearHighlight() {
    document.querySelectorAll('.ule-highlight').forEach(el =>
      el.classList.remove('ule-highlight')
    );
  }

  function findScrollableParent(el) {
    // Walk up to 50 levels — modern SPAs (VDB, etc.) nest deeper than 10.
    let current = el;
    for (let i = 0; i < 50 && current; i++) {
      if (isScrollable(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function isScrollable(el) {
    if (!el) return false;
    if (el === document.documentElement || el === document.body) {
      // Document-level scroll: covered separately by findScrollContext().
      return false;
    }
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const overflowYScrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    return overflowYScrollable && el.scrollHeight > el.clientHeight + 4;
  }

  // Returns a uniform handle for the scroll container — works for both
  // ordinary scrollable elements AND document/window-level scrolling, which
  // the v1.0/1.1.0 code couldn't tell apart.
  function findScrollContext(el) {
    // 1. Element-level: el itself is scrollable
    if (isScrollable(el)) return makeElementContext(el);

    // 2. An ancestor element is scrollable
    const parent = findScrollableParent(el);
    if (parent) return makeElementContext(parent);

    // 3. Document/window scrolls (most regular pages, including Google search,
    //    long blog posts, and many SPAs that don't use a custom scroll pane).
    if (document.documentElement.scrollHeight > window.innerHeight + 4) {
      return makeWindowContext();
    }

    // 4. Nothing scrolls — fall back to document anyway so the caller can
    //    still run extraction on the selected element without erroring.
    return makeWindowContext();
  }

  function makeElementContext(el) {
    return {
      kind: 'element',
      el,
      get scrollTop() { return el.scrollTop; },
      get scrollHeight() { return el.scrollHeight; },
      get clientHeight() { return el.clientHeight; },
      scrollBy(dy) {
        // Use 'auto' (instant) — 'smooth' returns immediately while the scroll
        // is still in flight, which races against the position-stable check.
        el.scrollBy({ top: dy, behavior: 'auto' });
      },
    };
  }

  function makeWindowContext() {
    const docEl = document.documentElement;
    return {
      kind: 'window',
      el: docEl,
      get scrollTop() {
        return window.scrollY || docEl.scrollTop || document.body.scrollTop || 0;
      },
      get scrollHeight() {
        return Math.max(
          docEl.scrollHeight, document.body.scrollHeight,
          docEl.offsetHeight, document.body.offsetHeight,
          docEl.clientHeight
        );
      },
      get clientHeight() {
        return window.innerHeight;
      },
      scrollBy(dy) {
        window.scrollBy({ top: dy, behavior: 'auto' });
      },
    };
  }

  // Re-acquire `state.selectedElement` on demand — returns the live DOM node
  // the user originally selected, even after a page reload or SPA re-render
  // detached the previous reference. Returns null if the selector no longer
  // matches anything visible.
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

  // The describeElement format is `tag#id.cls1.cls2`. Build a CSS selector
  // and try variants in case the element's classes have changed slightly.
  function querySelectorFromDescription(desc) {
    if (!desc) return null;
    const tryQuery = (sel) => {
      try { return document.querySelector(sel); } catch (_) { return null; }
    };
    // Exact match first
    let hit = tryQuery(desc);
    if (hit) return hit;
    // Drop classes one at a time
    const parts = desc.split('.');
    while (parts.length > 1) {
      parts.pop();
      hit = tryQuery(parts.join('.'));
      if (hit) return hit;
    }
    // Tag + id only
    const tagOnly = desc.split('#')[0];
    if (tagOnly && tagOnly !== desc) {
      hit = tryQuery(tagOnly);
      if (hit) return hit;
    }
    return null;
  }

  // Wait for the next animation frame so a programmatic scroll commits before
  // we read the new scroll position. Two RAFs ≈ 33 ms guarantees layout has
  // applied even when the page is under heavy paint load.
  function nextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  // Append a scroll-debug entry to chrome.storage.local for ZP to inspect when
  // a teammate reports trouble. Capped at 80 entries (rolling).
  function logScrollEvent(entry) {
    chrome.storage.local.get('ule_scroll_debug').then((stored) => {
      const buf = (stored && stored.ule_scroll_debug) || [];
      buf.push({ at: Date.now(), ...entry });
      while (buf.length > 80) buf.shift();
      chrome.storage.local.set({ ule_scroll_debug: buf }).catch(() => {});
    }).catch(() => {});
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
    const base = config.baseDelay;
    const v = config.variance;
    return base + randomBetween(-v / 2, v);
  }

  async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function startScrolling(speed) {
    // Re-acquire the selection if the in-memory ref is stale (page reload or
    // SPA re-render detached it). The popup's UI may say "Selected" based on
    // chrome.storage.local, but our state is fresh on each content-script
    // injection — so we resolve from the stored selector when needed.
    const target = await reacquireSelection();
    if (!target) {
      safeSend({
        action: 'scrollError',
        errorCode: 'no_selection',
        message: 'Selection lost. Click "Re-select" on the page and try again.',
      });
      logScrollEvent({ phase: 'start', ok: false, errorCode: 'no_selection' });
      return;
    }
    state.selectedElement = target;

    state.scrolling = true;
    await saveToStorage({ ule_scrolling: true, ule_data: null });

    const config = SPEED_CONFIG[speed] || SPEED_CONFIG.medium;
    const ctx = findScrollContext(target);

    logScrollEvent({
      phase: 'start',
      ok: true,
      contextKind: ctx.kind,
      speed,
      url: location.href,
      initialScrollTop: ctx.scrollTop,
      scrollHeight: ctx.scrollHeight,
      clientHeight: ctx.clientHeight,
    });

    const maxScrollAttempts = 5000;
    let lastScrollTop = -1;
    let noChangeCount = 0;
    let scrollCount = 0;
    let lastObservedHeight = ctx.scrollHeight;
    let activeCtx = ctx;

    while (state.scrolling && scrollCount < maxScrollAttempts) {
      // Detached-element guard: if the SPA re-rendered the container under us,
      // re-acquire and rebuild the scroll context. (window-level context is
      // never detached.)
      if (activeCtx.kind === 'element' && !document.body.contains(activeCtx.el)) {
        logScrollEvent({ phase: 'detached_recovery', scrollCount });
        const reacquired = await reacquireSelection();
        if (reacquired) {
          state.selectedElement = reacquired;
          activeCtx = findScrollContext(reacquired);
          lastObservedHeight = activeCtx.scrollHeight;
          lastScrollTop = -1;
          noChangeCount = 0;
        } else {
          break;
        }
      }

      const currentScroll = activeCtx.scrollTop;
      const maxScroll = Math.max(0, activeCtx.scrollHeight - activeCtx.clientHeight);

      const percent = maxScroll > 0 ? Math.min(100, Math.round((currentScroll / maxScroll) * 100)) : 100;
      safeSend({
        action: 'scrollProgress',
        percent,
        message: `Scrolling… ${percent}% (${scrollCount} steps)`,
      });

      // If we appear stuck, give lazy-loaded pages a chance to grow the
      // scrollHeight before we declare done. We watch for height growth across
      // iterations — if growth happens, we reset noChangeCount.
      if (activeCtx.scrollHeight > lastObservedHeight + 1) {
        noChangeCount = 0;
        lastObservedHeight = activeCtx.scrollHeight;
      }

      if (currentScroll >= maxScroll - 5) {
        noChangeCount++;
      } else if (currentScroll === lastScrollTop) {
        noChangeCount++;
      } else {
        noChangeCount = 0;
      }

      if (noChangeCount > 8) {
        logScrollEvent({
          phase: 'end',
          reason: 'stable',
          scrollCount,
          finalScrollTop: currentScroll,
          finalScrollHeight: activeCtx.scrollHeight,
        });
        break;
      }

      lastScrollTop = currentScroll;

      const step = config.scrollStep + randomBetween(-50, 50);
      activeCtx.scrollBy(step);

      // Wait one paint frame so the scroll commits, then the configured
      // human-like delay. Without the RAF wait, the next iteration reads
      // scrollTop while the position hasn't yet been laid out, which used
      // to falsely increment noChangeCount and exit early at "Fast" speed.
      await nextFrame();
      await sleep(humanDelay(config));

      if (Math.random() < config.pauseChance) {
        safeSend({
          action: 'scrollProgress',
          percent,
          message: 'Pausing briefly…',
        });
        await sleep(randomBetween(config.pauseMs, config.pauseMs * 2));
      }

      scrollCount++;
    }

    state.scrolling = false;

    // Extract from the live element (re-acquire one last time defensively).
    const finalTarget = await reacquireSelection();
    const data = extractListData(finalTarget || state.selectedElement);

    await saveToStorage({ ule_scrolling: false, ule_data: data });

    logScrollEvent({
      phase: 'complete',
      scrollCount,
      itemsExtracted: (data && data.rows && data.rows.length) || 0,
    });

    safeSend({ action: 'scrollComplete', data });
  }

  function stopScrolling() {
    state.scrolling = false;
  }

  // ─── Data Extraction ──────────────────────────────────────────────────

  function extractListData(container) {
    if (!container) return { headers: [], rows: [] };

    // Strategy 1: Look for table structure
    const table = container.querySelector('table') || (container.tagName === 'TABLE' ? container : null);
    if (table) return extractFromTable(table);

    // Strategy 2: Look for repeated child elements (list items)
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

    // Group by tag name — largest group = likely list items
    const tagGroups = {};
    children.forEach(child => {
      const tag = child.tagName;
      if (!tagGroups[tag]) tagGroups[tag] = [];
      tagGroups[tag].push(child);
    });

    let listItems = children;
    let maxCount = 0;
    for (const [, items] of Object.entries(tagGroups)) {
      if (items.length > maxCount) {
        maxCount = items.length;
        listItems = items;
      }
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
          // Use attribute value when specified (e.g. href, src), otherwise textContent
          rowData[field.label] = field.attr
            ? (el.getAttribute(field.attr) || '')
            : cleanText(el.textContent);
        } else {
          rowData[field.label] = '';
        }
      });

      if (Object.values(rowData).some(v => String(v).trim())) {
        rows.push(rowData);
      }
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

    // If no structured fields found, look at direct children
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

    // Fallback: full text
    if (fields.length === 0) {
      fields.push({ selector: null, label: 'Content' });
    }

    // Also grab href from first link if present and not already captured
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
        return cls
          .replace(/[-_]/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim();
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
        // Let popup query current in-memory state (element still selected?, scrolling?)
        sendResponse({
          success: true,
          hasSelection: !!state.selectedElement,
          scrolling: state.scrolling,
        });
        break;

      case 'extractNow':
        // Extract data from already-selected element without scrolling
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
        clearStorage();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, message: 'Unknown action' });
    }
    return true;
  });
})();
