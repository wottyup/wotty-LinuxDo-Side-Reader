/**
 * LinuxDo Side Reader - Content Script
 * Intercepts linux.do topic links and opens them in a slide-out panel.
 *
 * Speed strategy:
 * 1) Idle-prewarm a persistent Discourse SPA iframe (full size, off-screen).
 * 2) Navigate with Discourse client router when possible (no cold boot).
 * 3) Instantly paint posts from /t/{id}.json while the SPA catches up.
 * 4) pointerdown / hover warmup + JSON cache.
 */

(function () {
  'use strict';

  const TOPIC_LINK_PATTERN = /^https?:\/\/linux\.do\/t\/[^/]+\/\d+/;
  const TOPIC_ID_PATTERN = /\/t\/[^/]+\/(\d+)/;
  const CONTENT_READY_SELECTOR = '#topic-title, .topic-post, .topic-area, .timeline-container';
  const PANEL_ID = 'linuxdo-side-reader-panel';
  const OVERLAY_ID = 'linuxdo-side-reader-overlay';
  const IFRAME_STYLE_ID = 'linuxdo-side-reader-iframe-style';
  const PRERENDER_HOST_ID = 'linuxdo-side-reader-prerender-host';
  const PANEL_WIDTH_STORAGE_KEY = 'linuxdo-side-reader-panel-width';
  const PANEL_MIN_WIDTH = 350;
  const LOADING_HIDE_DELAY_MS = 120;
  const LOADING_WATCH_INTERVAL_MS = 80;
  const PRERENDER_DEBOUNCE_MS = 80;
  const SHELL_PREWARM_DELAY_MS = 600;
  const SHELL_URL = 'https://linux.do/latest';
  const INSTANT_POST_LIMIT = 20;
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
  const jsonCache = new Map(); // topicId -> { promise, data, ts }
  let panelEl = null;
  let panelBodyEl = null;
  let overlayEl = null;
  let iframeEl = null;
  let loadingEl = null;
  let instantEl = null;
  let prerenderHostEl = null;
  let isOpen = false;
  let shellReady = false;
  let shellBooting = false;
  let activeTopicUrl = '';
  let activeTopicId = '';
  let loadedTopicUrl = '';
  let loadingWatchTimer = 0;
  let loadingHideTimer = 0;
  let prerenderDebounceTimer = 0;
  let openGeneration = 0;

  function init() {
    if (document.getElementById(PANEL_ID)) return;
    createPanelDOM();
    createPrerenderHost();
    bindEvents();
    scheduleShellPrewarm();
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
        <div class="lsr-instant"></div>
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
    instantEl = panelEl.querySelector('.lsr-instant');
    syncLoadingBrand();
  }

  function createPrerenderHost() {
    prerenderHostEl = document.createElement('div');
    prerenderHostEl.id = PRERENDER_HOST_ID;
    prerenderHostEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(prerenderHostEl);
  }

  function bindEvents() {
    document.addEventListener('click', handleLinkClick, true);
    // Start earlier than click — biggest free win for "direct click" path.
    document.addEventListener('pointerdown', handleLinkWarmupEager, true);
    document.addEventListener('pointerover', handleLinkWarmup, true);
    document.addEventListener('focusin', handleLinkWarmup, true);
    document.addEventListener('touchstart', handleLinkWarmupEager, { capture: true, passive: true });

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
    scheduleTopicWarmup(link.href);
  }

  function handleLinkWarmupEager(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const link = findTopicLink(event.target);
    if (!link) return;
    window.clearTimeout(prerenderDebounceTimer);
    warmupTopic(link.href, { eager: true });
  }

  function handleLinkClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;

    const link = findTopicLink(event.target);
    if (!link) return;
    if (panelEl && panelEl.contains(link)) return;

    const href = normalizeTopicUrl(link.href);
    window.clearTimeout(prerenderDebounceTimer);
    warmupTopic(href, { eager: true });

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

  function extractTopicId(url) {
    const match = String(url).match(TOPIC_ID_PATTERN);
    return match ? match[1] : '';
  }

  function topicPath(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (error) {
      return url;
    }
  }

  function sameTopic(urlA, urlB) {
    const idA = extractTopicId(urlA);
    const idB = extractTopicId(urlB);
    return Boolean(idA && idB && idA === idB);
  }

  function scheduleShellPrewarm() {
    const start = () => {
      window.setTimeout(() => {
        ensureShell({ reason: 'idle' });
      }, SHELL_PREWARM_DELAY_MS);
    };

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(start, { timeout: 1500 });
    } else {
      start();
    }
  }

  function ensureShell(options = {}) {
    if (iframeEl) return iframeEl;
    if (!prerenderHostEl && !panelBodyEl) return null;

    shellBooting = true;
    const nextIframe = document.createElement('iframe');
    nextIframe.className = 'lsr-iframe lsr-iframe-warming';
    nextIframe.setAttribute('sandbox', IFRAME_SANDBOX);
    nextIframe.setAttribute('aria-hidden', 'true');
    nextIframe.style.visibility = 'hidden';

    nextIframe.addEventListener('load', () => {
      if (iframeEl !== nextIframe) return;
      injectLayoutIntoDoc(nextIframe.contentDocument);
      shellReady = isDiscourseAppReady(nextIframe) || isIframeContentReady(nextIframe);
      shellBooting = false;
      if (shellReady) {
        nextIframe.classList.add('lsr-iframe-shell-ready');
      }
    });

    // Keep shell off-screen at real size so the browser does not throttle it.
    if (isOpen && panelBodyEl) {
      panelBodyEl.insertBefore(nextIframe, loadingEl);
    } else if (prerenderHostEl) {
      prerenderHostEl.appendChild(nextIframe);
    } else {
      panelBodyEl.insertBefore(nextIframe, loadingEl);
    }

    iframeEl = nextIframe;

    // Prefer a real topic if caller provided one; otherwise warm the app shell.
    const initialUrl = options.url || SHELL_URL;
    nextIframe.src = initialUrl;
    return nextIframe;
  }

  function mountIframeIntoPanel() {
    if (!iframeEl || !panelBodyEl) return;
    if (iframeEl.parentElement === panelBodyEl) return;
    panelBodyEl.insertBefore(iframeEl, loadingEl || null);
    iframeEl.classList.remove('lsr-iframe-warming');
    iframeEl.removeAttribute('aria-hidden');
  }

  function parkIframeOffscreen() {
    if (!iframeEl || !prerenderHostEl) return;
    if (iframeEl.parentElement === prerenderHostEl) return;
    iframeEl.classList.add('lsr-iframe-warming');
    iframeEl.setAttribute('aria-hidden', 'true');
    iframeEl.style.visibility = 'hidden';
    prerenderHostEl.appendChild(iframeEl);
  }

  function openTopic(url) {
    const normalizedUrl = normalizeTopicUrl(url);
    const topicId = extractTopicId(normalizedUrl);
    const generation = ++openGeneration;

    activeTopicUrl = normalizedUrl;
    activeTopicId = topicId;
    panelEl.querySelector('.lsr-btn-newtab').href = normalizedUrl;
    updatePanelTitle(normalizedUrl, topicId);

    // Same topic already showing: just reopen shell.
    if (iframeEl && sameTopic(loadedTopicUrl, normalizedUrl) && isIframeContentReady(iframeEl)) {
      clearInstantContent();
      hideLoading(true);
      mountIframeIntoPanel();
      iframeEl.style.visibility = '';
      openPanelShell();
      return;
    }

    openPanelShell();
    showLoading();
    clearInstantContent();
    ensureShell({ url: normalizedUrl });
    mountIframeIntoPanel();
    iframeEl.style.visibility = 'hidden';

    // Instant path: paint JSON content ASAP (usually <300ms if cached/hovered).
    paintInstantFromJson(topicId, normalizedUrl, generation);

    // SPA / navigation path.
    navigateIframeToTopic(normalizedUrl, generation);
    startLoadingWatch(normalizedUrl, generation);
  }

  function openPanelShell() {
    requestAnimationFrame(() => {
      overlayEl.classList.add('lsr-visible');
      panelEl.classList.add('lsr-open');
      document.body.classList.add('lsr-body-lock');
      isOpen = true;
    });
  }

  function updatePanelTitle(url, topicId) {
    let titleText = '帖子详情';

    const cached = topicId ? jsonCache.get(topicId) : null;
    if (cached && cached.data && cached.data.title) {
      titleText = cached.data.title;
    } else {
      const link = document.querySelector(`a[href="${url}"]`);
      if (link) {
        const titleEl = link.closest('.topic-list-item, .latest-topic-list-item')
          ?.querySelector('.main-link a, .link-bottom-line a, a.title');
        if (titleEl) {
          titleText = titleEl.textContent.trim();
        } else {
          titleText = link.textContent.trim().slice(0, 50);
        }
      }
    }

    panelEl.querySelector('.lsr-title').textContent = titleText || 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = titleText || 'LinuxDo Side Reader';
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
    activeTopicId = '';
    hideInstant();

    // Keep the warm SPA alive off-screen for the next open.
    if (iframeEl) {
      parkIframeOffscreen();
    }

    panelEl.querySelector('.lsr-title').textContent = 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = 'LinuxDo Side Reader';
  }

  function scheduleTopicWarmup(url) {
    const normalizedUrl = normalizeTopicUrl(url);
    if (!TOPIC_LINK_PATTERN.test(normalizedUrl)) return;

    prefetchTopicDocument(normalizedUrl);
    prefetchTopicJson(normalizedUrl);

    if (isOpen && sameTopic(activeTopicUrl, normalizedUrl)) return;
    if (iframeEl && sameTopic(loadedTopicUrl, normalizedUrl) && isIframeContentReady(iframeEl)) return;

    window.clearTimeout(prerenderDebounceTimer);
    prerenderDebounceTimer = window.setTimeout(() => {
      warmupTopic(normalizedUrl, { eager: false });
    }, PRERENDER_DEBOUNCE_MS);
  }

  function warmupTopic(url, options = {}) {
    const normalizedUrl = normalizeTopicUrl(url);
    if (!TOPIC_LINK_PATTERN.test(normalizedUrl)) return;

    prefetchTopicDocument(normalizedUrl);
    prefetchTopicJson(normalizedUrl);
    ensureShell({ url: options.eager ? normalizedUrl : undefined });

    // If shell already ready and panel closed, pre-navigate off-screen.
    if (!isOpen && shellReady && iframeEl && options.eager) {
      navigateIframeToTopic(normalizedUrl, openGeneration, { silent: true });
    }
  }

  function prefetchTopicDocument(url) {
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
      console.warn('[LinuxDo Side Reader] Failed to prefetch topic document:', error);
    }
  }

  function prefetchTopicJson(url) {
    const topicId = extractTopicId(url);
    if (!topicId) return;
    getTopicJson(topicId);
  }

  function getTopicJson(topicId) {
    if (!topicId) return Promise.resolve(null);

    const cached = jsonCache.get(topicId);
    if (cached) {
      if (cached.data) return Promise.resolve(cached.data);
      if (cached.promise) return cached.promise;
    }

    const jsonUrl = new URL(`/t/${topicId}.json`, window.location.origin).href;
    const promise = fetch(jsonUrl, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'force-cache',
    })
      .then((response) => {
        if (!response.ok) throw new Error('topic json ' + response.status);
        return response.json();
      })
      .then((data) => {
        jsonCache.set(topicId, { data, promise: null, ts: Date.now() });
        // Bound cache size.
        if (jsonCache.size > 30) {
          const oldestKey = jsonCache.keys().next().value;
          jsonCache.delete(oldestKey);
        }
        return data;
      })
      .catch((error) => {
        jsonCache.delete(topicId);
        console.warn('[LinuxDo Side Reader] Topic JSON prefetch failed:', error);
        return null;
      });

    jsonCache.set(topicId, { data: null, promise, ts: Date.now() });
    return promise;
  }

  async function paintInstantFromJson(topicId, url, generation) {
    if (!topicId || !instantEl) return;

    const data = await getTopicJson(topicId);
    if (!data || generation !== openGeneration || activeTopicId !== topicId) return;

    // If the real page is already ready, skip the instant layer.
    if (iframeEl && sameTopic(loadedTopicUrl, url) && isIframeContentReady(iframeEl)) {
      return;
    }

    renderInstantView(data);
    hideLoading(true);
  }

  function renderInstantView(data) {
    const posts = (data.post_stream && data.post_stream.posts) || [];
    const visiblePosts = posts.slice(0, INSTANT_POST_LIMIT);
    const title = escapeHtml(data.title || '帖子详情');

    panelEl.querySelector('.lsr-title').textContent = data.title || 'LinuxDo Side Reader';
    panelEl.querySelector('.lsr-title').title = data.title || 'LinuxDo Side Reader';

    const postsHtml = visiblePosts.map((post) => {
      const username = escapeHtml(post.username || post.name || 'user');
      const avatar = resolveAvatarUrl(post.avatar_template, 45);
      const cooked = post.cooked || '';
      const postNumber = post.post_number || '';
      const created = formatTime(post.created_at);
      return `
        <article class="lsr-post">
          <header class="lsr-post-header">
            <img class="lsr-avatar" src="${escapeAttr(avatar)}" alt="" width="36" height="36" loading="lazy">
            <div class="lsr-post-meta">
              <span class="lsr-username">${username}</span>
              <span class="lsr-post-sub">#${postNumber} · ${escapeHtml(created)}</span>
            </div>
          </header>
          <div class="lsr-post-body">${cooked}</div>
        </article>
      `;
    }).join('');

    instantEl.innerHTML = `
      <div class="lsr-instant-inner">
        <div class="lsr-instant-banner">极速预览 · 完整页面加载中</div>
        <h1 class="lsr-instant-title">${title}</h1>
        <div class="lsr-instant-posts">${postsHtml || '<p class="lsr-instant-empty">暂无内容</p>'}</div>
      </div>
    `;
    instantEl.style.display = '';

    // Double rAF to let the browser paint content before fading in.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (generation !== openGeneration) return;
        instantEl.classList.add('lsr-instant-visible');
      });
    });
  }

  function hideInstant() {
    if (!instantEl) return;
    // Fade out the instant layer.
    instantEl.classList.remove('lsr-instant-visible');
  }

  function clearInstantContent() {
    if (!instantEl) return;
    instantEl.classList.remove('lsr-instant-visible');
    instantEl.innerHTML = '';
  }

  function resolveAvatarUrl(template, size) {
    if (!template) return '';
    const path = String(template).replace(/\{size\}/g, String(size || 45));
    try {
      return new URL(path, window.location.origin).href;
    } catch (error) {
      return path;
    }
  }

  function formatTime(value) {
    if (!value) return '';
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
    } catch (error) {
      return String(value);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function navigateIframeToTopic(url, generation, options = {}) {
    ensureShell({ url });
    if (!iframeEl) return;

    const normalizedUrl = normalizeTopicUrl(url);
    const path = topicPath(normalizedUrl);

    // Already on this topic inside the iframe.
    if (sameTopic(loadedTopicUrl, normalizedUrl) && isIframeContentReady(iframeEl)) {
      if (!options.silent) {
        hideInstant();
        hideLoading(true);
        iframeEl.style.visibility = '';
      }
      return;
    }

    // Prefer Discourse client-side routing (keeps warm SPA, much faster).
    if (tryDiscourseRouteTo(iframeEl, path, normalizedUrl)) {
      loadedTopicUrl = '';
      return;
    }

    // If the iframe is still on about:blank / empty, or SPA not ready, hard navigate.
    try {
      const current = iframeEl.contentWindow?.location?.href || '';
      if (!shellReady || !current || current === 'about:blank') {
        iframeEl.src = normalizedUrl;
        loadedTopicUrl = '';
        return;
      }

      // Same-origin assign still reuses process; better than destroy/recreate.
      if (!sameTopic(current, normalizedUrl)) {
        iframeEl.contentWindow.location.assign(normalizedUrl);
        loadedTopicUrl = '';
      }
    } catch (error) {
      iframeEl.src = normalizedUrl;
      loadedTopicUrl = '';
    }
  }

  function tryDiscourseRouteTo(iframe, path, fullUrl) {
    try {
      const win = iframe.contentWindow;
      if (!win) return false;

      // Common Discourse globals / modules.
      if (win.DiscourseURL && typeof win.DiscourseURL.routeTo === 'function') {
        win.DiscourseURL.routeTo(path);
        return true;
      }

      if (typeof win.require === 'function') {
        try {
          const urlMod = win.require('discourse/lib/url');
          const DiscourseURL = urlMod && (urlMod.default || urlMod);
          if (DiscourseURL && typeof DiscourseURL.routeTo === 'function') {
            DiscourseURL.routeTo(path);
            return true;
          }
        } catch (error) {
          // module not available yet
        }
      }

      // Ember router fallback.
      if (win.Discourse && win.Discourse.__container__) {
        const router = win.Discourse.__container__.lookup('router:main');
        if (router && typeof router.transitionTo === 'function') {
          // topic route needs id; path transition is safer via URL.
          if (typeof router.handleURL === 'function') {
            router.handleURL(path);
            return true;
          }
        }
      }
    } catch (error) {
      // fall through to hard navigation
    }
    return false;
  }

  function isDiscourseAppReady(iframe) {
    try {
      const win = iframe?.contentWindow;
      if (!win) return false;
      if (win.DiscourseURL && typeof win.DiscourseURL.routeTo === 'function') return true;
      if (win.Discourse && win.Discourse.__container__) return true;
      if (typeof win.require === 'function') {
        try {
          const urlMod = win.require('discourse/lib/url');
          if (urlMod) return true;
        } catch (error) {
          return false;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
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

  function startLoadingWatch(url, generation) {
    stopLoadingWatch();
    loadingWatchTimer = window.setInterval(() => {
      if (generation !== openGeneration || activeTopicUrl !== url) {
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

  function isIframeContentReady(iframe) {
    try {
      const iframeDoc = iframe?.contentDocument;
      if (!iframeDoc) return false;

      const hasRenderableContent = Boolean(iframeDoc.querySelector(CONTENT_READY_SELECTOR));
      const bodyReady = Boolean(iframeDoc.body && iframeDoc.body.childElementCount > 0);
      return hasRenderableContent || (bodyReady && iframeDoc.readyState === 'complete');
    } catch (error) {
      return false;
    }
  }

  function tryRevealContent(url) {
    try {
      if (!iframeEl || activeTopicUrl !== url) return false;

      syncIframeLayout();
      shellReady = shellReady || isDiscourseAppReady(iframeEl);

      // For SPA navigations, wait until the topic id in the iframe matches.
      const iframeHref = safeIframeHref(iframeEl);
      const topicMatched = !iframeHref || sameTopic(iframeHref, url) || sameTopic(loadedTopicUrl, url);

      if (topicMatched && isIframeContentReady(iframeEl)) {
        loadedTopicUrl = url;
        // Full page ready: hand off from instant preview.
        hideInstant();
        hideLoading(false);
        iframeEl.style.visibility = '';
        return true;
      }
    } catch (error) {
      console.warn('[LinuxDo Side Reader] Failed to reveal iframe content early:', error);
    }

    return false;
  }

  function safeIframeHref(iframe) {
    try {
      return iframe?.contentWindow?.location?.href || '';
    } catch (error) {
      return '';
    }
  }

  function injectLayoutIntoDoc(iframeDoc) {
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
  }

  function syncIframeLayout() {
    try {
      injectLayoutIntoDoc(iframeEl?.contentDocument);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
