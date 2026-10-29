/**
 * Reader PDF 阅读器（v0.0.6）
 * ---------------------------------------------------------------------------
 * 传统浏览器脚本（无构建、无模块化依赖），挂载为 window.ReaderPdfReader。
 * 职责：在滚动容器内连续渲染 PDF 页面（高清 canvas + 可选文本层），
 *       提供懒渲染/释放、适应宽度与缩放、跳页、当前页/进度回调、高亮回调。
 *
 * 依赖运行期全局：window.ReaderPdfLoader
 *   { load(): Promise<pdfjs 模块>, getAssetUrls(): {cMapUrl, standardFontDataUrl}, VERSION, reset() }
 * pdf.js 版本约定为 pdfjs-dist 4.2.67，使用其 ESM 命名导出：
 *   getDocument / renderTextLayer / setLayerDimensions / Util 等。
 *
 * 对外 API：
 *   window.ReaderPdfReader.create(container, options) -> instance
 *   instance: open / goToPage / setZoom / getCurrentPage / getScale /
 *             getPageCount / resize / destroy / isOpen
 *
 * DOM 契约（app.js 依赖）：
 *   container.pdf-pane
 *     .pdf-viewer[data-page-count]
 *       .pdf-page[data-page][data-rendered]
 *         canvas.pdf-canvas
 *         .pdf-text-layer[lang]
 *         .pdf-page-loading > .pdf-spinner
 *         .pdf-page-num
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ================= 常量与工具 ================= */

  const VERSION = '0.0.6';

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3;
  const ZOOM_STEP = 1.2;
  const ZOOM_OUT_FACTOR = 0.8;
  const MAX_DPR = 2;
  // 单页位图上限（约 16MP）。极端放大时按需降低 dpr，避免一页吃掉数百 MB
  const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
  // 同时最多保留的已渲染页数
  const MAX_RENDERED_PAGES = 8;
  // 适应宽度时左右留白总和
  const FIT_PADDING = 48;
  // 进度回调节流间隔
  const PROGRESS_DELAY = 300;
  // 窗口尺寸变化后延迟重渲染，避免连续 resize 时反复取消渲染
  const RESIZE_RERENDER_DELAY = 120;
  // 容器尺寸监听：忽略滚动条出现/消失造成的十几像素变化，避免 fit 计算来回抖动
  const CONTAINER_RESIZE_MIN_DELTA = 20;
  const CONTAINER_RESIZE_DELAY = 120;
  // 懒渲染观察范围（与 _shouldRender 的 1.5 屏余量一致）
  const OBSERVER_MARGIN = '150% 0px 150% 0px';

  const isFn = (value) => typeof value === 'function';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const round2 = (value) => Math.round(value * 100) / 100;

  const round3 = (value) => Math.round(value * 1000) / 1000;

  const parsePx = (value, fallback) => {
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : fallback;
  };

  const toPageNumber = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.round(num) : fallback;
  };

  // pdf.js 取消渲染任务时抛出的异常不算错误
  const isCancelError = (err) => {
    const name = err && err.name;
    return name === 'RenderingCancelledException' || name === 'AbortException' || name === 'AbortError';
  };

  /* ================= 阅读器实例 ================= */

  class PdfReader {
    constructor(container, options) {
      if (!container || container.nodeType !== 1) {
        throw new TypeError('ReaderPdfReader.create: container 必须是 DOM 元素');
      }

      const opts = options || {};
      this.container = container;
      this.options = opts;
      this.bytes = opts.bytes || null;
      this.chapters = Array.isArray(opts.chapters) ? opts.chapters : [];
      this.lang = opts.lang === 'en' ? 'en' : 'zh';
      this.initialPage = toPageNumber(opts.initialPage, 1);
      this.zoomOption = opts.zoom === undefined ? 'fit-width' : opts.zoom;

      this.pageCount = Math.max(0, toPageNumber(opts.pageCount, 0));

      /* pdf.js 相关 */
      this.pdfjs = null;
      this.doc = null;
      this.loadingTask = null;

      /* DOM */
      this.viewer = null;
      this._loadingEl = null;
      this.pageEls = [];
      this.pageDims = [];
      this.pageTops = [];
      // 已渲染页的真实尺寸（scale=1 基准），用于缩放时避免回到第 1 页的估算值
      this._pageBaseSizes = new Map();

      /* 缩放与状态 */
      this.scale = 1;
      this._zoomMode = 'fit-width';
      if (typeof this.zoomOption === 'number' && Number.isFinite(this.zoomOption)) {
        this.scale = clamp(round3(this.zoomOption), MIN_SCALE, MAX_SCALE);
        this._zoomMode = 'custom';
      }
      this._opened = false;
      this._destroyed = false;
      this._openPromise = null;
      this._destroyPromise = null;

      /* 当前页/渲染状态 */
      this._currentPage = 1;
      this._rendered = new Set();
      this._renderedMetrics = new Map();
      this._renderJobs = new Map();
      this._renderQueue = [];
      this._pumping = false;
      this._renderTasks = new Map();
      this._textTasks = new Map();
      this._pages = new Map();
      this._failed = new Set();
      this._pinned = new Set();
      this._loadingPages = new Set();
      this._generation = 0;
      this._lastRenderDpr = 0;

      /* 计时器/监听 */
      this._observer = null;
      this._resizeObserver = null;
      this._observedWidth = 0;
      this._resizeTimer = 0;
      this._scrollHandler = null;
      this._scrollRaf = 0;
      this._progressTimer = 0;
      this._rerenderTimer = 0;

      /* 布局缓存（CSS 像素） */
      this._baseWidth = 612;
      this._baseHeight = 792;
      this._gap = 0;
      this._paddingTop = 0;
      this._paddingBottom = 0;
      this._viewerOffset = 0;
    }

    /* ================= 公开 API ================= */

    open() {
      if (this._destroyed) {
        return Promise.reject(new Error('阅读器已销毁'));
      }
      if (this._opened) {
        return Promise.resolve({ pageCount: this.pageCount, scale: this.scale });
      }
      if (!this._openPromise) {
        this._openPromise = this._doOpen().catch((err) => {
          // 失败后允许重新 open（例如更换 bytes 后重试）
          this._openPromise = null;
          throw err;
        });
      }
      return this._openPromise;
    }

    async goToPage(page, opts) {
      if (this._destroyed || !this._opened) return false;
      // opts.flash 为预留参数，当前忽略
      const target = clamp(toPageNumber(page, this._currentPage), 1, this.pageCount);
      this._pinned.add(target);
      try {
        await this._requestRender(target, true);
        if (this._destroyed || !this._opened) return false;
        this._relayout();
        this.container.scrollTop = Math.max(0, this._absolutePageTop(target));
        this._updateCurrentPage(false);
        this._scheduleProgress();
        return true;
      } finally {
        this._pinned.delete(target);
        this._evictPages();
      }
    }

    async setZoom(action) {
      if (this._destroyed || !this._opened) return;

      let next = null;
      let mode = this._zoomMode;
      if (action === 'fit-width') {
        next = this._computeFitScale();
        mode = 'fit-width';
      } else if (action === 'in') {
        next = this.scale * ZOOM_STEP;
        mode = 'custom';
      } else if (action === 'out') {
        next = this.scale * ZOOM_OUT_FACTOR;
        mode = 'custom';
      } else if (typeof action === 'number' && Number.isFinite(action)) {
        next = action;
        mode = 'custom';
      } else {
        return;
      }

      this._zoomMode = mode;
      const target = clamp(round3(next), MIN_SCALE, MAX_SCALE);
      if (Math.abs(target - this.scale) < 0.001) return;

      this._cancelRerenderTimer();
      const info = this._beginScaleUpdate(target, true);
      if (!info) return;
      await this._requestRender(info.anchorPage, true);
      if (this._destroyed || !this._opened) return;
      this._relayout();
      this.container.scrollTop = Math.max(0, this._absolutePageTop(info.anchorPage) + info.anchorDelta);
      this._updateCurrentPage(false);
      this._renderVisible();
      this._scheduleProgress();
    }

    getCurrentPage() {
      return this._currentPage;
    }

    getScale() {
      return this.scale;
    }

    getPageCount() {
      return this.pageCount;
    }

    resize() {
      if (this._destroyed || !this._opened || !this.viewer) return;
      // 容器隐藏（如切换视图）时宽度为 0，无法计算 fit-width，保持现状
      if (!(this.container.clientWidth > 0)) return;
      this._observedWidth = this.container.clientWidth;
      this._measureMetrics();

      let nextScale = this.scale;
      if (this._zoomMode === 'fit-width') {
        nextScale = this._computeFitScale();
      }
      const dpr = this._getDpr();
      const scaleChanged = Math.abs(nextScale - this.scale) > 0.001;

      if (scaleChanged || dpr !== this._lastRenderDpr) {
        this._cancelRerenderTimer();
        const info = this._beginScaleUpdate(nextScale, dpr !== this._lastRenderDpr);
        if (info) this._scheduleRerender(RESIZE_RERENDER_DELAY);
        return;
      }

      // 尺寸/清晰度均未变化：只重算布局偏移，保持当前页位置
      const anchorPage = this._currentPage;
      const oldTop = this._absolutePageTop(anchorPage);
      const anchorDelta = Math.max(0, this.container.scrollTop - oldTop);
      this._relayout();
      this.container.scrollTop = Math.max(0, this._absolutePageTop(anchorPage) + anchorDelta);
      this._updateCurrentPage(false);
      this._scheduleProgress();
    }

    destroy() {
      if (this._destroyPromise) return this._destroyPromise;
      this._destroyed = true;
      this._opened = false;

      const finish = async () => {
        if (this._observer) {
          try { this._observer.disconnect(); } catch (err) { /* 忽略 */ }
          this._observer = null;
        }
        if (this._resizeObserver) {
          try { this._resizeObserver.disconnect(); } catch (err) { /* 忽略 */ }
          this._resizeObserver = null;
        }
        if (this._resizeTimer) {
          window.clearTimeout(this._resizeTimer);
          this._resizeTimer = 0;
        }
        if (this._scrollHandler) {
          this.container.removeEventListener('scroll', this._scrollHandler);
          this._scrollHandler = null;
        }
        if (this._scrollRaf && isFn(window.cancelAnimationFrame)) {
          window.cancelAnimationFrame(this._scrollRaf);
          this._scrollRaf = 0;
        }
        if (this._progressTimer) {
          window.clearTimeout(this._progressTimer);
          this._progressTimer = 0;
        }
        this._cancelRerenderTimer();

        this._flushRenderQueue();
        this._cancelAllTasks();
        this._clearDomState();

        const loadingTask = this.loadingTask;
        this.loadingTask = null;
        this.doc = null;
        this.pdfjs = null;
        if (loadingTask && isFn(loadingTask.destroy)) {
          try { await loadingTask.destroy(); } catch (err) { /* 加载失败/已销毁 */ }
        }
      };

      this._destroyPromise = finish();
      return this._destroyPromise;
    }

    isOpen() {
      return this._opened && !this._destroyed;
    }

    /* ================= 打开流程 ================= */

    async _doOpen() {
      const bytes = this.bytes;
      if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
        throw new TypeError('ReaderPdfReader.open: options.bytes 必须是 Uint8Array');
      }
      if (!bytes.byteLength) {
        throw new Error('ReaderPdfReader.open: PDF 数据为空');
      }
      const loader = window.ReaderPdfLoader;
      if (!loader || !isFn(loader.load)) {
        throw new Error('ReaderPdfReader.open: 缺少 PDF 加载模块（ReaderPdfLoader）');
      }

      this._buildShell();
      try {
        this.pdfjs = await loader.load();
        if (this._destroyed) throw new Error('阅读器已销毁');
        if (!this.pdfjs || !isFn(this.pdfjs.getDocument)) {
          throw new Error('ReaderPdfReader.open: pdf.js 模块无效');
        }

        const assets = isFn(loader.getAssetUrls) ? (loader.getAssetUrls() || {}) : {};
        const params = { data: bytes };
        if (assets.cMapUrl) {
          params.cMapUrl = assets.cMapUrl;
          params.cMapPacked = true;
        }
        if (assets.standardFontDataUrl) {
          params.standardFontDataUrl = assets.standardFontDataUrl;
        }

        this.loadingTask = this.pdfjs.getDocument(params);
        this.doc = await this.loadingTask.promise;
        if (this._destroyed) throw new Error('阅读器已销毁');

        this.pageCount = this.doc.numPages;
        await this._initView();

        const startPage = clamp(this.initialPage, 1, this.pageCount);
        this._currentPage = startPage;
        this._opened = true;
        this._measureMetrics();
        this._relayout();

        this._pinned.add(startPage);
        try {
          await this._requestRender(startPage, true);
        } finally {
          this._pinned.delete(startPage);
        }
        if (this._destroyed) throw new Error('阅读器已销毁');

        // 首屏页真实尺寸已回填，重新定位到该页顶部
        this._relayout();
        this.container.scrollTop = Math.max(0, this._absolutePageTop(startPage));
        this._updateCurrentPage(false);
        this._renderVisible();
        this._scheduleProgress();

        const result = { pageCount: this.pageCount, scale: this.scale };
        this._notify('onReady', { pageCount: this.pageCount, scale: this.scale });
        this._notify('onPageChange', this._currentPage, this._chapterForPage(this._currentPage));
        return result;
      } catch (err) {
        this._cleanupFailedOpen();
        throw this._normalizeOpenError(err);
      }
    }

    // 把 pdf.js 的异常映射成 app 可识别的错误码（不改动原始错误信息）
    _normalizeOpenError(err) {
      if (!err || (err.code && typeof err.code === 'string')) return err;
      const name = err.name;
      if (name === 'PasswordException') err.code = 'encrypted';
      else if (name === 'InvalidPDFException') err.code = 'invalid';
      else if (name === 'MissingPDFException' || name === 'UnexpectedResponseException') err.code = 'unreadable';
      return err;
    }

    async _initView() {
      const firstPage = await this.doc.getPage(1);
      this._pages.set(1, firstPage);
      const baseViewport = firstPage.getViewport({ scale: 1 });
      this._baseWidth = baseViewport.width > 0 ? baseViewport.width : 612;
      this._baseHeight = baseViewport.height > 0 ? baseViewport.height : 792;

      // 先按 scale=1 占位，加入 DOM 后再按真实容器宽度计算实际缩放
      const fragment = document.createDocumentFragment();
      for (let page = 1; page <= this.pageCount; page++) {
        fragment.appendChild(this._createPageElement(page, this._baseWidth, this._baseHeight));
      }
      if (this._loadingEl) {
        this._loadingEl.remove();
        this._loadingEl = null;
      }
      this.viewer.dataset.pageCount = String(this.pageCount);
      this.viewer.appendChild(fragment);

      if (typeof this.zoomOption === 'number' && Number.isFinite(this.zoomOption)) {
        this.scale = clamp(round3(this.zoomOption), MIN_SCALE, MAX_SCALE);
        this._zoomMode = 'custom';
      } else {
        this.scale = this._computeFitScale();
        this._zoomMode = 'fit-width';
      }
      this._updateAllPageSizes();
      this._relayout();
      this._measureMetrics();

      this._scrollHandler = () => this._handleScroll();
      this.container.addEventListener('scroll', this._scrollHandler, { passive: true });

      // 侧栏/笔记面板开合会改变容器宽度但不触发 window.resize，这里兜底重新适应宽度
      this._observedWidth = this.container.clientWidth;
      if (isFn(window.ResizeObserver)) {
        this._resizeObserver = new window.ResizeObserver(() => this._handleContainerResize());
        this._resizeObserver.observe(this.container);
      }

      if (isFn(window.IntersectionObserver)) {
        this._observer = new window.IntersectionObserver((entries) => this._handleIntersect(entries), {
          root: this.container,
          rootMargin: OBSERVER_MARGIN,
          threshold: 0,
        });
        for (const pageEl of this.pageEls) this._observer.observe(pageEl);
      }
    }

    _buildShell() {
      this.container.classList.add('pdf-pane');
      this._clearContainer();
      this.container.scrollTop = 0;

      const viewer = document.createElement('div');
      viewer.className = 'pdf-viewer';
      viewer.dataset.pageCount = '0';

      const loading = document.createElement('div');
      loading.className = 'pdf-viewer-loading';
      loading.setAttribute('role', 'status');
      loading.appendChild(this._createSpinner());
      viewer.appendChild(loading);

      this.container.appendChild(viewer);
      this.viewer = viewer;
      this._loadingEl = loading;
    }

    _cleanupFailedOpen() {
      this._opened = false;
      if (this._observer) {
        try { this._observer.disconnect(); } catch (err) { /* 忽略 */ }
        this._observer = null;
      }
      if (this._resizeObserver) {
        try { this._resizeObserver.disconnect(); } catch (err) { /* 忽略 */ }
        this._resizeObserver = null;
      }
      if (this._resizeTimer) {
        window.clearTimeout(this._resizeTimer);
        this._resizeTimer = 0;
      }
      if (this._scrollHandler) {
        this.container.removeEventListener('scroll', this._scrollHandler);
        this._scrollHandler = null;
      }
      if (this._scrollRaf) {
        if (isFn(window.cancelAnimationFrame)) window.cancelAnimationFrame(this._scrollRaf);
        this._scrollRaf = 0;
      }
      if (this._progressTimer) {
        window.clearTimeout(this._progressTimer);
        this._progressTimer = 0;
      }
      this._cancelRerenderTimer();

      this._flushRenderQueue();
      this._cancelAllTasks();
      this._generation += 1;

      const loadingTask = this.loadingTask;
      this.loadingTask = null;
      this.doc = null;
      this.pdfjs = null;
      if (loadingTask && isFn(loadingTask.destroy)) {
        try {
          const result = loadingTask.destroy();
          if (result && isFn(result.catch)) result.catch(() => {});
        } catch (err) { /* 忽略 */ }
      }
      this._clearDomState();
    }

    /* ================= DOM 构建 ================= */

    _createPageElement(page, width, height) {
      const pageEl = document.createElement('div');
      pageEl.className = 'pdf-page';
      pageEl.dataset.page = String(page);
      pageEl.dataset.rendered = '0';
      pageEl.style.width = round2(width) + 'px';
      pageEl.style.height = round2(height) + 'px';
      pageEl.style.setProperty('--scale-factor', String(this.scale));

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';

      const textLayerEl = document.createElement('div');
      textLayerEl.className = 'pdf-text-layer';
      textLayerEl.lang = this.lang;
      textLayerEl.dir = 'ltr';

      const loadingEl = document.createElement('div');
      loadingEl.className = 'pdf-page-loading';
      loadingEl.appendChild(this._createSpinner());

      const numEl = document.createElement('div');
      numEl.className = 'pdf-page-num';
      numEl.textContent = String(page);

      pageEl.append(canvas, textLayerEl, loadingEl, numEl);

      this.pageEls.push(pageEl);
      this.pageDims.push({ width: round2(width), height: round2(height) });
      return pageEl;
    }

    _createSpinner() {
      const spinner = document.createElement('span');
      spinner.className = 'pdf-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      return spinner;
    }

    _clearContainer() {
      while (this.container.firstChild) {
        this.container.removeChild(this.container.firstChild);
      }
    }

    _clearDomState() {
      // 只移除本实例创建的 .pdf-viewer；避免旧实例的异步清理误删新实例/页面的 DOM
      const viewer = this.viewer;
      const ownsPane = !!(viewer && viewer.parentNode === this.container);
      if (viewer && viewer.parentNode) viewer.parentNode.removeChild(viewer);
      this.viewer = null;
      this._loadingEl = null;
      this._observedWidth = 0;
      if (ownsPane) this.container.classList.remove('pdf-pane');
      this.pageEls = [];
      this.pageDims = [];
      this.pageTops = [];
      this._pageBaseSizes.clear();
      this._rendered.clear();
      this._renderedMetrics.clear();
      this._renderJobs.clear();
      this._renderQueue.length = 0;
      this._renderTasks.clear();
      this._textTasks.clear();
      this._pages.clear();
      this._loadingPages.clear();
      this._pinned.clear();
    }

    /* ================= 布局与尺寸 ================= */

    _measureMetrics() {
      if (!this.viewer) return;
      const style = window.getComputedStyle(this.viewer);
      this._paddingTop = parsePx(style.paddingTop, 0);
      this._paddingBottom = parsePx(style.paddingBottom, 0);
      this._gap = parsePx(style.rowGap, 0);
      const containerRect = this.container.getBoundingClientRect();
      const viewerRect = this.viewer.getBoundingClientRect();
      this._viewerOffset = viewerRect.top - containerRect.top + this.container.scrollTop;
    }

    _updateAllPageSizes() {
      for (let i = 0; i < this.pageEls.length; i++) {
        const dims = this.pageDims[i];
        if (!dims) continue;
        const page = i + 1;
        const base = this._pageBaseSizes.get(page);
        const baseWidth = base ? base.width : this._baseWidth;
        const baseHeight = base ? base.height : this._baseHeight;
        const width = round2(baseWidth * this.scale);
        const height = round2(baseHeight * this.scale);
        dims.width = width;
        dims.height = height;
        const pageEl = this.pageEls[i];
        pageEl.style.width = width + 'px';
        pageEl.style.height = height + 'px';
        pageEl.style.setProperty('--scale-factor', String(this.scale));
        pageEl.dataset.rendered = '0';
      }
    }

    _relayout() {
      const tops = new Array(this.pageCount);
      let top = this._paddingTop;
      for (let i = 0; i < this.pageCount; i++) {
        const dims = this.pageDims[i];
        tops[i] = top;
        top += (dims ? dims.height : 0) + this._gap;
      }
      this.pageTops = tops;
    }

    _pageTop(page) {
      const top = this.pageTops[page - 1];
      return typeof top === 'number' ? top : 0;
    }

    _absolutePageTop(page) {
      return this._viewerOffset + this._pageTop(page);
    }

    _computeFitScale() {
      const available = this.container.clientWidth - FIT_PADDING;
      if (!(available > 0) || !(this._baseWidth > 0)) return 1;
      return clamp(round3(available / this._baseWidth), MIN_SCALE, MAX_SCALE);
    }

    _getDpr() {
      return Math.min(window.devicePixelRatio || 1, MAX_DPR);
    }

    // 超大页面时适当降低位图倍率，避免 canvas 内存失控（清晰度优先的前提下兜底）
    _getRenderDpr(cssWidth, cssHeight) {
      const dpr = this._getDpr();
      if (!(cssWidth > 0) || !(cssHeight > 0)) return dpr;
      const pixels = cssWidth * cssHeight * dpr * dpr;
      if (pixels <= MAX_CANVAS_PIXELS) return dpr;
      return Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)));
    }

    _applyPageSize(page, cssWidth, cssHeight) {
      const index = page - 1;
      const dims = this.pageDims[index];
      if (!dims) return;
      // 记录该页在 scale=1 时的真实尺寸，缩放时优先使用
      if (this.scale > 0 && cssWidth > 0 && cssHeight > 0) {
        this._pageBaseSizes.set(page, { width: cssWidth / this.scale, height: cssHeight / this.scale });
      }
      const width = round2(cssWidth);
      const height = round2(cssHeight);
      if (Math.abs(width - dims.width) < 0.01 && Math.abs(height - dims.height) < 0.01) return;

      const oldHeight = dims.height;
      dims.width = width;
      dims.height = height;
      const pageEl = this.pageEls[index];
      if (pageEl) {
        pageEl.style.width = width + 'px';
        pageEl.style.height = height + 'px';
      }
      this._relayout();

      // 上方占位高度被修正时补偿滚动位置，减少内容跳动
      const delta = height - oldHeight;
      if (Math.abs(delta) > 0.5 && page < this._currentPage && this.container.scrollTop > 0) {
        this.container.scrollTop = Math.max(0, this.container.scrollTop + delta);
      }
    }

    /* ================= 当前页 / 进度 ================= */

    _pageAt(y) {
      if (!this.pageCount) return 1;
      const target = this._viewerOffset + y;
      let low = 0;
      let high = this.pageCount - 1;
      let result = this.pageCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const dims = this.pageDims[mid];
        const bottom = this._viewerOffset + this.pageTops[mid] + (dims ? dims.height : 0);
        if (bottom > target) {
          result = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      return result + 1;
    }

    _updateCurrentPage(force) {
      if (this._destroyed || !this._opened || !this.pageCount) return;
      // 滚到底部时最后一页可能无法顶到视口顶部（受滚动范围限制），此时应判定为最后一页，
      // 否则页码/进度会在最后一页误显示为前一页。
      const maxScroll = this.container.scrollHeight - this.container.clientHeight;
      const atBottom = maxScroll > 0 && this.container.scrollTop >= maxScroll - 2;
      const page = atBottom ? this.pageCount : this._pageAt(this.container.scrollTop);
      if (!force && page === this._currentPage) return;
      this._currentPage = page;
      this._notify('onPageChange', page, this._chapterForPage(page));
      this._scheduleProgress();
    }

    _chapterForPage(page) {
      for (let i = 0; i < this.chapters.length; i++) {
        const chapter = this.chapters[i];
        if (!chapter) continue;
        const start = toPageNumber(chapter.startPage, 0);
        const end = toPageNumber(chapter.endPage, start);
        if (start > 0 && page >= start && page <= end) return chapter;
      }
      return null;
    }

    _scheduleProgress() {
      if (this._destroyed || this._progressTimer) return;
      this._progressTimer = window.setTimeout(() => {
        this._progressTimer = 0;
        if (this._destroyed || !this._opened) return;
        this._notify('onProgress', {
          page: this._currentPage,
          pageCount: this.pageCount,
          ratio: this.pageCount ? this._currentPage / this.pageCount : 0,
        });
      }, PROGRESS_DELAY);
    }

    _handleContainerResize() {
      if (this._destroyed || !this._opened) return;
      const width = this.container.clientWidth;
      if (!(width > 0)) return;
      if (Math.abs(width - this._observedWidth) < CONTAINER_RESIZE_MIN_DELTA) return;
      this._observedWidth = width;
      if (this._resizeTimer) window.clearTimeout(this._resizeTimer);
      this._resizeTimer = window.setTimeout(() => {
        this._resizeTimer = 0;
        if (this._destroyed || !this._opened) return;
        this.resize();
      }, CONTAINER_RESIZE_DELAY);
    }

    _handleScroll() {
      if (this._scrollRaf) return;
      this._scrollRaf = window.requestAnimationFrame(() => {
        this._scrollRaf = 0;
        if (this._destroyed || !this._opened) return;
        this._updateCurrentPage(false);
        if (!this._rendered.has(this._currentPage) && !this._failed.has(this._currentPage)) {
          this._requestRender(this._currentPage, false);
        }
        this._scheduleProgress();
      });
    }

    _handleIntersect(entries) {
      if (this._destroyed || !this._opened) return;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.isIntersecting) continue;
        const page = toPageNumber(entry.target && entry.target.dataset ? entry.target.dataset.page : 0, 0);
        if (page >= 1 && page <= this.pageCount) this._requestRender(page, false);
      }
    }

    /* ================= 渲染队列 ================= */

    _requestRender(page, force) {
      if (this._destroyed || !this._opened) return Promise.resolve(false);
      if (page < 1 || page > this.pageCount) return Promise.resolve(false);
      if (this._failed.has(page)) return Promise.resolve(false);

      if (!force && this._isRendered(page)) return Promise.resolve(true);

      const existing = this._renderJobs.get(page);
      if (existing) {
        if (force) existing.force = true;
        return existing.promise;
      }

      let resolveJob = null;
      const promise = new Promise((resolve) => { resolveJob = resolve; });
      const job = {
        page,
        force: !!force,
        queued: true,
        promise,
        resolve: resolveJob,
      };
      this._renderJobs.set(page, job);
      this._renderQueue.push(job);
      this._pumpRenderQueue();
      return promise;
    }

    _isRendered(page) {
      if (!this._rendered.has(page)) return false;
      const metrics = this._renderedMetrics.get(page);
      if (!metrics) return false;
      return Math.abs(metrics.scale - this.scale) < 0.0001 && metrics.dpr === this._getDpr();
    }

    _pumpRenderQueue() {
      if (this._pumping || this._destroyed) return;
      this._pumping = true;
      this._pumpRenderQueueAsync().catch(() => {
        this._pumping = false;
      });
    }

    async _pumpRenderQueueAsync() {
      try {
        while (!this._destroyed && this._renderQueue.length) {
          this._renderQueue.sort((a, b) => {
            if (a.force !== b.force) return a.force ? -1 : 1;
            return Math.abs(a.page - this._currentPage) - Math.abs(b.page - this._currentPage);
          });
          const job = this._renderQueue.shift();
          if (!job || !job.queued) continue;
          job.queued = false;

          if (!job.force && !this._shouldRender(job.page)) {
            job.resolve(false);
            if (this._renderJobs.get(job.page) === job) this._renderJobs.delete(job.page);
            continue;
          }

          let ok = false;
          try {
            ok = await this._renderPage(job.page);
          } catch (err) {
            if (!isCancelError(err)) this._notify('onError', err);
          }
          job.resolve(ok);
          // 只清理自己的登记，避免误删缩放期间新建的同页任务
          if (this._renderJobs.get(job.page) === job) this._renderJobs.delete(job.page);
        }
      } finally {
        this._pumping = false;
      }
    }

    _flushRenderQueue() {
      const jobs = Array.from(this._renderJobs.values());
      this._renderQueue.length = 0;
      this._renderJobs.clear();
      for (let i = 0; i < jobs.length; i++) {
        jobs[i].queued = false;
        jobs[i].resolve(false);
      }
    }

    _shouldRender(page) {
      const dims = this.pageDims[page - 1];
      if (!dims) return false;
      const margin = this.container.clientHeight * 1.5;
      const scrollTop = this.container.scrollTop;
      const pageTop = this._absolutePageTop(page);
      return pageTop + dims.height > scrollTop - margin
        && pageTop < scrollTop + this.container.clientHeight + margin;
    }

    _renderVisible() {
      if (this._destroyed || !this._opened || !this.pageCount) return;
      const scrollTop = this.container.scrollTop;
      const margin = this.container.clientHeight * 1.5;
      const from = this._pageAt(scrollTop - margin);
      const to = this._pageAt(scrollTop + this.container.clientHeight + margin);
      for (let page = from; page <= to; page++) {
        if (!this._isRendered(page) && !this._failed.has(page)) {
          this._requestRender(page, false);
        }
      }
    }

    async _getPageProxy(page) {
      const cached = this._pages.get(page);
      if (cached) return cached;
      const proxy = await this.doc.getPage(page);
      this._pages.set(page, proxy);
      return proxy;
    }

    async _renderPage(page) {
      if (this._destroyed) return false;
      const pageEl = this.pageEls[page - 1];
      if (!pageEl) return false;
      if (this._isRendered(page)) return true;

      const generation = this._generation;
      const expectedDpr = this._getDpr();
      this._cancelPageTasks(page);
      this._setLoading(page, true);
      pageEl.dataset.rendered = '0';

      try {
        const pageProxy = await this._getPageProxy(page);
        if (this._destroyed || generation !== this._generation) return false;

        const viewport = pageProxy.getViewport({ scale: this.scale });
        const cssWidth = viewport.width;
        const cssHeight = viewport.height;
        this._applyPageSize(page, cssWidth, cssHeight);

        // 高清渲染：位图尺寸 = CSS 尺寸 * dpr，CSS 尺寸保持 viewport 大小
        const renderDpr = this._getRenderDpr(cssWidth, cssHeight);
        const renderViewport = pageProxy.getViewport({ scale: this.scale * renderDpr });
        const canvas = pageEl.querySelector('.pdf-canvas');
        canvas.width = Math.max(1, Math.floor(renderViewport.width));
        canvas.height = Math.max(1, Math.floor(renderViewport.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('无法获取 canvas 2d 上下文');

        const renderTask = pageProxy.render({ canvasContext: ctx, viewport: renderViewport });
        this._renderTasks.set(page, renderTask);
        try {
          await renderTask.promise;
        } finally {
          if (this._renderTasks.get(page) === renderTask) this._renderTasks.delete(page);
        }
        if (this._destroyed || generation !== this._generation) return false;

        // 画布成功后渲染文本层；文本层失败不影响画布展示
        const textLayerEl = pageEl.querySelector('.pdf-text-layer');
        if (textLayerEl) {
          try {
            await this._renderTextLayer(page, pageProxy, textLayerEl, viewport, generation);
          } catch (err) {
            if (!isCancelError(err)) this._notify('onError', err);
          }
        }
        if (this._destroyed || generation !== this._generation) return false;

        pageEl.dataset.rendered = '1';
        this._rendered.add(page);
        this._renderedMetrics.set(page, { scale: this.scale, dpr: expectedDpr });
        this._lastRenderDpr = expectedDpr;
        this._setLoading(page, false);
        this._notify('onPageRendered', page, textLayerEl);
        this._evictPages();
        return true;
      } catch (err) {
        if (isCancelError(err)) return false;
        if (!this._destroyed && generation === this._generation) {
          this._failed.add(page);
          this._setLoading(page, false);
          pageEl.dataset.rendered = '0';
          this._notify('onError', err);
        }
        return false;
      }
    }

    async _renderTextLayer(page, pageProxy, textLayerEl, viewport, generation) {
      const pdfjs = this.pdfjs;
      if (!pdfjs || !isFn(pdfjs.renderTextLayer)) return false;

      textLayerEl.textContent = '';
      const pageEl = this.pageEls[page - 1];
      // pdf.js v4 的文本层用 --scale-factor 计算字号与尺寸
      if (pageEl) pageEl.style.setProperty('--scale-factor', String(viewport.scale));
      textLayerEl.style.setProperty('--scale-factor', String(viewport.scale));
      if (isFn(pdfjs.setLayerDimensions)) {
        try { pdfjs.setLayerDimensions(textLayerEl, viewport); } catch (err) { /* 非致命 */ }
      }

      let source = null;
      if (isFn(pageProxy.streamTextContent)) {
        source = pageProxy.streamTextContent({ includeMarkedContent: false });
      } else if (isFn(pageProxy.getTextContent)) {
        source = await pageProxy.getTextContent({ includeMarkedContent: false });
      }
      if (!source) return false;
      if (this._destroyed || generation !== this._generation) return false;

      const task = pdfjs.renderTextLayer({
        textContentSource: source,
        container: textLayerEl,
        viewport,
      });
      if (!task) return false;

      this._textTasks.set(page, task);
      try {
        if (task.promise && isFn(task.promise.then)) await task.promise;
      } finally {
        if (this._textTasks.get(page) === task) this._textTasks.delete(page);
      }
      if (this._destroyed || generation !== this._generation) {
        // 缩放/释放已发生，丢弃这次迟到的文本层内容
        textLayerEl.textContent = '';
        return false;
      }
      return true;
    }

    /* ================= 渲染任务与页面释放 ================= */

    _cancelPageTasks(page) {
      const renderTask = this._renderTasks.get(page);
      if (renderTask && isFn(renderTask.cancel)) {
        try { renderTask.cancel(); } catch (err) { /* 已结束 */ }
      }
      this._renderTasks.delete(page);

      const textTask = this._textTasks.get(page);
      if (textTask && isFn(textTask.cancel)) {
        try { textTask.cancel(); } catch (err) { /* 已结束 */ }
      }
      this._textTasks.delete(page);
    }

    _cancelAllTasks() {
      const pages = new Set();
      this._renderTasks.forEach((value, page) => pages.add(page));
      this._textTasks.forEach((value, page) => pages.add(page));
      pages.forEach((page) => this._cancelPageTasks(page));
    }

    _setLoading(page, loading) {
      const pageEl = this.pageEls[page - 1];
      if (!pageEl) return;
      if (loading) {
        pageEl.classList.add('is-loading');
        this._loadingPages.add(page);
      } else {
        pageEl.classList.remove('is-loading');
        this._loadingPages.delete(page);
      }
    }

    _releasePage(page) {
      this._cancelPageTasks(page);
      this._setLoading(page, false);
      const pageEl = this.pageEls[page - 1];
      if (pageEl) {
        const canvas = pageEl.querySelector('.pdf-canvas');
        if (canvas) {
          // 归零宽高让浏览器尽快释放位图内存
          canvas.width = 0;
          canvas.height = 0;
        }
        const textLayerEl = pageEl.querySelector('.pdf-text-layer');
        if (textLayerEl) textLayerEl.textContent = '';
        pageEl.dataset.rendered = '0';
      }
      this._rendered.delete(page);
      this._renderedMetrics.delete(page);
      const pageProxy = this._pages.get(page);
      if (pageProxy && isFn(pageProxy.cleanup)) {
        try { pageProxy.cleanup(); } catch (err) { /* 正在渲染时忽略 */ }
      }
      this._pages.delete(page);
    }

    _takeRenderedPages() {
      const pages = Array.from(this._rendered);
      for (let i = 0; i < pages.length; i++) this._releasePage(pages[i]);
      return pages;
    }

    _evictPages() {
      if (this._rendered.size <= MAX_RENDERED_PAGES) return;
      const range = this._visiblePageRange();
      const current = this._currentPage;
      const candidates = [];
      this._rendered.forEach((page) => {
        if (this._pinned.has(page)) return;
        if (page >= range.first && page <= range.last) return;
        candidates.push(page);
      });
      candidates.sort((a, b) => Math.abs(b - current) - Math.abs(a - current));

      const released = [];
      for (let i = 0; i < candidates.length; i++) {
        if (this._rendered.size <= MAX_RENDERED_PAGES) break;
        const page = candidates[i];
        this._releasePage(page);
        released.push(page);
      }
      if (released.length) this._notify('onPagesReleased', released);
    }

    _visiblePageRange() {
      const top = this.container.scrollTop;
      const bottom = top + this.container.clientHeight;
      return {
        first: this._pageAt(top),
        last: this._pageAt(bottom),
      };
    }

    /* ================= 缩放/尺寸变化 ================= */

    /**
     * 同步切换缩放：清空已渲染页、更新占位尺寸、保持当前页相对位置。
     * 返回 { anchorPage, anchorDelta }，实际渲染由调用方安排。
     */
    _beginScaleUpdate(nextScale, force) {
      if (this._destroyed || !this._opened) return null;
      const target = clamp(round3(nextScale), MIN_SCALE, MAX_SCALE);
      const scaleChanged = Math.abs(target - this.scale) > 0.0001;
      const dpr = this._getDpr();
      if (!scaleChanged && !force && dpr === this._lastRenderDpr) return null;

      const anchorPage = this._currentPage;
      const oldTop = this._absolutePageTop(anchorPage);
      const anchorDelta = Math.max(0, this.container.scrollTop - oldTop);
      const released = this._takeRenderedPages();
      // 清理遗留的加载指示（被取消的渲染不会再走到 render 完成分支）
      Array.from(this._loadingPages).forEach((page) => this._setLoading(page, false));

      this._generation += 1;
      this._cancelAllTasks();
      this._flushRenderQueue();

      if (scaleChanged) {
        this.scale = target;
        this._updateAllPageSizes();
      } else {
        // 仅清晰度失效，尺寸不变
        for (let i = 0; i < this.pageEls.length; i++) {
          this.pageEls[i].dataset.rendered = '0';
        }
      }

      this._measureMetrics();
      this._relayout();
      this.container.scrollTop = Math.max(0, this._absolutePageTop(anchorPage) + anchorDelta);
      this._updateCurrentPage(false);
      this._scheduleProgress();

      if (released.length) this._notify('onPagesReleased', released);
      return { anchorPage, anchorDelta };
    }

    _scheduleRerender(delay) {
      if (this._destroyed || !this._opened) return;
      this._cancelRerenderTimer();
      const wait = Math.max(0, delay || 0);
      this._rerenderTimer = window.setTimeout(() => {
        this._rerenderTimer = 0;
        if (this._destroyed || !this._opened) return;
        const anchor = this._currentPage;
        this._requestRender(anchor, true).then(() => {
          if (this._destroyed || !this._opened) return;
          this._renderVisible();
        }, () => {});
      }, wait);
    }

    _cancelRerenderTimer() {
      if (this._rerenderTimer) {
        window.clearTimeout(this._rerenderTimer);
        this._rerenderTimer = 0;
      }
    }

    /* ================= 回调 ================= */

    _notify(name) {
      const fn = this.options ? this.options[name] : null;
      if (!isFn(fn)) return;
      const args = Array.prototype.slice.call(arguments, 1);
      try {
        fn.apply(null, args);
      } catch (err) {
        if (typeof console !== 'undefined' && isFn(console.error)) {
          console.error('[pdf-reader] 回调执行失败:', err);
        }
      }
    }
  }

  /* ================= 对外暴露 ================= */

  window.ReaderPdfReader = {
    VERSION: VERSION,
    create(container, options) {
      return new PdfReader(container, options);
    },
  };
})();
