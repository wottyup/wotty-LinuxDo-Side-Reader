/**
 * LinuxDo Side Reader - Content Script
 * Intercepts linux.do topic links and opens them in a slide-out panel.
 *
 * Speed strategy (pure iframe, no JSON preview layer):
 * 1) Prewarm a persistent Discourse SPA iframe at real size, off-screen.
 * 2) pointerover immediately navigates the warm iframe to the target topic.
 * 3) Close leaves the iframe alive off-screen for instant re-open.
 */

(function () {
  'use strict';

  const TOPIC_LINK_PATTERN = /^https?:\/\/linux\.do\/t\/[^/]+\/\d+/;
  const TOPIC_ID_PATTERN = /\/t\/[^/]+\/(\d+)/;
  const CONTENT_READY_SELECTOR = '#topic-title, .topic-post, .topic-area, .timeline-container';
  const PANEL_ID = 'linuxdo-side-reader-panel';
  const OVERLAY_ID = 'linuxdo-side-reader-overlay';
  const IFRAME_STYLE_ID = 'linuxdo-side-reader-iframe-style';
  const HOST_ID = 'linuxdo-side-reader-iframe-host';
  const PANEL_WIDTH_STORAGE_KEY = 'linuxdo-side-reader-panel-width';
  const PANEL_MIN_WIDTH = 350;
  const LOADING_WATCH_INTERVAL_MS = 80;
  const HOST_URL = 'https://linux.do/latest';
  const IFRAME_SANDBOX = 'allow-same-origin allow-scripts allow-popups allow-forms';
  const IFRAME_LAYOUT_STYLE = `
    html, body {
      overscroll-behavior: contain !important;
    }

    :root {
      --d-sidebar-width: 0px !important;
      --d-sidebar-width-desktop: 0px !important;
    }

    .sidebar-wrapper,
    .sidebar-container,
    .d-sidebar {
      display: none !important;
    }

    .timeline-container {
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
    }

    .topic-navigation {
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
    }

    .topic-timeline,
    .topic-map {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
  `;

  let panelEl = null;
  let panelBodyEl = null;
  let overlayEl = null;
  let iframeEl = null;
  let loadingEl = null;
  let hostEl = null;
  let isOpen = false;
  let loadedTopicUrl = '';
  let activeTopicUrl = '';
  let loadingWatchTimer = 0;
  let navCancelId = 0;

  function init() {
    if (document.getElementById(PANEL_ID)) return;
    createPanelDOM();
    createHost();
    bindEvents();
    prewarmShell();
  }

  function createPanelDOM() {
    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    document.body.appendChild(overlayEl);

    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.innerHTML = `
      <div class="lsr-header">
        <span class="lsr-title" title="拖动可调整宽度">LinuxDo Side Reader</span>
        <div class="lsr-actions">
          <a class="lsr-btn lsr-btn-newtab" href="#" title="在新标签页中打开" target="_blank" rel="noreferrer noopener">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9 1h6v6h-2V4.4L7.7 9.7 6.3 8.3 11.6 3H9V1zM3 3h4v2H3v8h8V9h2v6H1V3h2z"/>
            </svg>
          </a>
          <button class="lsr-btn lsr-btn-close" title="关闭面板 (Esc)">X</button>
        </div>
      </div>
      <div class="lsr-body">
        <div class="lsr-loading">
          <div class="lsr-loading-brand">
            <img class="lsr-loading-logo" alt="LINUX DO" hidden>
            <div class="lsr-spinner"></div>
          </div>
          <span>正在加载帖子...</span>
        </div>
      </div>
      <div class="lsr-resize-handle"></div>
    `;
    document.body.appendChild(panelEl);

    applySavedPanelWidth();
    panelBodyEl = panelEl.querySelector('.lsr-body');
    loadingEl = panelEl.querySelector('.lsr-loading');
    syncLoadingBrand();
  }

  function createHost() {
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hostEl);
  }

  function bindEvents() {
    document.addEventListener('click', handleLinkClick, true);
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });

    panelEl.querySelector('.lsr-btn-close').addEventListener('click', closePanel);
    overlayEl.addEventListener('click', closePanel);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) closePanel();
    });

    window.addEventListener('resize', syncPanelWidthToViewport);
    initResize();
  }

  function findTopicLink(target) {
    if (!(target instanceof Element)) return null;
    const link = target.closest('a[href]');
    if (!link) return null;
    if (!TOPIC_LINK_PATTERN.test(link.href)) return null;
    return link;
  }

  function normalizeUrl(url) {
    return new URL(url, window.location.href).href;
  }

  function topicIdOf(url) {
    const m = String(url).match(TOPIC_ID_PATTERN);
    return m ? m[1] : '';
  }

  function sameTopic(a, b) {
    const idA = topicIdOf(a), idB = topicIdOf(b);
    return Boolean(idA && idB && idA === idB);
  }

  // ---- pointerover / touchstart warmup ----

  function handlePointerOver(e) {
    const link = findTopicLink(e.target);
    if (!link) return;
    warmupToTopic(link.href);
  }

  function handleTouchStart(e) {
    const link = findTopicLink(e.target);
    if (!link) return;
    warmupToTopic(link.href);
  }

  // ---- click ----

  function handleLinkClick(e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;

    const link = findTopicLink(e.target);
    if (!link) return;
    if (panelEl && panelEl.contains(link)) return;

    const url = normalizeUrl(link.href);
    warmupToTopic(url);

    e.preventDefault();
    e.stopPropagation();
    openTopic(url);
  }

  // ---- warmup: navigate the persistent iframe to the target topic ----

  function warmupToTopic(url) {
    const normalized = normalizeUrl(url);
    if (!TOPIC_LINK_PATTERN.test(normalized)) return;

    // Skip if the warm iframe already shows this topic.
    if (loadedTopicUrl && sameTopic(loadedTopicUrl, normalized)) return;

    navCancelId++;

    ensureIframe({ url: normalized });
    navigateIframeTo(normalized);
  }

  // ---- iframe lifecycle ----

  function ensureIframe(options = {}) {
    if (iframeEl) return iframeEl;

    const nextIframe = document.createElement('iframe');
    nextIframe.className = 'lsr-iframe';
    nextIframe.setAttribute('sandbox', IFRAME_SANDBOX);
    nextIframe.style.visibility = 'hidden';

    nextIframe.addEventListener('load', onIframeLoad);
    nextIframe.addEventListener('error', () => {
      // If load fails, don't keep stale state.
      loadedTopicUrl = '';
    });

    // Place off-screen initially.
    hostEl.appendChild(nextIframe);
    iframeEl = nextIframe;

    const initialUrl = options.url || HOST_URL;
    nextIframe.src = initialUrl;
    return nextIframe;
  }

  function onIframeLoad() {
    if (!iframeEl) return;
    injectLayoutIntoDoc(iframeEl.contentDocument);

    if (isOpen && activeTopicUrl && isIframeReady(iframeEl)) {
      loadedTopicUrl = safeIframeHref(iframeEl) || activeTopicUrl;
      stopLoadingWatch();
      hideLoading();
      iframeEl.style.visibility = '';
    }

    // Poll for early reveal if the SPA navigates after load.
    if (isOpen && activeTopicUrl) {
      startLoadingWatch(activeTopicUrl);
    }
  }

  function mountIframeIntoPanel() {
    if (!iframeEl || !panelBodyEl) return;
    if (iframeEl.parentElement === panelBodyEl) return;
    panelBodyEl.insertBefore(iframeEl, loadingEl || null);
  }

  function parkIframeOffscreen() {
    if (!iframeEl || !hostEl) return;
    if (iframeEl.parentElement === hostEl) return;
    iframeEl.style.visibility = 'hidden';
    hostEl.appendChild(iframeEl);
  }

  // ---- open ----

  function prewarmShell() {
    // Prewarm immediately; don't idle-wait.
    window.setTimeout(() => {
      ensureIframe();
    }, 50);
  }

  function openTopic(url) {
    const normalized = normalizeUrl(url);

    activeTopicUrl = normalized;
    panelEl.querySelector('.lsr-btn-newtab').href = normalized;
    updateTitle(normalized);

    // Same topic already loaded in panel iframe.
    if (isIframeReady(iframeEl) && sameTopic(loadedTopicUrl, normalized)) {
      mountIframeIntoPanel();
      iframeEl.style.visibility = '';
      hideLoading();
      openShell();
      return;
    }

    // Show panel, show loading, navigate / reveal.
    openShell();
    showLoading();
    mountIframeIntoPanel();
    iframeEl.style.visibility = 'hidden';

    // If the warm iframe is on a different topic, navigate it now.
    if (!sameTopic(safeIframeHref(iframeEl), normalized)) {
      navigateIframeTo(normalized);
    }

    // Start polling for content readiness.
    startLoadingWatch(normalized);
  }

  function navigateIframeTo(url) {
    if (!iframeEl) return;
    const normalized = normalizeUrl(url);

    // Prefer client-side routing for Discourse SPA.
    if (tryDiscourseRoute(iframeEl, normalized)) {
      loadedTopicUrl = '';
      return;
    }

    try {
      const current = iframeEl.contentWindow?.location?.href || '';
      if (current === 'about:blank' || !current) {
        iframeEl.src = normalized;
      } else if (!sameTopic(current, normalized)) {
        iframeEl.contentWindow.location.assign(normalized);
      }
    } catch (error) {
      iframeEl.src = normalized;
    }
    loadedTopicUrl = '';
  }

  function tryDiscourseRoute(iframe, url) {
    try {
      const win = iframe.contentWindow;
      if (!win) return false;
      const path = new URL(url, window.location.origin).pathname + window.location.search + window.location.hash;

      if (win.DiscourseURL && typeof win.DiscourseURL.routeTo === 'function') {
        win.DiscourseURL.routeTo(path);
        return true;
      }

      if (typeof win.require === 'function') {
        try {
          const mod = win.require('discourse/lib/url');
          const URL = mod && (mod.default || mod);
          if (URL && typeof URL.routeTo === 'function') {
            URL.routeTo(path);
            return true;
          }
        } catch (_) {}
      }

      if (win.Discourse && win.Discourse.__container__) {
        const router = win.Discourse.__container__.lookup('router:main');
        if (router && typeof router.handleURL === 'function') {
          router.handleURL(path);
          return true;
        }
      }
    } catch (_) {}
    return false;
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

    stopLoadingWatch();
    if (loadingEl) {
      loadingEl.style.display = 'none';
      loadingEl.classList.remove('lsr-loading-hidden');
    }

    activeTopicUrl = '';
    panelEl.querySelector('.lsr-title').textContent = 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = 'LinuxDo Side Reader';

    // Keep iframe alive off-screen.
    parkIframeOffscreen();
  }

  function updateTitle(url) {
    let text = '帖子详情';
    const link = document.querySelector(`a[href="${url}"]`);
    if (link) {
      const titleEl = link.closest('.topic-list-item, .latest-topic-list-item')
        ?.querySelector('.main-link a, .link-bottom-line a, a.title');
      if (titleEl) text = titleEl.textContent.trim();
      else text = link.textContent.trim().slice(0, 50);
    }
    panelEl.querySelector('.lsr-title').textContent = text || 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = text || 'LinuxDo Side Reader';
  }

  // ---- loading ----

  function showLoading() {
    if (!loadingEl) return;
    syncLoadingBrand();
    loadingEl.style.display = 'flex';
    requestAnimationFrame(() => {
      loadingEl.classList.remove('lsr-loading-hidden');
    });
  }

  function hideLoading() {
    if (!loadingEl) return;
    loadingEl.classList.add('lsr-loading-hidden');
    loadingEl.style.display = 'none';
  }

  function syncLoadingBrand() {
    if (!loadingEl) return;
    const logoEl = loadingEl.querySelector('.lsr-loading-logo');
    if (!(logoEl instanceof HTMLImageElement)) return;
    const src = resolveSiteBrandSrc();
    if (!src) {
      loadingEl.classList.remove('lsr-loading-has-logo');
      logoEl.hidden = true;
      logoEl.removeAttribute('src');
      return;
    }
    if (logoEl.currentSrc !== src && logoEl.src !== src) logoEl.src = src;
    logoEl.hidden = false;
    loadingEl.classList.add('lsr-loading-has-logo');
  }

  function resolveSiteBrandSrc() {
    const logoImg = document.querySelector(
      '#site-logo, .d-header .title .logo img, .d-header .logo-big, .d-header .logo-small'
    );
    if (logoImg instanceof HTMLImageElement) return logoImg.currentSrc || logoImg.src || '';
    const favicon = document.querySelector('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]');
    if (favicon instanceof HTMLLinkElement) return normalizeUrl(favicon.href);
    return '';
  }

  // ---- loading watch + reveal ----

  function startLoadingWatch(url) {
    stopLoadingWatch();
    loadingWatchTimer = window.setInterval(() => {
      if (activeTopicUrl !== url) { stopLoadingWatch(); return; }
      if (tryReveal(url)) stopLoadingWatch();
    }, LOADING_WATCH_INTERVAL_MS);
  }

  function stopLoadingWatch() {
    if (!loadingWatchTimer) return;
    window.clearInterval(loadingWatchTimer);
    loadingWatchTimer = 0;
  }

  function isIframeReady(iframe) {
    try {
      const doc = iframe?.contentDocument;
      if (!doc) return false;
      const hasContent = Boolean(doc.querySelector(CONTENT_READY_SELECTOR));
      const bodyReady = Boolean(doc.body && doc.body.childElementCount > 0);
      return hasContent || (bodyReady && doc.readyState === 'complete');
    } catch (_) { return false; }
  }

  function tryReveal(url) {
    try {
      if (!iframeEl || activeTopicUrl !== url) return false;
      syncIframeLayout();

      const href = safeIframeHref(iframeEl);
      const matched = !href || sameTopic(href, url) || sameTopic(loadedTopicUrl, url);

      if (matched && isIframeReady(iframeEl)) {
        loadedTopicUrl = url;
        hideLoading();
        iframeEl.style.visibility = '';
        return true;
      }
    } catch (e) {
      console.warn('[LinuxDo Side Reader] tryReveal:', e);
    }
    return false;
  }

  function safeIframeHref(iframe) {
    try { return iframe?.contentWindow?.location?.href || ''; } catch (_) { return ''; }
  }

  function injectLayoutIntoDoc(doc) {
    if (!doc) return;
    const target = doc.head || doc.documentElement;
    if (!target) return;
    let el = doc.getElementById(IFRAME_STYLE_ID);
    if (!el) { el = doc.createElement('style'); el.id = IFRAME_STYLE_ID; target.appendChild(el); }
    if (el.textContent !== IFRAME_LAYOUT_STYLE) el.textContent = IFRAME_LAYOUT_STYLE;
  }

  function syncIframeLayout() {
    try { injectLayoutIntoDoc(iframeEl?.contentDocument); } catch (_) {}
  }

  // ---- resize ----

  function initResize() {
    const handle = panelEl.querySelector('.lsr-resize-handle');
    let startX = 0, startWidth = 0;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = panelEl.offsetWidth;
      document.body.classList.add('lsr-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    function onMove(e) {
      panelEl.style.width = clampPanelWidth(startWidth + startX - e.clientX) + 'px';
    }
    function onUp() {
      document.body.classList.remove('lsr-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistPanelWidth(panelEl.offsetWidth);
    }
  }

  function applySavedPanelWidth() {
    const w = readSavedPanelWidth();
    if (w !== null) panelEl.style.width = w + 'px';
  }

  function syncPanelWidthToViewport() {
    const cur = Number.parseFloat(panelEl?.style.width || '');
    if (!Number.isFinite(cur)) return;
    const clamped = clampPanelWidth(cur);
    if (clamped !== cur) { panelEl.style.width = clamped + 'px'; persistPanelWidth(clamped); }
  }

  function readSavedPanelWidth() {
    try {
      const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
      if (!raw) return null;
      const w = Number.parseFloat(raw);
      return Number.isFinite(w) ? clampPanelWidth(w) : null;
    } catch (_) { return null; }
  }

  function persistPanelWidth(w) {
    try { window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(clampPanelWidth(w)))); } catch (_) {}
  }

  function clampPanelWidth(w) { return Math.min(Math.max(w, PANEL_MIN_WIDTH), window.innerWidth); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
