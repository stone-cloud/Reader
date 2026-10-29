/*!
 * Reader · PDF 导入解析
 *
 * 职责：文件校验（大小 / 扩展名 / MIME / 魔数）→ 懒加载 pdf.js → 解析文档 →
 *       书签转章节（委托 ReaderPdfChapters）→ 语言判定（委托 ReaderLang）→
 *       文本层检测，最后销毁文档。
 * 只依赖全局 window.ReaderPdfLoader / ReaderPdfChapters / ReaderLang（运行时延迟读取），
 * 不操作 DOM / IndexedDB / localStorage，不产出 i18n 文案（错误只给 code）。
 */
(function () {
  'use strict';

  const LIMITS = {
    maxBytes: 50 * 1024 * 1024,
    parseTimeoutMs: 60000,
  };

  const PDF_MIME_TYPES = ['application/pdf', 'application/x-pdf'];
  const PDF_MAGIC = '%PDF-';
  const MAGIC_SCAN_BYTES = 1024;

  /* ================= 通用工具 ================= */

  function makeError(code, detail) {
    const err = new Error('PDF 导入失败：' + code);
    err.code = code;
    if (detail !== undefined) err.detail = detail;
    return err;
  }

  function detailText(err) {
    return err && err.message ? String(err.message) : String(err);
  }

  function isInstanceOf(value, ctor) {
    try {
      return typeof ctor === 'function' && value instanceof ctor;
    } catch (err) {
      return false;
    }
  }

  function normalizeMime(type) {
    return String(type || '').split(';')[0].trim().toLowerCase();
  }

  // 前 1024 字节按 latin1 解码，用于查找 %PDF- 魔数
  function latin1Decode(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 1) {
      text += String.fromCharCode(bytes[i]);
    }
    return text;
  }

  /* ================= 文件校验 ================= */

  async function validateFile(file) {
    try {
      if (!file) return { ok: false, code: 'empty' };
      const size = Number(file.size);
      if (!Number.isFinite(size) || size <= 0) return { ok: false, code: 'empty' };
      if (size > LIMITS.maxBytes) {
        return { ok: false, code: 'too-large', detail: { size, maxBytes: LIMITS.maxBytes } };
      }

      const name = typeof file.name === 'string' ? file.name : '';
      if (!/\.pdf$/i.test(name)) {
        return { ok: false, code: 'not-pdf-extension', detail: { name } };
      }

      const mime = normalizeMime(file.type);
      if (mime && PDF_MIME_TYPES.indexOf(mime) === -1) {
        return { ok: false, code: 'not-pdf-mime', detail: { mime } };
      }

      // 读取文件头校验魔数；任何读取异常统一归为 unreadable，validateFile 永不抛异常
      let head;
      try {
        if (typeof file.slice !== 'function' || typeof file.arrayBuffer !== 'function') {
          throw new Error('当前环境不支持读取文件内容');
        }
        const buffer = await file.slice(0, MAGIC_SCAN_BYTES).arrayBuffer();
        head = latin1Decode(new Uint8Array(buffer));
      } catch (err) {
        return { ok: false, code: 'unreadable', detail: { reason: detailText(err) } };
      }
      if (head.indexOf(PDF_MAGIC) === -1) return { ok: false, code: 'not-pdf-magic' };

      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'unreadable', detail: { reason: detailText(err) } };
    }
  }

  // 人类可读的文件大小，如 1234567 → '1.2 MB'；单位换算按 1024 进制
  function formatBytes(n) {
    const bytes = Number(n);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return Math.round(bytes) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    let text = value.toFixed(value < 10 ? 1 : 0);
    if (text.indexOf('.') !== -1) text = text.replace(/0+$/, '').replace(/\.$/, '');
    return text + ' ' + units[unit];
  }

  /* ================= 语言 / 标题 ================= */

  // opts.lang 优先；否则委托 ReaderLang，依赖缺失或异常时回退中文
  function resolveLang(requested, fileName) {
    if (requested === 'zh' || requested === 'en') {
      return { lang: requested, source: 'option', tokens: [] };
    }
    const Lang = window.ReaderLang;
    if (Lang && typeof Lang.detect === 'function') {
      try {
        const hit = Lang.detect(fileName);
        if (hit && (hit.lang === 'zh' || hit.lang === 'en')) {
          return {
            lang: hit.lang,
            source: typeof hit.source === 'string' && hit.source ? hit.source : 'default',
            tokens: Array.isArray(hit.tokens) ? hit.tokens : [],
          };
        }
      } catch (err) {
        // 判定失败 → 使用默认语言
      }
    }
    return { lang: 'zh', source: 'default', tokens: [] };
  }

  function resolveTitle(title, fileName) {
    if (typeof title === 'string' && title.trim()) return title.trim();
    const base = String(fileName || '').split(/[\\/]/).pop() || '';
    return base.replace(/\.[^.]+$/, '') || base;
  }

  // 兜底章节的页范围标题，与 ReaderPdfChapters 的默认标题格式保持一致
  function makePageTitle(lang) {
    return (start, end) => {
      const first = Number.isFinite(Number(start)) ? Math.floor(Number(start)) : 1;
      const last = Number.isFinite(Number(end)) ? Math.floor(Number(end)) : first;
      return lang === 'en' ? `Pages ${first}–${last}` : `第 ${first}–${last} 页`;
    };
  }

  /* ================= 书签目标页解析 ================= */

  // 为 pdf-chapters 提供带 Map 缓存、串行安全的 dest → 页码（1 基）解析函数
  function createPageResolver(doc) {
    const cache = new Map();
    let queue = Promise.resolve();

    function keyOf(dest) {
      try {
        if (typeof dest === 'string') return 's:' + dest;
        if (typeof dest === 'number') return 'n:' + dest;
        if (Array.isArray(dest)) return 'a:' + dest.map(keyOf).join('|');
        if (dest && typeof dest === 'object' && typeof dest.num === 'number') {
          return 'r:' + dest.num + ':' + (dest.gen || 0);
        }
        return null;
      } catch (err) {
        return null;
      }
    }

    async function resolveDest(dest) {
      try {
        let value = dest;
        if (typeof value === 'string') value = await doc.getDestination(value);
        if (Array.isArray(value)) value = value.length ? value[0] : null;
        if (value === null || value === undefined) return null;
        // 页面引用对象 { num, gen } → getPageIndex 得到 0 基索引
        if (typeof value === 'object' && typeof value.num === 'number') {
          const index = await doc.getPageIndex(value);
          return typeof index === 'number' && index >= 0 ? index + 1 : null;
        }
        // 数字目标按契约直接使用
        if (typeof value === 'number') {
          return Number.isFinite(value) ? value : null;
        }
        return null;
      } catch (err) {
        return null;
      }
    }

    return function resolvePage(dest) {
      const key = keyOf(dest);
      if (key !== null && cache.has(key)) return cache.get(key);
      // 串行化 doc API 调用：前一个解析完成后再发起下一个
      const task = queue.then(() => resolveDest(dest));
      queue = task.then(() => undefined, () => undefined);
      if (key !== null) cache.set(key, task);
      return task;
    };
  }

  function countOutlineItems(Chapters, outline) {
    if (Chapters && typeof Chapters.flattenOutline === 'function') {
      try {
        const flat = Chapters.flattenOutline(outline);
        if (Array.isArray(flat)) return flat.length;
      } catch (err) {
        // 回退递归计数
      }
    }
    let total = 0;
    if (!Array.isArray(outline)) return 0;
    for (let i = 0; i < outline.length; i += 1) {
      total += 1;
      const node = outline[i];
      if (node && Array.isArray(node.items)) total += countOutlineItems(null, node.items);
    }
    return total;
  }

  /* ================= 章节构建 ================= */

  async function buildChapters(doc, outline, pageCount, pageTitle) {
    const Chapters = window.ReaderPdfChapters;
    if (!Chapters || typeof Chapters !== 'object') {
      throw makeError('chapters-unavailable', 'ReaderPdfChapters 未加载');
    }
    const resolver = createPageResolver(doc);
    let built = null;
    if (typeof Chapters.outlineToChapters === 'function') {
      try {
        built = await Chapters.outlineToChapters(outline, resolver, pageCount, { pageTitle });
      } catch (err) {
        console.warn('[ReaderPdfImport] 目录转章节失败，改用分页兜底：', detailText(err));
        built = null;
      }
    }
    if (built && Array.isArray(built.chapters) && built.chapters.length > 0) {
      return {
        chapters: built.chapters,
        resolvedCount: Number.isFinite(Number(built.resolvedCount)) ? Number(built.resolvedCount) : 0,
        totalCount: Number.isFinite(Number(built.totalCount))
          ? Number(built.totalCount)
          : countOutlineItems(Chapters, outline),
        tocSource: built.tocSource === 'outline' ? 'outline' : 'pages',
      };
    }
    // 降级：按固定页数切分，保证始终有章节可用
    if (typeof Chapters.buildFallbackChapters !== 'function') {
      throw makeError('chapters-unavailable', 'ReaderPdfChapters 缺少章节构建能力');
    }
    const chapters = Chapters.buildFallbackChapters(pageCount, { pageTitle });
    if (!Array.isArray(chapters) || chapters.length === 0) {
      throw makeError('chapters-unavailable', '章节构建结果为空');
    }
    return {
      chapters,
      resolvedCount: 0,
      totalCount: countOutlineItems(Chapters, outline),
      tocSource: 'pages',
    };
  }

  /* ================= pdf.js 错误映射 ================= */

  function mapPdfError(err, pdfjs) {
    const name = err && typeof err.name === 'string' ? err.name : '';
    const detail = detailText(err);
    if (name === 'PasswordException' || isInstanceOf(err, pdfjs && pdfjs.PasswordException)) {
      return makeError('encrypted', detail);
    }
    if (name === 'InvalidPDFException' || name === 'FormatError'
      || isInstanceOf(err, pdfjs && pdfjs.InvalidPDFException)) {
      return makeError('invalid', detail);
    }
    if (name === 'MissingPDFException' || name === 'UnexpectedResponseException'
      || isInstanceOf(err, pdfjs && pdfjs.MissingPDFException)
      || isInstanceOf(err, pdfjs && pdfjs.UnexpectedResponseException)
      || (err && typeof err.status === 'number')) {
      return makeError('network', detail);
    }
    if (/network|fetch|http/i.test(detail)) return makeError('network', detail);
    return makeError('unknown', detail);
  }

  /* ================= 解析入口 ================= */

  async function parseFile(file, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const validation = await validateFile(file);
    if (!validation.ok) throw makeError(validation.code, validation.detail);

    const Loader = window.ReaderPdfLoader;
    if (!Loader || typeof Loader.load !== 'function') {
      throw makeError('pdfjs-load-failed', 'ReaderPdfLoader 未加载');
    }
    let pdfjs;
    try {
      pdfjs = await Loader.load();
    } catch (err) {
      throw makeError('pdfjs-load-failed', (err && err.detail) || detailText(err));
    }

    let data;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      throw makeError('unknown', detailText(err));
    }
    if (!data.length) throw makeError('invalid', '文件内容为空');

    let assetUrls = {};
    try {
      if (typeof Loader.getAssetUrls === 'function') assetUrls = Loader.getAssetUrls() || {};
    } catch (err) {
      assetUrls = {};
    }

    const fileName = typeof file.name === 'string' ? file.name : '';
    const langInfo = resolveLang(options.lang, fileName);
    const pageTitle = makePageTitle(langInfo.lang);

    let loadingTask = null;
    let doc = null;
    let timer = null;
    let timeoutError = null;

    try {
      try {
        loadingTask = pdfjs.getDocument({
          data,
          ...assetUrls,
          cMapPacked: true,
          isEvalSupported: false,
          useSystemFonts: true,
          verbosity: 0,
        });
      } catch (err) {
        throw mapPdfError(err, pdfjs);
      }
      if (!loadingTask || !loadingTask.promise) {
        throw makeError('unknown', 'getDocument 未返回合法的 loadingTask');
      }
      if (typeof options.onProgress === 'function') {
        loadingTask.onProgress = (progress) => {
          try {
            options.onProgress({
              loaded: progress && typeof progress.loaded === 'number' ? progress.loaded : 0,
              total: progress && typeof progress.total === 'number' ? progress.total : 0,
            });
          } catch (err) {
            // 进度回调自身的异常不影响解析
          }
        };
      }

      const timeoutGuard = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timeoutError = makeError('timeout', { timeoutMs: LIMITS.parseTimeoutMs });
          reject(timeoutError);
        }, LIMITS.parseTimeoutMs);
      });
      try {
        doc = await Promise.race([loadingTask.promise, timeoutGuard]);
      } catch (err) {
        if (timeoutError) {
          // 超时：销毁 loadingTask；若文档迟到解析成功，补一次销毁避免资源泄漏
          try {
            loadingTask.promise.then((lateDoc) => {
              if (lateDoc && typeof lateDoc.destroy === 'function') {
                try { lateDoc.destroy(); } catch (destroyErr) { /* 忽略 */ }
              }
            }, () => {});
          } catch (lateErr) { /* 忽略 */ }
          try { await loadingTask.destroy(); } catch (destroyErr) { /* 忽略 */ }
          loadingTask = null;
          throw timeoutError;
        }
        throw mapPdfError(err, pdfjs);
      }

      const pageCount = doc && typeof doc.numPages === 'number' ? doc.numPages : 0;
      if (!Number.isFinite(pageCount) || pageCount < 1 || Math.floor(pageCount) !== pageCount) {
        throw makeError('invalid', { pageCount: doc ? doc.numPages : null });
      }

      let outline = [];
      try {
        outline = await doc.getOutline();
      } catch (err) {
        outline = [];
      }
      if (!Array.isArray(outline)) outline = [];

      const chapterInfo = await buildChapters(doc, outline, pageCount, pageTitle);

      // 文本层检测：第 1 页有非空 str 项即认为有文本层（扫描版为 false）
      let hasTextLayer = false;
      try {
        const firstPage = await doc.getPage(1);
        const textContent = await firstPage.getTextContent();
        const items = textContent && Array.isArray(textContent.items) ? textContent.items : [];
        hasTextLayer = items.some((item) => item && typeof item.str === 'string' && item.str.length > 0);
        if (firstPage && typeof firstPage.cleanup === 'function') {
          try { firstPage.cleanup(); } catch (cleanupErr) { /* 忽略 */ }
        }
      } catch (err) {
        hasTextLayer = false;
      }

      return {
        pageCount,
        chapters: chapterInfo.chapters,
        tocSource: chapterInfo.tocSource,
        outlineCount: chapterInfo.totalCount,
        resolvedOutlineCount: chapterInfo.resolvedCount,
        hasTextLayer,
        title: resolveTitle(options.title, fileName),
        fileName,
        size: typeof file.size === 'number' ? file.size : 0,
        lang: langInfo.lang,
        langSource: langInfo.source,
        langTokens: langInfo.tokens,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (doc && typeof doc.destroy === 'function') {
        try { await doc.destroy(); } catch (err) { /* 忽略销毁异常 */ }
      } else if (loadingTask && typeof loadingTask.destroy === 'function') {
        try { await loadingTask.destroy(); } catch (err) { /* 忽略销毁异常 */ }
      }
    }
  }

  window.ReaderPdfImport = {
    LIMITS,
    validateFile,
    parseFile,
    formatBytes,
  };
})();
