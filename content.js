/**
 * LinuxDo Side Reader - Content Script
 * Intercepts linux.do topic links and opens them in a slide-out panel.
 *
 * Speed strategy (dual iframe):
 * 1) Panel iframe shows the current topic.
 * 2) Background warm iframe preloads the next likely topic.
 * 3) On click, swap the prewarmed iframe in — instant.
 * 4) On page load, prewarm to the first visible topic in the list.
 */

(function () {
  'use strict';

  const TOPIC_LINK_RE = /^https?:\/\/linux\.do\/t\/[^/]+\/\d+/;
  const TOPIC_ID_RE = /\/t\/[^/]+\/(\d+)/;
  const CONTENT_READY_SEL = '#topic-title, .topic-post, .topic-area, .timeline-container';
  const PANEL_ID = 'linuxdo-side-reader-panel';
  const OVERLAY_ID = 'linuxdo-side-reader-overlay';
  const STYLE_ID = 'linuxdo-side-reader-iframe-style';
  const HOST_ID = 'linuxdo-side-reader-iframe-host';
  const PANEL_WIDTH_KEY = 'linuxdo-side-reader-panel-width';
  const PANEL_MIN_W = 350;
  const WATCH_IV = 80;
  const HOST_URL = 'https://linux.do/latest';
  const SANDBOX = 'allow-same-origin allow-scripts allow-popups allow-forms';
  const LAYOUT_CSS = '\
    html,body{overscroll-behavior:contain!important}\
    :root{--d-sidebar-width:0px!important;--d-sidebar-width-desktop:0px!important}\
    .sidebar-wrapper,.sidebar-container,.d-sidebar{display:none!important}\
    .timeline-container{display:flex!important;visibility:visible!important;opacity:1!important}\
    .topic-navigation{display:flex!important;visibility:visible!important;opacity:1!important}\
    .topic-timeline,.topic-map{display:block!important;visibility:visible!important;opacity:1!important}';

  // ---- state ----
  let panelEl, panelBodyEl, overlayEl, loadingEl, hostEl;
  let panelIframe = null;   // iframe currently in the panel
  let warmIframe = null;    // background iframe preloading next topic
  let isOpen = false;
  let activeUrl = '';
  let loadedUrl = '';       // topic the panel iframe has actually finished loading
  let warmUrl = '';         // topic the warm iframe is targeting
  let watchTimer = 0;
  let gen = 0;

  function init() {
    if (document.getElementById(PANEL_ID)) return;
    buildDOM();
    bind();
    setTimeout(prewarmFirstTopic, 50);
  }

  // ---- DOM ----

  function buildDOM() {
    overlayEl = el('div', { id: OVERLAY_ID });
    document.body.appendChild(overlayEl);

    panelEl = el('div', { id: PANEL_ID });
    panelEl.innerHTML = '\
      <div class="lsr-header">\
        <span class="lsr-title" title="拖动可调整宽度">LinuxDo Side Reader</span>\
        <div class="lsr-actions">\
          <a class="lsr-btn lsr-btn-newtab" href="#" title="在新标签页中打开" target="_blank" rel="noreferrer noopener">\
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1h6v6h-2V4.4L7.7 9.7 6.3 8.3 11.6 3H9V1zM3 3h4v2H3v8h8V9h2v6H1V3h2z"/></svg>\
          </a>\
          <button class="lsr-btn lsr-btn-close" title="关闭面板 (Esc)">X</button>\
        </div>\
      </div>\
      <div class="lsr-body">\
        <div class="lsr-loading">\
          <div class="lsr-loading-brand">\
            <img class="lsr-loading-logo" alt="LINUX DO" hidden>\
            <div class="lsr-spinner"></div>\
          </div>\
          <span>正在加载帖子…</span>\
        </div>\
      </div>\
      <div class="lsr-resize-handle"></div>';
    document.body.appendChild(panelEl);

    applySavedWidth();
    panelBodyEl = panelEl.querySelector('.lsr-body');
    loadingEl = panelEl.querySelector('.lsr-loading');
    syncBrand();

    hostEl = el('div', { id: HOST_ID, 'aria-hidden': 'true' });
    document.body.appendChild(hostEl);
  }

  function el(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) Object.assign(e, attrs);
    for (const k in attrs || {}) {
      if (k.startsWith('aria-') || k === 'id') e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  // ---- events ----

  function bind() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerover', onHover, true);
    document.addEventListener('touchstart', onTouch, { capture: true, passive: true });
    panelEl.querySelector('.lsr-btn-close').addEventListener('click', closePanel);
    overlayEl.addEventListener('click', closePanel);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) closePanel(); });
    window.addEventListener('resize', syncWidth);
    initResize();
  }

  function findLink(t) { const a = t.closest?.('a[href]'); return a && TOPIC_LINK_RE.test(a.href) ? a : null; }
  function norm(u) { return new URL(u, location.href).href; }
  function tid(u) { const m = String(u).match(TOPIC_ID_RE); return m ? m[1] : ''; }
  function same(a, b) { const ia = tid(a), ib = tid(b); return Boolean(ia && ib && ia === ib); }

  function onHover(e) { const l = findLink(e.target); if (l) warmTo(norm(l.href)); }
  function onTouch(e) { const l = findLink(e.target); if (l) warmTo(norm(l.href)); }

  function onClick(e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    const link = findLink(e.target);
    if (!link || (panelEl && panelEl.contains(link))) return;
    const url = norm(link.href);
    warmTo(url);
    e.preventDefault(); e.stopPropagation();
    open(url);
  }

  // ---- iframe factory ----

  function makeIframe(url) {
    const f = document.createElement('iframe');
    f.className = 'lsr-iframe';
    f.setAttribute('sandbox', SANDBOX);
    f.style.visibility = 'hidden';
    f.addEventListener('load', () => injectLayout(f.contentDocument));
    hostEl.appendChild(f);
    f.src = url || HOST_URL;
    return f;
  }

  function swapIframes(fromPool, toPool) {
    // Move `fromPool` into panel if not already there.
    if (fromPool && fromPool.parentElement !== panelBodyEl) {
      panelBodyEl.insertBefore(fromPool, loadingEl);
    }
    // Park `toPool` off-screen.
    if (toPool && toPool.parentElement !== hostEl) {
      toPool.style.visibility = 'hidden';
      hostEl.appendChild(toPool);
    }
  }

  // ---- prewarm ----

  function prewarmFirstTopic() {
    const firstLink = document.querySelector('a[href]');
    // Try the first topic link in the list.
    const topicLink = document.querySelector('.topic-list-item a.title[href], .latest-topic-list-item a[href], a.topic-link[href]');
    const url = topicLink ? norm(topicLink.href) : null;
    warmIframe = makeIframe(url);
    if (url) { warmUrl = url; loadedWarm(url); }
  }

  function warmTo(url) {
    const u = norm(url);
    if (!TOPIC_LINK_RE.test(u)) return;

    // Don't warm the already-active topic or the already-warming topic.
    if (same(u, activeUrl) || same(u, loadedUrl)) return;
    if (warmIframe && same(u, warmUrl)) return;

    // If panel iframe is the only one and not active, use it to warm.
    if (!warmIframe && panelIframe && !same(loadedUrl, u)) {
      // Steal panel iframe for warming if panel is closed.
      if (!isOpen) {
        warmIframe = panelIframe;
        panelIframe = null;
        warmUrl = '';
        loadedUrl = '';
        navigateTo(warmIframe, u);
        warmUrl = u;
        return;
      }
    }

    if (!warmIframe) {
      warmIframe = makeIframe(u);
      warmUrl = u;
      loadedWarm(u);
      return;
    }

    navigateTo(warmIframe, u);
    warmUrl = u;
    loadedWarm(u);
  }

  function loadedWarm(url) {
    // Mark that the warm iframe is now loading this topic.
    // The actual loadedUrl gets updated in tryReveal or on load.
  }

  // ---- open / close ----

  function open(url) {
    const u = norm(url);
    openShell();
    showLoading();
    gen++;

    const g = gen;
    activeUrl = u;
    panelEl.querySelector('.lsr-btn-newtab').href = u;
    updateTitle(u);

    // Case 1: panel iframe already has this topic loaded.
    if (panelIframe && same(loadedUrl, u) && isReady(panelIframe)) {
      panelIframe.style.visibility = '';
      hideLoading();
      return;
    }

    // Case 2: warm iframe has this topic → promote it.
    if (warmIframe && same(warmUrl, u)) {
      // Swap: old panel becomes warm, warm becomes panel.
      const oldPanel = panelIframe;
      panelIframe = warmIframe;
      warmIframe = oldPanel;
      if (oldPanel) warmUrl = '';

      panelIframe.style.visibility = 'hidden';
      swapIframes(panelIframe, warmIframe);

      const alreadyReady = isReady(panelIframe);
      if (alreadyReady) {
        loadedUrl = u;
        hideLoading();
        panelIframe.style.visibility = '';
      } else {
        watch(u, g);
      }
      return;
    }

    // Case 3: cold — navigate the panel iframe.
    if (!panelIframe) {
      // Promote warm iframe if it exists, even if wrong topic.
      if (warmIframe) {
        panelIframe = warmIframe;
        warmIframe = null;
        warmUrl = '';
      } else {
        panelIframe = makeIframe(u);
      }
    }

    panelIframe.style.visibility = 'hidden';
    swapIframes(panelIframe, warmIframe);

    if (!same(loadedUrl, u)) {
      navigateTo(panelIframe, u);
    }
    watch(u, g);
  }

  function openShell() {
    requestAnimationFrame(() => {
      overlayEl.classList.add('lsr-visible');
      panelEl.classList.add('lsr-open');
      document.body.classList.add('lsr-body-lock');
      isOpen = true;
    });
  }

  function closePanel() {
    panelEl.classList.remove('lsr-open');
    overlayEl.classList.remove('lsr-visible');
    document.body.classList.remove('lsr-body-lock');
    isOpen = false;
    stopWatch();
    hideLoading();
    activeUrl = '';
    panelEl.querySelector('.lsr-title').textContent = 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = 'LinuxDo Side Reader';
    // Park panel iframe off-screen; keep warm iframe alive.
    if (panelIframe) {
      panelIframe.style.visibility = 'hidden';
      hostEl.appendChild(panelIframe);
    }
  }

  function updateTitle(url) {
    let t = '帖子详情';
    const link = document.querySelector(`a[href="${url}"]`);
    if (link) {
      const titleEl = link.closest('.topic-list-item, .latest-topic-list-item')
        ?.querySelector('.main-link a, .link-bottom-line a, a.title');
      t = titleEl ? titleEl.textContent.trim() : link.textContent.trim().slice(0, 50);
    }
    panelEl.querySelector('.lsr-title').textContent = t || 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = t || 'LinuxDo Side Reader';
  }

  // ---- navigation ----

  function navigateTo(iframe, url) {
    if (!iframe) return;
    const u = norm(url);
    if (tryRoute(iframe, u)) return;

    try {
      const cur = iframe.contentWindow?.location?.href || '';
      if (cur === 'about:blank' || !cur) iframe.src = u;
      else if (!same(cur, u)) iframe.contentWindow.location.assign(u);
    } catch (_) { iframe.src = u; }
    loadedUrl = '';
  }

  function tryRoute(iframe, url) {
    try {
      const w = iframe.contentWindow;
      if (!w) return false;
      const path = new URL(url, location.origin).pathname + location.search + location.hash;
      if (w.DiscourseURL?.routeTo) { w.DiscourseURL.routeTo(path); return true; }
      if (typeof w.require === 'function') {
        try { const m = w.require('discourse/lib/url'); const u = m?.default || m; if (u?.routeTo) { u.routeTo(path); return true; } } catch (_) {}
      }
      if (w.Discourse?.__container__) {
        const r = w.Discourse.__container__.lookup('router:main');
        if (r?.handleURL) { r.handleURL(path); return true; }
      }
    } catch (_) {}
    return false;
  }

  // ---- watch + reveal ----

  function watch(url, g) { stopWatch(); watchTimer = setInterval(() => { if (gen !== g || activeUrl !== url) stopWatch(); else if (reveal(url)) stopWatch(); }, WATCH_IV); }
  function stopWatch() { if (watchTimer) { clearInterval(watchTimer); watchTimer = 0; } }

  function isReady(f) {
    try {
      const d = f?.contentDocument;
      if (!d) return false;
      return Boolean(d.querySelector(CONTENT_READY_SEL)) || (Boolean(d.body?.childElementCount) && d.readyState === 'complete');
    } catch (_) { return false; }
  }

  function reveal(url) {
    try {
      if (!panelIframe || activeUrl !== url) return false;
      syncLayout();
      const href = safeHref(panelIframe);
      const matched = !href || same(href, url) || same(loadedUrl, url);
      if (matched && isReady(panelIframe)) {
        loadedUrl = url;
        hideLoading();
        panelIframe.style.visibility = '';
        return true;
      }
    } catch (e) { console.warn('[LSR] reveal:', e); }
    return false;
  }

  function safeHref(f) { try { return f?.contentWindow?.location?.href || ''; } catch (_) { return ''; } }

  // ---- loading UI ----

  function showLoading() {
    if (!loadingEl) return;
    syncBrand();
    loadingEl.style.display = 'flex';
    loadingEl.classList.remove('lsr-loading-hidden');
  }

  function hideLoading() {
    if (!loadingEl) return;
    loadingEl.classList.add('lsr-loading-hidden');
    loadingEl.style.display = 'none';
  }

  function syncBrand() {
    if (!loadingEl) return;
    const img = loadingEl.querySelector('.lsr-loading-logo');
    if (!(img instanceof HTMLImageElement)) return;
    const src = brandSrc();
    if (!src) { loadingEl.classList.remove('lsr-loading-has-logo'); img.hidden = true; img.removeAttribute('src'); return; }
    if (img.currentSrc !== src && img.src !== src) img.src = src;
    img.hidden = false;
    loadingEl.classList.add('lsr-loading-has-logo');
  }

  function brandSrc() {
    const logo = document.querySelector('#site-logo, .d-header .title .logo img, .d-header .logo-big, .d-header .logo-small');
    if (logo instanceof HTMLImageElement) return logo.currentSrc || logo.src || '';
    const fav = document.querySelector('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]');
    return fav instanceof HTMLLinkElement ? norm(fav.href) : '';
  }

  // ---- layout injection ----

  function injectLayout(doc) {
    if (!doc) return;
    const t = doc.head || doc.documentElement;
    if (!t) return;
    let s = doc.getElementById(STYLE_ID);
    if (!s) { s = doc.createElement('style'); s.id = STYLE_ID; t.appendChild(s); }
    if (s.textContent !== LAYOUT_CSS) s.textContent = LAYOUT_CSS;
  }

  function syncLayout() { try { injectLayout(panelIframe?.contentDocument); } catch (_) {} }

  // ---- resize ----

  function initResize() {
    const h = panelEl.querySelector('.lsr-resize-handle');
    let sx = 0, sw = 0;
    h.addEventListener('mousedown', e => {
      e.preventDefault(); sx = e.clientX; sw = panelEl.offsetWidth;
      document.body.classList.add('lsr-resizing');
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', mu);
    });
    function mv(e) { panelEl.style.width = clampW(sw + sx - e.clientX) + 'px'; }
    function mu() { document.body.classList.remove('lsr-resizing'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', mu); saveW(panelEl.offsetWidth); }
  }

  function applySavedWidth() { const w = readW(); if (w !== null) panelEl.style.width = w + 'px'; }
  function syncWidth() { const c = parseFloat(panelEl?.style.width || ''); if (isFinite(c)) { const cl = clampW(c); if (cl !== c) { panelEl.style.width = cl + 'px'; saveW(cl); } } }
  function readW() { try { const r = localStorage.getItem(PANEL_WIDTH_KEY); if (!r) return null; const v = parseFloat(r); return isFinite(v) ? clampW(v) : null; } catch (_) { return null; } }
  function saveW(w) { try { localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(clampW(w)))); } catch (_) {} }
  function clampW(w) { return Math.min(Math.max(w, PANEL_MIN_W), innerWidth); }

  // ---- start ----

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
