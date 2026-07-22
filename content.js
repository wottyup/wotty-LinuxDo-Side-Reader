/**
 * LinuxDo Side Reader - content script (v0.0.31 双栏视图)
 *
 * 把 linux.do 页面改成双栏：
 *   列表页 → 当前页(列表)在左半，右半 iframe 显示被点击的帖子。
 *   帖子页 → 当前页(帖子)在右半，左半 iframe 加载 /latest。
 *
 * 不移动 Discourse 的 DOM，只用 CSS 收窄当前页 + position:fixed 的 iframe 盖住另一半。
 */

(function () {
  'use strict';

  const TOPIC_LINK_PATTERN = /^https?:\/\/linux\.do\/t\/[^/]+\/\d+/;
  const TOPIC_ID_PATTERN = /\/t\/[^/]+\/(\d+)/;
  const CONTENT_READY_SELECTOR = '#topic-title, .topic-post, .topic-area, .timeline-container';
  const IFRAME_STYLE_ID = 'linuxdo-side-reader-iframe-style';
  const SPLIT_RATIO_STORAGE_KEY = 'linuxdo-side-reader-split-ratio';
  const COLLAPSED_STORAGE_KEY = 'linuxdo-side-reader-collapsed';
  const HOST_URL = 'https://linux.do/latest';
  const IFRAME_SANDBOX = 'allow-same-origin allow-scripts allow-popups allow-forms';
  const WATCH_INTERVAL_MS = 80;
  const MIN_RATIO = 0.2;
  const MAX_RATIO = 0.8;

  // 注入到 iframe 内的布局样式：只隐藏左侧主侧边栏，保留 Discourse 原生加载图标（logo + 蓝点）
  const IFRAME_LAYOUT_STYLE = `
    html, body { overscroll-behavior: contain !important; }
    :root {
      --d-sidebar-width: 0px !important;
      --d-sidebar-width-desktop: 0px !important;
    }
    .d-sidebar, .sidebar-wrapper, .sidebar-container, .admin-sidebar, .sidebar-pane { display: none !important; }
    .timeline-container { display: flex !important; visibility: visible !important; opacity: 1 !important; }
    .topic-navigation { display: flex !important; visibility: visible !important; opacity: 1 !important; }
    .topic-timeline, .topic-map { display: block !important; visibility: visible !important; opacity: 1 !important; }
  `;

  let paneEl = null;
  let bodyEl = null;
  let iframeEl = null;
  let loadingEl = null;
  let loadingTextEl = null;
  let newtabBtnEl = null;
  let titleEl = null;
  let expandBtnEl = null;
  let splitterEl = null;

  let isTopicPage = false;
  let collapsed = false;
  let loadedTopicUrl = '';
  let activeTopicUrl = '';
  let watchTimer = 0;
  let cssInjectTimer = 0;
  let iframeClickBound = false;

  // ---- init ----

  function init() {
    if (document.documentElement.classList.contains('lsr-split')) return;

    isTopicPage = /\/t\//.test(location.pathname);
    document.documentElement.classList.add('lsr-split', isTopicPage ? 'lsr-split-topic' : 'lsr-split-list');

    collapsed = readCollapsed();
    applySavedRatio();
    createPane();
    bindEvents();

    if (isTopicPage) {
      // 左栏 iframe 直接显示 /latest：露出 Discourse 原生加载图标，内容就绪后继续显示
      titleEl.textContent = '帖子列表';
      newtabBtnEl.href = HOST_URL;
      hideOverlay();
      ensureIframe(HOST_URL);
      showIframeNativeLoading();
      startEarlyCssInject();
      watchReady(() => { /* 原生 splash 会自行消失 */ });
    } else {
      // 右栏先占位，等点击帖子再加载
      titleEl.textContent = 'LinuxDo Side Reader';
      newtabBtnEl.href = HOST_URL;
      showPlaceholder();
      ensureIframe(HOST_URL); // 预热 /latest（被占位层盖住）
    }

    if (collapsed) applyCollapsed();
    installUrlWatcher();
  }

  // ---- DOM ----

  function createPane() {
    paneEl = document.createElement('div');
    paneEl.className = 'lsr-pane';
    paneEl.innerHTML = `
      <div class="lsr-header">
        <span class="lsr-title" title="LinuxDo Side Reader">LinuxDo Side Reader</span>
        <div class="lsr-actions">
          <a class="lsr-btn lsr-btn-newtab" href="#" title="在新标签页中打开" target="_blank" rel="noreferrer noopener">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9 1h6v6h-2V4.4L7.7 9.7 6.3 8.3 11.6 3H9V1zM3 3h4v2H3v8h8V9h2v6H1V3h2z"/>
            </svg>
          </a>
          <button class="lsr-btn lsr-btn-collapse" title="折叠双栏 (Esc)">⇥</button>
        </div>
      </div>
      <div class="lsr-body">
        <div class="lsr-loading lsr-placeholder">
          <span class="lsr-loading-text">点击左侧帖子开始阅读</span>
        </div>
      </div>
      <div class="lsr-splitter" title="拖拽调整两栏比例"></div>
    `;
    document.body.appendChild(paneEl);

    bodyEl = paneEl.querySelector('.lsr-body');
    loadingEl = paneEl.querySelector('.lsr-loading');
    loadingTextEl = paneEl.querySelector('.lsr-loading-text');
    newtabBtnEl = paneEl.querySelector('.lsr-btn-newtab');
    titleEl = paneEl.querySelector('.lsr-title');
    splitterEl = paneEl.querySelector('.lsr-splitter');
    paneEl.querySelector('.lsr-btn-collapse').addEventListener('click', setCollapsed);

    // 独立的展开按钮（折叠时显示）
    expandBtnEl = document.createElement('button');
    expandBtnEl.className = 'lsr-expand';
    expandBtnEl.title = '展开双栏';
    expandBtnEl.textContent = '⇤';
    expandBtnEl.addEventListener('click', setExpanded);
    document.body.appendChild(expandBtnEl);
  }

  // ---- events ----

  function bindEvents() {
    // 列表模式：拦截当前页 /t/ 链接，在右栏 iframe 打开
    document.addEventListener('click', handleLinkClick, true);
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setCollapsed();
    });

    window.addEventListener('resize', syncRatioToViewport);
    initResize();
  }

  function findTopicLink(target) {
    if (!(target instanceof Element)) return null;
    const link = target.closest('a[href]');
    if (!link) return null;
    if (!TOPIC_LINK_PATTERN.test(link.href)) return null;
    return link;
  }

  function normalizeUrl(url) { return new URL(url, window.location.href).href; }
  function topicIdOf(url) { const m = String(url).match(TOPIC_ID_PATTERN); return m ? m[1] : ''; }
  function sameTopic(a, b) {
    const idA = topicIdOf(a), idB = topicIdOf(b);
    return Boolean(idA && idB && idA === idB);
  }

  // ---- warmup (列表模式专用) ----

  function handlePointerOver(e) {
    if (isTopicPage) return;
    const link = findTopicLink(e.target);
    if (!link) return;
    warmupToTopic(link.href);
  }

  function handleTouchStart(e) {
    if (isTopicPage) return;
    const link = findTopicLink(e.target);
    if (!link) return;
    warmupToTopic(link.href);
  }

  function handleLinkClick(e) {
    if (isTopicPage) return; // 帖子模式不在当前页拦截
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;

    const link = findTopicLink(e.target);
    if (!link) return;
    if (paneEl && paneEl.contains(link)) return;

    const url = normalizeUrl(link.href);
    warmupToTopic(url);

    e.preventDefault();
    e.stopPropagation();
    openTopic(url);
  }

  function warmupToTopic(url) {
    const normalized = normalizeUrl(url);
    if (!TOPIC_LINK_PATTERN.test(normalized)) return;
    if (loadedTopicUrl && sameTopic(loadedTopicUrl, normalized)) return;
    ensureIframe();
    navigateIframeTo(normalized);
  }

  // ---- 打开帖子到右栏（列表模式）----

  function openTopic(url) {
    const normalized = normalizeUrl(url);
    activeTopicUrl = normalized;
    newtabBtnEl.href = normalized;
    updateTitle(normalized);

    if (isIframeReady(iframeEl) && sameTopic(loadedTopicUrl, normalized)) {
      mountIframe();
      hideOverlay();
      return;
    }

    // 露出 iframe，使用 Discourse 原生加载图标（logo + 蓝点）
    mountIframe();
    hideOverlay();
    showIframeNativeLoading();
    if (!sameTopic(safeIframeHref(iframeEl), normalized)) {
      navigateIframeTo(normalized);
    }
    watchTopic(normalized, () => {
      loadedTopicUrl = normalized;
      // 原生 splash 会自行消失，这里只确保 iframe 可见
      if (iframeEl) iframeEl.style.visibility = '';
    });
  }

  // ---- iframe 生命周期 ----

  function ensureIframe(url) {
    if (iframeEl) return iframeEl;
    const f = document.createElement('iframe');
    f.className = 'lsr-iframe';
    f.setAttribute('sandbox', IFRAME_SANDBOX);
    // 默认可见，让 Discourse 原生启动页（logo + 蓝点）直接展示
    f.addEventListener('load', onIframeLoad);
    f.addEventListener('error', () => { loadedTopicUrl = ''; });
    bodyEl.appendChild(f);
    iframeEl = f;
    f.src = url || HOST_URL;
    return f;
  }

  function mountIframe() {
    if (!iframeEl || !bodyEl) return;
    if (iframeEl.parentElement === bodyEl) return;
    bodyEl.insertBefore(iframeEl, loadingEl || null);
  }

  function onIframeLoad() {
    if (!iframeEl) return;
    injectLayoutIntoDoc(iframeEl.contentDocument);

    if (isTopicPage) {
      // 左栏 /latest：绑定拦截；提前注入的 CSS 只挡侧边栏，保留原生 splash
      bindIframeClickCapture();
      injectLayoutIntoDoc(iframeEl.contentDocument);
    } else if (activeTopicUrl) {
      // 列表模式：整页 reload 后的 load 事件
      injectLayoutIntoDoc(iframeEl.contentDocument);
      watchTopic(activeTopicUrl, () => {
        loadedTopicUrl = activeTopicUrl;
        if (iframeEl) iframeEl.style.visibility = '';
      });
    }
  }

  function navigateIframeTo(url) {
    if (!iframeEl) return;
    const normalized = normalizeUrl(url);
    if (tryDiscourseRoute(iframeEl.contentWindow, normalized)) {
      loadedTopicUrl = '';
      return;
    }
    try {
      const current = iframeEl.contentWindow?.location?.href || '';
      if (current === 'about:blank' || !current) iframeEl.src = normalized;
      else if (!sameTopic(current, normalized)) iframeEl.contentWindow.location.assign(normalized);
    } catch (_) {
      iframeEl.src = normalized;
    }
    // 整页 reload 回退：尽早注入 CSS，避免侧边栏先渲染再被隐藏的闪烁
    startEarlyCssInject();
    loadedTopicUrl = '';
  }

  function tryDiscourseRoute(win, url) {
    try {
      if (!win) return false;
      const path = new URL(url, window.location.origin).pathname + window.location.search + window.location.hash;
      if (win.DiscourseURL && typeof win.DiscourseURL.routeTo === 'function') { win.DiscourseURL.routeTo(path); return true; }
      if (typeof win.require === 'function') {
        try {
          const mod = win.require('discourse/lib/url');
          const URL = mod && (mod.default || mod);
          if (URL && typeof URL.routeTo === 'function') { URL.routeTo(path); return true; }
        } catch (_) {}
      }
      if (win.Discourse && win.Discourse.__container__) {
        const router = win.Discourse.__container__.lookup('router:main');
        if (router && typeof router.handleURL === 'function') { router.handleURL(path); return true; }
      }
    } catch (_) {}
    return false;
  }

  // ---- 帖子模式：拦截左栏 iframe 内 /t/ 点击，路由顶层窗口 ----

  function bindIframeClickCapture() {
    if (!isTopicPage || !iframeEl || iframeClickBound) return;
    const doc = iframeEl.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', onIframeClick, true);
    iframeClickBound = true;
  }

  function onIframeClick(e) {
    const link = e.target?.closest?.('a[href]');
    if (!link) return;
    if (!TOPIC_LINK_PATTERN.test(link.href)) return; // 非 /t/ 链接让 iframe 自行导航
    e.preventDefault();
    e.stopPropagation();
    routeTopToTopic(link.href);
  }

  function routeTopToTopic(url) {
    const normalized = normalizeUrl(url);
    const path = new URL(normalized, window.location.origin).pathname;
    if (window.DiscourseURL && typeof window.DiscourseURL.routeTo === 'function') {
      try { window.DiscourseURL.routeTo(path); return; } catch (_) {}
    }
    window.location.assign(normalized); // 回退：整页刷新，重 init 仍为帖子模式
  }

  // ---- loading / placeholder ----
  // 加载态不再画自定义转圈：直接露出 iframe，使用 Discourse 原生加载图标。
  // 我们的覆盖层只用于「空闲占位」提示。

  function showIframeNativeLoading() {
    if (iframeEl) iframeEl.style.visibility = '';
    hideOverlay();
  }

  function showPlaceholder() {
    if (!loadingEl) return;
    if (loadingTextEl) loadingTextEl.textContent = '点击左侧帖子开始阅读';
    loadingEl.style.display = 'flex';
    requestAnimationFrame(() => loadingEl.classList.remove('lsr-overlay-hidden'));
    // 占位时 iframe 仍在预热，但被覆盖层挡住
    if (iframeEl) iframeEl.style.visibility = 'hidden';
  }

  function hideOverlay() {
    if (!loadingEl) return;
    loadingEl.classList.add('lsr-overlay-hidden');
    loadingEl.style.display = 'none';
  }

  // ---- readiness watch ----

  function watchReady(onReady) {
    stopWatch();
    watchTimer = window.setInterval(() => {
      if (isIframeReady(iframeEl)) { stopWatch(); onReady(); }
    }, WATCH_INTERVAL_MS);
  }

  // 独立定时器轮询注入 CSS（不干扰 watchTimer）。不揭开 iframe——揭开由 watchReady/watchTopic 负责。
  function startEarlyCssInject() {
    stopCssInject();
    let tries = 0;
    const MAX = 80; // ~4s
    cssInjectTimer = window.setInterval(() => {
      if (!iframeEl) { stopCssInject(); return; }
      const doc = iframeEl.contentDocument;
      if (doc && (doc.head || doc.documentElement)) injectLayoutIntoDoc(doc);
      if (++tries >= MAX) stopCssInject();
    }, 50);
  }

  function stopCssInject() {
    if (!cssInjectTimer) return;
    window.clearInterval(cssInjectTimer);
    cssInjectTimer = 0;
  }

  function watchTopic(url, onReady) {
    stopWatch();
    watchTimer = window.setInterval(() => {
      if (activeTopicUrl !== url) { stopWatch(); return; }
      const href = safeIframeHref(iframeEl);
      const matched = !href || sameTopic(href, url) || sameTopic(loadedTopicUrl, url);
      if (matched && isIframeReady(iframeEl)) { stopWatch(); onReady(); }
    }, WATCH_INTERVAL_MS);
  }

  function stopWatch() {
    if (!watchTimer) return;
    window.clearInterval(watchTimer);
    watchTimer = 0;
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

  function updateTitle(url) {
    let text = '帖子详情';
    const link = document.querySelector(`a[href="${url}"]`);
    if (link) {
      const titleEl2 = link.closest('.topic-list-item, .latest-topic-list-item')
        ?.querySelector('.main-link a, .link-bottom-line a, a.title');
      text = titleEl2 ? titleEl2.textContent.trim() : link.textContent.trim().slice(0, 50);
    }
    titleEl.textContent = text || 'LinuxDo Side Reader';
    titleEl.title = text || 'LinuxDo Side Reader';
  }

  // ---- 折叠 / 展开 ----

  function setCollapsed() {
    collapsed = true;
    persistCollapsed();
    applyCollapsed();
  }
  function setExpanded() {
    collapsed = false;
    persistCollapsed();
    applyCollapsed();
  }
  function applyCollapsed() {
    document.documentElement.classList.toggle('lsr-collapsed', collapsed);
  }
  function readCollapsed() {
    try { return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'; } catch (_) { return false; }
  }
  function persistCollapsed() {
    try { window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }

  // ---- 分隔条拖拽 / 比例持久化 ----

  function initResize() {
    let startX = 0, startW = 0;
    splitterEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = paneWidthPx();
      document.body.classList.add('lsr-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
      let w = isTopicPage ? startW + (e.clientX - startX) : startW + (startX - e.clientX);
      setPaneWidthPx(clampPaneWidth(w));
    }
    function onUp() {
      document.body.classList.remove('lsr-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistRatio();
    }
  }

  function paneWidthPx() {
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lsr-pane-w'));
    return Number.isFinite(w) ? w : Math.round(window.innerWidth * 0.5);
  }

  function setPaneWidthPx(w) {
    document.documentElement.style.setProperty('--lsr-pane-w', Math.round(w) + 'px');
  }

  function clampPaneWidth(w) {
    return Math.min(Math.max(w, Math.round(window.innerWidth * MIN_RATIO)), Math.round(window.innerWidth * MAX_RATIO));
  }

  function applySavedRatio() {
    const r = readRatio();
    setPaneWidthPx(Math.round((r == null ? 0.5 : r) * window.innerWidth));
  }

  function syncRatioToViewport() {
    setPaneWidthPx(clampPaneWidth(paneWidthPx()));
    persistRatio();
  }

  function readRatio() {
    try {
      const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
      if (!raw) return null;
      const r = parseFloat(raw);
      return Number.isFinite(r) ? Math.min(Math.max(r, MIN_RATIO), MAX_RATIO) : null;
    } catch (_) { return null; }
  }

  function persistRatio() {
    try {
      const r = paneWidthPx() / window.innerWidth;
      window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(r));
    } catch (_) {}
  }

  // ---- URL 监听：模式翻转时整页重载以重 init ----

  function installUrlWatcher() {
    let lastPath = location.pathname;
    const check = () => {
      const p = location.pathname;
      if (p === lastPath) return;
      lastPath = p;
      if (isTopicPage !== /\/t\//.test(p)) location.reload();
    };
    window.addEventListener('popstate', check);
    const wrap = (key) => {
      const orig = history[key];
      if (typeof orig !== 'function') return;
      history[key] = function (...args) {
        const r = orig.apply(this, args);
        window.setTimeout(check, 0);
        return r;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();