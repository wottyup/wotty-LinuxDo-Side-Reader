/**
 * LinuxDo Side Reader - 早期注入 (document_start)
 * 在首次绘制前给 <html> 加上双栏 class 和宽度变量，
 * 让页面一开始就按双栏布局渲染，避免「先全宽再跳成两半」的闪动。
 */
(function () {
  'use strict';

  const SPLIT_RATIO_STORAGE_KEY = 'linuxdo-side-reader-split-ratio';
  const COLLAPSED_STORAGE_KEY = 'linuxdo-side-reader-collapsed';
  const MIN_RATIO = 0.2;
  const MAX_RATIO = 0.8;

  const de = document.documentElement;
  if (!de || de.classList.contains('lsr-split')) return;

  const isTopicPage = /\/t\//.test(location.pathname);
  de.classList.add('lsr-split', isTopicPage ? 'lsr-split-topic' : 'lsr-split-list');

  // 读取持久化的比例，换算成像素写进 CSS 变量
  let r = 0.5;
  try {
    const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) r = Math.min(Math.max(n, MIN_RATIO), MAX_RATIO);
    }
  } catch (_) {}
  de.style.setProperty('--lsr-pane-w', Math.round(r * window.innerWidth) + 'px');

  // 折叠态
  try {
    if (window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1') {
      de.classList.add('lsr-collapsed');
    }
  } catch (_) {}
})();