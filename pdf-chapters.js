/*!
 * Reader · PDF 目录/章节构建（纯函数，无 DOM、无 i18n、无 pdf.js 依赖）
 *
 * 用途：把 pdf.js 的 getOutline() 结果转换为 Reader 的章节列表；
 *      目录缺失或解析成功率不足时，按固定页数切分兜底章节。
 * 兼容：浏览器以传统 <script> 引入时挂到 window.ReaderPdfChapters；
 *       Node 环境 require 返回 api 对象。
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReaderPdfChapters = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PAGES_PER_CHAPTER = 20;
  const DEFAULT_MIN_RESOLVED_RATIO = 0.7;
  const DEFAULT_MAX_ITEMS = 1000;

  // 默认章节标题：第 1–20 页（中间使用 en dash）
  function defaultPageTitle(start, end) {
    return '第 ' + start + '–' + end + ' 页';
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function isPositiveInteger(value) {
    return isFiniteNumber(value) && value >= 1 && Math.floor(value) === value;
  }

  /**
   * 层级归一化：数字四舍五入取整，非数字或小于 1 视为 1，超过 maxLevel 截断。
   * @param {number} level
   * @param {number} [maxLevel=6]
   * @returns {number}
   */
  function clampLevel(level, maxLevel = 6) {
    let max = 6;
    if (isFiniteNumber(maxLevel) && maxLevel >= 1) max = Math.floor(maxLevel);
    let value = 1;
    if (isFiniteNumber(level)) value = Math.round(level);
    if (value < 1) value = 1;
    if (value > max) value = max;
    return value;
  }

  /**
   * 展平 pdf.js 的 outline 树，返回按深度优先顺序排列的条目。
   * 标题为空/纯空白的项不输出，但仍继续下钻其子项。
   * 同时兼容 items 与 children 两种子节点字段。
   * @param {Array} outline
   * @returns {{ title: string, level: number, dest: *, index: number }[]}
   */
  function flattenOutline(outline) {
    const result = [];
    if (!Array.isArray(outline)) return result;

    function walk(nodes, depth) {
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const title = typeof node.title === 'string' ? node.title : '';
        const children = Array.isArray(node.items)
          ? node.items
          : Array.isArray(node.children)
            ? node.children
            : null;
        if (title.trim()) {
          result.push({
            title,
            level: depth,
            dest: node.dest,
            index: result.length,
          });
        }
        if (children) walk(children, depth + 1);
      }
    }

    walk(outline, 1);
    return result;
  }

  // 生成章节标题；自定义标题函数异常或返回空串时回退默认标题
  function resolveTitle(pageTitle, start, end) {
    try {
      const title = pageTitle(start, end);
      if (typeof title === 'string' && title.trim()) return title;
    } catch (err) {
      // 忽略标题生成异常，走默认标题
    }
    return defaultPageTitle(start, end);
  }

  // 每章页数归一化：正整数直接向下取整，非法值回退默认 20，最小 1
  function normalizePagesPerChapter(value) {
    let pages = DEFAULT_PAGES_PER_CHAPTER;
    if (isFiniteNumber(value) && value > 0) pages = Math.floor(value);
    if (pages < 1) pages = 1;
    return pages;
  }

  // 最多解析条目数归一化：非法值回退 1000，允许 0
  function normalizeMaxItems(value) {
    if (!isFiniteNumber(value) || value < 0) return DEFAULT_MAX_ITEMS;
    return Math.floor(value);
  }

  /**
   * 按固定页数切分兜底章节，连续覆盖 1..pageCount。
   * @param {number} pageCount
   * @param {{ pagesPerChapter?: number, pageTitle?: Function }} [opts]
   * @returns {{ id: string, title: string, level: number, startPage: number, endPage: number }[]}
   */
  function buildFallbackChapters(pageCount, opts = {}) {
    opts = opts || {};
    if (!isPositiveInteger(pageCount)) return [];
    const pagesPerChapter = normalizePagesPerChapter(opts.pagesPerChapter);
    const pageTitle = typeof opts.pageTitle === 'function' ? opts.pageTitle : defaultPageTitle;
    const chapters = [];
    let startPage = 1;
    while (startPage <= pageCount) {
      const endPage = Math.min(startPage + pagesPerChapter - 1, pageCount);
      chapters.push({
        id: 'ch-' + (chapters.length + 1),
        title: resolveTitle(pageTitle, startPage, endPage),
        level: 1,
        startPage,
        endPage,
      });
      startPage = endPage + 1;
    }
    return chapters;
  }

  // 解析缓存 key：字符串 dest 直接作 key，其余序列化后作 key
  function destCacheKey(dest) {
    if (typeof dest === 'string') return dest;
    try {
      return JSON.stringify(dest);
    } catch (err) {
      return String(dest);
    }
  }

  /**
   * 将 outline 转换为章节列表。
   *
   * resolvePage(dest) 由调用方提供，返回 1 基页码、null 或它们的 Promise；
   * 同一 dest 只会调用一次（Map 缓存 promise）。
   *
   * @param {Array} outline pdf.js outline 树
   * @param {Function} resolvePage 书签目标页解析函数
   * @param {number} pageCount 文档总页数
   * @param {{ pagesPerChapter?: number, pageTitle?: Function,
   *           minResolvedRatio?: number, maxItems?: number }} [opts]
   * @returns {Promise<{ chapters: Array, resolvedCount: number,
   *                     totalCount: number, tocSource: 'outline'|'pages' }>}
   */
  async function outlineToChapters(outline, resolvePage, pageCount, opts = {}) {
    opts = opts || {};
    const flattened = flattenOutline(outline);
    const totalCount = flattened.length;
    const maxItems = normalizeMaxItems(opts.maxItems);
    const limit = Math.min(maxItems, totalCount);
    const pageTitle = typeof opts.pageTitle === 'function' ? opts.pageTitle : defaultPageTitle;
    const minResolvedRatio = isFiniteNumber(opts.minResolvedRatio)
      ? opts.minResolvedRatio
      : DEFAULT_MIN_RESOLVED_RATIO;
    const pagesPerChapter = opts.pagesPerChapter;
    const pageCountValid = isPositiveInteger(pageCount);
    const resolver = typeof resolvePage === 'function' ? resolvePage : () => null;
    const cache = new Map();

    // 同一 dest 只解析一次；同步抛错与 Promise 拒绝统一收敛为 null
    function resolveOnce(dest) {
      const key = destCacheKey(dest);
      if (cache.has(key)) return cache.get(key);
      const promise = Promise.resolve()
        .then(() => resolver(dest))
        .catch(() => null);
      cache.set(key, promise);
      return promise;
    }

    const candidates = [];
    const seen = new Set();
    let resolvedCount = 0;

    for (let i = 0; i < limit; i++) {
      const item = flattened[i];
      let page = null;
      try {
        page = await resolveOnce(item.dest);
      } catch (err) {
        page = null;
      }
      if (!pageCountValid || !isPositiveInteger(page) || page > pageCount) continue;
      resolvedCount += 1;
      const title = item.title;
      if (typeof title !== 'string' || !title.trim()) continue;
      const dedupeKey = title + '\u0000' + page;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push({ title, level: item.level, startPage: page });
    }

    const chapters = [];
    if (pageCountValid && candidates.length > 0) {
      // 稳定排序：同一 startPage 保持原有目录顺序
      candidates.sort((a, b) => a.startPage - b.startPage);
      for (let i = 0; i < candidates.length; i++) {
        const current = candidates[i];
        const next = candidates[i + 1];
        let startPage = Math.min(Math.max(current.startPage, 1), pageCount);
        let endPage = next ? next.startPage - 1 : pageCount;
        if (endPage > pageCount) endPage = pageCount;
        if (endPage < startPage) endPage = startPage;
        chapters.push({
          id: 'ch-' + (i + 1),
          title: current.title,
          level: clampLevel(current.level),
          startPage,
          endPage,
        });
      }
    }

    const ratio = resolvedCount / Math.max(1, totalCount);
    if (chapters.length === 0 || ratio < minResolvedRatio) {
      return {
        chapters: buildFallbackChapters(pageCount, { pagesPerChapter, pageTitle }),
        resolvedCount,
        totalCount,
        tocSource: 'pages',
      };
    }
    return {
      chapters,
      resolvedCount,
      totalCount,
      tocSource: 'outline',
    };
  }

  const api = {
    clampLevel,
    flattenOutline,
    outlineToChapters,
    buildFallbackChapters,
  };

  return api;
});
