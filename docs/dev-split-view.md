# 开发文档：双栏视图改造 (v0.0.31)

## 目标

把插件从「右侧滑出面板」改造为「页面直接双栏」：
- 列表页：当前页（列表）在左半，右半用 iframe 显示被点击的帖子。
- 帖子页：当前页（帖子）在右半，左半用 iframe 加载 `/latest`。

语义：**当前页面属于哪一边就放在哪一边，另一边用 iframe 补齐。**

## 实现步骤

### 1. 模式判定
- `isTopicPage = /\/t\//.test(location.pathname)`
- 列表页 → `<html>` 加 class `lsr-split lsr-split-list`
- 帖子页 → `<html>` 加 class `lsr-split lsr-split-topic`
- SPA 路由后 content script 不重跑，class 保留即可；若从列表页 SPA 跳到帖子页（点击非 /t/ 链接导致的整页 SPA 导航），需要监听并切换模式。

### 2. 布局（styles.css）
不移动 Discourse DOM，用 CSS 收窄当前页 + fixed iframe 盖另一半：
- CSS 变量 `--lsr-pane-w`（默认 50vw，持久化）控制 iframe 那一半宽度。
- 列表模式：`body.lsr-split-list { margin-right: var(--lsr-pane-w) }`；iframe `right:0; width:var(--lsr-pane-w)`。
- 帖子模式：`body.lsr-split-topic { margin-left: var(--lsr-pane-w) }`；iframe `left:0; width:var(--lsr-pane-w)`。
- 分隔条 `.lsr-splitter` 固定在 iframe 边界，col-resize，拖拽改 `--lsr-pane-w`。
- 折叠：`lsr-collapsed` class 隐藏 iframe、移除 body margin、恢复整页。Esc / 折叠按钮切换。
- loading 层绝对定位覆盖 iframe 区域。

### 3. iframe 复用
保留：`TOPIC_LINK_PATTERN`、`TOPIC_ID_PATTERN`、`HOST_URL`、`ensureIframe`、`onIframeLoad`、`navigateIframeTo`、`tryDiscourseRoute`、`sameTopic`、`isIframeReady`、`tryReveal`、`startLoadingWatch/stopLoadingWatch`、`injectLayoutIntoDoc`、`safeIframeHref`、loading。
去掉：overlay、滑入动画、openShell/closePanel、离屏 host mount/park。

### 4. 事件拦截
- **列表模式**：拦截当前页 `/t/` 链接点击 → preventDefault → navigate iframe 到帖子 → 右栏 loading 直到 ready。
- **帖子模式**：`onIframeLoad` 给 `iframeEl.contentDocument` 加 capture click 监听（同源可访问），命中 `/t/` 链接 preventDefault，调用顶层 `window.DiscourseURL.routeTo(path)` 把右半 SPA 切到新帖子；左栏 iframe 保持 /latest。

### 5. resize
拖拽分隔条改 `--lsr-pane-w`，clamp 到 [20vw, 80vw]，持久化 `linuxdo-side-reader-split-ratio`。

## 风险与回退
1. SPA 路由后脚本不重跑 → class 与 iframe 保留，布局稳定。
2. iframe 内拦截失败 → 回退 `window.location.assign`（整页刷新，落到帖子页，双栏重 init）。
3. fixed header 被盖一半 → iframe 内自有 header 承担，可在 `IFRAME_LAYOUT_STYLE` 扩展隐藏。
4. 窗口窄 → clamp 最小 20vw。

## 验证
1. 重新加载扩展。
2. `/latest`：左半列表 + 右半占位；点帖子右半加载；点另一个右半切换。
3. `/t/.../123`：右半当前帖 + 左半 /latest；左半点帖右半 SPA 切换、左半不变。
4. 拖拽分隔条改比例、刷新保留。
5. 折叠按钮/Esc 收起恢复整页、再展开恢复。
6. 深色模式正常。

## v0.0.32 加载体验修复
- **慢**：帖子页左栏 /latest 改为 `earlyInjectAndReveal`——文档可用即揭示 iframe，不再等到 `readyState=complete`。
- **多个加载图标**：`IFRAME_LAYOUT_STYLE` 增加 `.loading-container/.spinner-container/.skeleton-loader/.topic-list-skeleton` 等 `display:none`，隐藏 iframe 内 Discourse 自带加载层。
- **侧边栏闪烁**：独立 `cssInjectTimer` 在导航后立即轮询 `contentDocument` 注入 CSS（`startEarlyCssInject`），在 Discourse 渲染侧边栏前生效；侧边栏选择器加宽到 `.d-sidebar/.sidebar-wrapper/.sidebar-container/.admin-sidebar/.sidebar-pane`。
- 去掉 body margin 过渡，避免主页面收窄时滑动。
## v0.0.43 响应式与底部空白修复
- **底部空白**：iframe 内 Discourse 的 `#main-outlet` / `#main-outlet-wrapper` 带 `min-height` 占位，全屏/高窗口下短帖子下方留出很高空白。在 `IFRAME_LAYOUT_STYLE` 中对 `#main-outlet` / `#main-outlet-wrapper` / `.container.posts` / `.topic-area` 强制 `min-height:0; height:auto`，`#main-outlet-wrapper` 改 `flex:1 1 auto`，`html,body` 取消 `min-height`。
- **宽度不响应**：拖拽分隔条或窗口缩放时 iframe 尺寸虽变，但 Discourse 内部布局不会自动重排。新增 `notifyIframeResize()`，在 `syncRatioToViewport` 和拖拽 `onMove` 中向 `iframeEl.contentWindow` 派发 `resize` 事件，触发 Discourse 内部重排。
