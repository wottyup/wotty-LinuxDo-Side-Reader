/**
 * LinuxDo Side Reader - Content Script
 * Intercepts linux.do topic links and opens them in a slide-out panel.
 */

(function () {
  'use strict';

  const TOPIC_LINK_PATTERN = /^https?:\/\/linux\.do\/t\/[^/]+\/\d+/;
  const CONTENT_READY_SELECTOR = '#topic-title, .topic-post, .topic-area, .timeline-container';
  const PANEL_ID = 'linuxdo-side-reader-panel';
  const OVERLAY_ID = 'linuxdo-side-reader-overlay';
  const IFRAME_STYLE_ID = 'linuxdo-side-reader-iframe-style';
  const PANEL_WIDTH_STORAGE_KEY = 'linuxdo-side-reader-panel-width';
  const PANEL_MIN_WIDTH = 350;
  const LOADING_HIDE_DELAY_MS = 180;
  const LOADING_WATCH_INTERVAL_MS = 120;
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

  const prefetchedUrls = new Set();
  let panelEl = null;
  let panelBodyEl = null;
  let overlayEl = null;
  let iframeEl = null;
  let loadingEl = null;
  let isOpen = false;
  let activeTopicUrl = '';
  let loadedTopicUrl = '';
  let loadingWatchTimer = 0;
  let loadingHideTimer = 0;

  function init() {
    if (document.getElementById(PANEL_ID)) return;
    createPanelDOM();
    bindEvents();
  }

  function createPanelDOM() {
    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    document.body.appendChild(overlayEl);

    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.innerHTML = `
      <div class="lsr-header">
        <span class="lsr-title" title="\u62d6\u52a8\u53ef\u8c03\u6574\u5bbd\u5ea6">LinuxDo Side Reader</span>
        <div class="lsr-actions">
          <a class="lsr-btn lsr-btn-newtab" href="#" title="\u5728\u65b0\u6807\u7b7e\u9875\u4e2d\u6253\u5f00" target="_blank" rel="noreferrer noopener">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9 1h6v6h-2V4.4L7.7 9.7 6.3 8.3 11.6 3H9V1zM3 3h4v2H3v8h8V9h2v6H1V3h2z"/>
            </svg>
          </a>
          <button class="lsr-btn lsr-btn-close" title="\u5173\u95ed\u9762\u677f (Esc)">X</button>
        </div>
      </div>
      <div class="lsr-body">
        <div class="lsr-loading">
          <div class="lsr-loading-brand">
            <img class="lsr-loading-logo" alt="LINUX DO" hidden>
            <div class="lsr-spinner"></div>
          </div>
          <span>\u6b63\u5728\u52a0\u8f7d\u5e16\u5b50...</span>
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

  function bindEvents() {
    document.addEventListener('click', handleLinkClick, true);
    document.addEventListener('pointerover', handleLinkWarmup, true);
    document.addEventListener('focusin', handleLinkWarmup, true);
    document.addEventListener('touchstart', handleLinkWarmup, { capture: true, passive: true });

    panelEl.querySelector('.lsr-btn-close').addEventListener('click', closePanel);
    overlayEl.addEventListener('click', closePanel);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen) {
        closePanel();
      }
    });

    window.addEventListener('resize', syncPanelWidthToViewport);
    initResize();
  }

  function handleLinkWarmup(event) {
    const link = findTopicLink(event.target);
    if (!link) return;
    prefetchTopic(link.href);
  }

  function handleLinkClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;

    const link = findTopicLink(event.target);
    if (!link) return;
    if (panelEl && panelEl.contains(link)) return;

    const href = normalizeTopicUrl(link.href);
    prefetchTopic(href);

    event.preventDefault();
    event.stopPropagation();
    openTopic(href);
  }

  function findTopicLink(target) {
    if (!(target instanceof Element)) return null;
    const link = target.closest('a[href]');
    if (!link) return null;
    if (!TOPIC_LINK_PATTERN.test(link.href)) return null;
    return link;
  }

  function normalizeTopicUrl(url) {
    return new URL(url, window.location.href).href;
  }

  function openTopic(url) {
    const normalizedUrl = normalizeTopicUrl(url);

    activeTopicUrl = normalizedUrl;
    loadedTopicUrl = '';
    panelEl.querySelector('.lsr-btn-newtab').href = normalizedUrl;

    const link = document.querySelector(`a[href="${normalizedUrl}"]`);
    let titleText = '\u5e16\u5b50\u8be6\u60c5';
    if (link) {
      const titleEl = link.closest('.topic-list-item, .latest-topic-list-item')
        ?.querySelector('.main-link a, .link-bottom-line a, a.title');

      if (titleEl) {
        titleText = titleEl.textContent.trim();
      } else {
        titleText = link.textContent.trim().slice(0, 50);
      }
    }

    panelEl.querySelector('.lsr-title').textContent = titleText || 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = titleText || 'LinuxDo Side Reader';

    showLoading();
    stopLoadingWatch();
    replaceIframe();
    startLoadingWatch(normalizedUrl);
    iframeEl.src = normalizedUrl;

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
    window.clearTimeout(loadingHideTimer);
    if (loadingEl) {
      loadingEl.style.display = 'none';
      loadingEl.classList.remove('lsr-loading-hidden');
    }

    activeTopicUrl = '';
    loadedTopicUrl = '';
    removeIframe();
    panelEl.querySelector('.lsr-title').textContent = 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = 'LinuxDo Side Reader';
  }

  function replaceIframe() {
    removeIframe();

    const nextIframe = document.createElement('iframe');
    nextIframe.className = 'lsr-iframe';
    nextIframe.setAttribute('sandbox', IFRAME_SANDBOX);
    nextIframe.style.visibility = 'hidden';

    nextIframe.addEventListener('load', () => {
      if (iframeEl !== nextIframe) return;
      loadedTopicUrl = activeTopicUrl || nextIframe.src;
      syncIframeLayout();
      stopLoadingWatch();
      hideLoading(true);
      nextIframe.style.visibility = '';
    });

    panelBodyEl.insertBefore(nextIframe, loadingEl);
    iframeEl = nextIframe;
  }

  function removeIframe() {
    if (!iframeEl) return;
    iframeEl.remove();
    iframeEl = null;
  }

  function showLoading() {
    if (!loadingEl) return;
    syncLoadingBrand();
    window.clearTimeout(loadingHideTimer);
    loadingEl.style.display = 'flex';
    requestAnimationFrame(() => {
      loadingEl.classList.remove('lsr-loading-hidden');
    });
  }

  function hideLoading(immediate) {
    if (!loadingEl) return;
    window.clearTimeout(loadingHideTimer);
    loadingEl.classList.add('lsr-loading-hidden');

    if (immediate) {
      loadingEl.style.display = 'none';
      return;
    }

    loadingHideTimer = window.setTimeout(() => {
      loadingEl.style.display = 'none';
    }, LOADING_HIDE_DELAY_MS);
  }

  function syncLoadingBrand() {
    if (!loadingEl) return;

    const logoEl = loadingEl.querySelector('.lsr-loading-logo');
    if (!(logoEl instanceof HTMLImageElement)) return;

    const logoSrc = resolveSiteBrandSrc();
    if (!logoSrc) {
      loadingEl.classList.remove('lsr-loading-has-logo');
      logoEl.hidden = true;
      logoEl.removeAttribute('src');
      return;
    }

    if (logoEl.currentSrc !== logoSrc && logoEl.src !== logoSrc) {
      logoEl.src = logoSrc;
    }
    logoEl.hidden = false;
    loadingEl.classList.add('lsr-loading-has-logo');
  }

  function resolveSiteBrandSrc() {
    const logoImg = document.querySelector(
      '#site-logo, .d-header .title .logo img, .d-header .logo-big, .d-header .logo-small'
    );
    if (logoImg instanceof HTMLImageElement) {
      return logoImg.currentSrc || logoImg.src || '';
    }

    const faviconLink = document.querySelector(
      'link[rel~="icon"][href], link[rel="apple-touch-icon"][href]'
    );
    if (faviconLink instanceof HTMLLinkElement) {
      return normalizeTopicUrl(faviconLink.href);
    }

    return '';
  }

  function startLoadingWatch(url) {
    stopLoadingWatch();
    loadingWatchTimer = window.setInterval(() => {
      if (activeTopicUrl !== url) {
        stopLoadingWatch();
        return;
      }

      if (tryRevealContent(url)) {
        stopLoadingWatch();
      }
    }, LOADING_WATCH_INTERVAL_MS);
  }

  function stopLoadingWatch() {
    if (!loadingWatchTimer) return;
    window.clearInterval(loadingWatchTimer);
    loadingWatchTimer = 0;
  }

  function tryRevealContent(url) {
    try {
      const iframeDoc = iframeEl?.contentDocument;
      if (!iframeDoc || activeTopicUrl !== url) return false;

      syncIframeLayout();

      const hasRenderableContent = Boolean(iframeDoc.querySelector(CONTENT_READY_SELECTOR));
      const bodyReady = Boolean(iframeDoc.body && iframeDoc.body.childElementCount > 0);

      if (hasRenderableContent || (bodyReady && iframeDoc.readyState === 'complete')) {
        hideLoading(false);
        iframeEl.style.visibility = '';
        loadedTopicUrl = url;
        return true;
      }
    } catch (error) {
      console.warn('[LinuxDo Side Reader] Failed to reveal iframe content early:', error);
    }

    return false;
  }

  function syncIframeLayout() {
    try {
      const iframeDoc = iframeEl?.contentDocument;
      if (!iframeDoc) return;

      const mountTarget = iframeDoc.head || iframeDoc.documentElement;
      if (!mountTarget) return;

      let styleEl = iframeDoc.getElementById(IFRAME_STYLE_ID);
      if (!styleEl) {
        styleEl = iframeDoc.createElement('style');
        styleEl.id = IFRAME_STYLE_ID;
        mountTarget.appendChild(styleEl);
      }

      if (styleEl.textContent !== IFRAME_LAYOUT_STYLE) {
        styleEl.textContent = IFRAME_LAYOUT_STYLE;
      }
    } catch (error) {
      console.warn('[LinuxDo Side Reader] Failed to sync iframe layout:', error);
    }
  }

  function initResize() {
    const handle = panelEl.querySelector('.lsr-resize-handle');
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      startX = event.clientX;
      startWidth = panelEl.offsetWidth;
      document.body.classList.add('lsr-resizing');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(event) {
      const dx = startX - event.clientX;
      const newWidth = clampPanelWidth(startWidth + dx);
      panelEl.style.width = newWidth + 'px';
    }

    function onMouseUp() {
      document.body.classList.remove('lsr-resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      persistPanelWidth(panelEl.offsetWidth);
    }
  }

  function applySavedPanelWidth() {
    const savedWidth = readSavedPanelWidth();
    if (savedWidth === null) return;
    panelEl.style.width = savedWidth + 'px';
  }

  function syncPanelWidthToViewport() {
    const currentWidth = Number.parseFloat(panelEl?.style.width || '');
    if (!Number.isFinite(currentWidth)) return;

    const clampedWidth = clampPanelWidth(currentWidth);
    if (clampedWidth === currentWidth) return;

    panelEl.style.width = clampedWidth + 'px';
    persistPanelWidth(clampedWidth);
  }

  function readSavedPanelWidth() {
    try {
      const rawValue = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
      if (!rawValue) return null;

      const savedWidth = Number.parseFloat(rawValue);
      if (!Number.isFinite(savedWidth)) return null;
      return clampPanelWidth(savedWidth);
    } catch (error) {
      console.warn('[LinuxDo Side Reader] Failed to read saved panel width:', error);
      return null;
    }
  }

  function persistPanelWidth(width) {
    try {
      const clampedWidth = clampPanelWidth(width);
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(clampedWidth)));
    } catch (error) {
      console.warn('[LinuxDo Side Reader] Failed to persist panel width:', error);
    }
  }

  function clampPanelWidth(width) {
    return Math.min(Math.max(width, PANEL_MIN_WIDTH), window.innerWidth);
  }

  function prefetchTopic(url) {
    if (!TOPIC_LINK_PATTERN.test(url)) return;
    if (prefetchedUrls.has(url)) return;
    if (!document.head) return;

    try {
      const prefetchEl = document.createElement('link');
      prefetchEl.rel = 'prefetch';
      prefetchEl.as = 'document';
      prefetchEl.href = url;
      prefetchEl.crossOrigin = 'use-credentials';
      document.head.appendChild(prefetchEl);
      prefetchedUrls.add(url);
    } catch (error) {
      console.warn('[LinuxDo Side Reader] Failed to prefetch topic:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();