/* ==========================================================================
 * Reader v0.0.6 —— 自定义阅读背景
 *
 * 职责：
 *   1. 纯逻辑：文件校验、遮罩不透明度归一化、遮罩颜色计算（可在 Node 下单测）；
 *   2. 图片处理：解码校验 + 长边超限时等比压缩（浏览器）；
 *   3. DOM：背景图层的应用 / 清除 / 状态查询。
 *
 * 加载方式：
 *   - 浏览器：传统 <script> 引入，API 挂到 window.ReaderBackground；
 *   - Node：require('./background.js') 直接得到同一份 API（便于 node:test）。
 * 本文件不访问 IndexedDB / localStorage，也不产生任何界面文案。
 * ========================================================================== */
(function (root, factory) {
  'use strict';

  const api = factory();

  // Node / CommonJS：直接返回 API，纯逻辑可在 Node 下单测
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }

  // 浏览器：挂到 window.ReaderBackground（Node 下 root 为 null，跳过）
  if (root) {
    root.ReaderBackground = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ================= 常量 ================= */

  const LIMITS = Object.freeze({
    maxBytes: 8 * 1024 * 1024,
    maxLongEdge: 4096,
    extensions: Object.freeze(['.jpg', '.jpeg', '.png', '.webp']),
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  });

  // 遮罩默认不透明度（约七成，保证文字可读）
  const DEFAULT_OVERLAY = 0.72;
  // 压缩后的 JPEG 质量
  const JPEG_QUALITY = 0.9;

  // 三套主题对应的遮罩基色（RGB 分量，alpha 由 overlay 决定）
  const SHADE_RGB = Object.freeze({
    light: '255,255,255',
    sepia: '245,239,224',
    dark: '18,18,20',
  });

  // 背景层节点标识
  const LAYER_ID = 'reading-bg';
  const LAYER_CLASS = 'reading-bg';
  const IMAGE_CLASS = 'reading-bg-img';
  const SHADE_CLASS = 'reading-bg-shade';

  // 当前背景层状态（仅记录，不落盘）
  const state = {
    activeUrl: null,
    overlay: DEFAULT_OVERLAY,
    theme: 'light',
  };

  /* ================= 工具 ================= */

  // 生成带 code 的 Error，便于上层按错误码提示文案
  function createError(code, message, cause) {
    const err = new Error(message || code);
    err.code = code;
    if (cause) err.cause = cause;
    return err;
  }

  // 不透明度限制到 [0, 1]
  function clampOverlay(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  // 遮罩 alpha 统一到 3 位小数并去掉末尾多余的 0，保证输出稳定
  function formatAlpha(alpha) {
    return String(Math.round(alpha * 1000) / 1000);
  }

  // 取文件名最后一段的扩展名（小写，含点）；取不到返回空串
  function readExtension(name) {
    const base = String(name == null ? '' : name).split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot).toLowerCase();
  }

  // 读取文件大小，异常值按 0 处理
  function readSize(file) {
    return typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0;
  }

  // 从扩展名推断 MIME（仅用于 file.type 为空的兼容场景）
  function mimeFromName(name) {
    const ext = readExtension(name);
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    return '';
  }

  // 解析返回给上层的 MIME：优先原 file.type，缺失时按扩展名推断
  function resolveMime(file) {
    const type = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
    if (LIMITS.mimeTypes.indexOf(type) !== -1) return type;
    return mimeFromName(file.name) || 'image/jpeg';
  }

  /* ================= 纯逻辑：文件校验 ================= */

  /**
   * 校验待上传的背景图片。
   * 纯函数、同步、永不抛异常。
   * @returns {{ok: true} | {ok: false, code: string}}
   *   code: 'empty' | 'too-large' | 'bad-extension' | 'bad-mime'（兜底 'invalid'）
   */
  function validateFile(file) {
    try {
      if (!file) return { ok: false, code: 'empty' };

      const size = readSize(file);
      if (size <= 0) return { ok: false, code: 'empty' };
      if (size > LIMITS.maxBytes) return { ok: false, code: 'too-large' };

      const ext = readExtension(file.name);
      if (LIMITS.extensions.indexOf(ext) === -1) {
        return { ok: false, code: 'bad-extension' };
      }

      // type 允许为空（部分来源拿不到 MIME），非空则必须命中白名单
      const mime = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
      if (mime && LIMITS.mimeTypes.indexOf(mime) === -1) {
        return { ok: false, code: 'bad-mime' };
      }

      return { ok: true };
    } catch (err) {
      // 约定：校验不抛异常，异常值一律视为无效文件
      return { ok: false, code: 'invalid' };
    }
  }

  /* ================= 纯逻辑：遮罩 ================= */

  /**
   * 把任意输入归一化为 [0, 1] 的遮罩不透明度。
   * 数字 / 数字字符串可解析；其余（null、undefined、NaN、非法字符串）回落到 0.72。
   */
  function normalizeOverlay(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? clampOverlay(value) : DEFAULT_OVERLAY;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return DEFAULT_OVERLAY;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? clampOverlay(parsed) : DEFAULT_OVERLAY;
    }
    return DEFAULT_OVERLAY;
  }

  /**
   * 计算背景遮罩颜色。
   * @param {string} theme 'light' | 'sepia' | 'dark'，未知主题按 light 处理
   * @param {number|string} overlay 不透明度
   * @returns {string} 形如 'rgba(255,255,255,0.72)'
   */
  function overlayColor(theme, overlay) {
    const alpha = normalizeOverlay(overlay);
    const name = typeof theme === 'string' ? theme.trim().toLowerCase() : '';
    let rgb = SHADE_RGB.light;
    if (name === 'dark') rgb = SHADE_RGB.dark;
    else if (name === 'sepia') rgb = SHADE_RGB.sepia;
    return 'rgba(' + rgb + ',' + formatAlpha(alpha) + ')';
  }

  /* ================= 图片解码 ================= */

  // <img> + objectURL 兜底解码
  function decodeWithImageElement(file) {
    return new Promise((resolve, reject) => {
      if (
        typeof Image !== 'function' ||
        typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function'
      ) {
        reject(createError('decode-failed', '当前环境不支持图片解码'));
        return;
      }

      let objectUrl = '';
      try {
        objectUrl = URL.createObjectURL(file);
      } catch (err) {
        reject(createError('decode-failed', '无法创建图片预览地址', err));
        return;
      }

      function release() {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (err) {
          // 释放失败不影响主流程
        }
      }

      const image = new Image();
      image.onload = () => {
        release();
        const width = image.naturalWidth || image.width || 0;
        const height = image.naturalHeight || image.height || 0;
        if (width > 0 && height > 0) {
          resolve({ source: image, width: width, height: height });
        } else {
          reject(createError('decode-failed', '图片尺寸无效'));
        }
      };
      image.onerror = () => {
        release();
        reject(createError('decode-failed', '图片解码失败'));
      };
      image.decoding = 'async';
      image.src = objectUrl;
    });
  }

  // 优先 createImageBitmap（快且可关掉释放内存），失败再退回 <img>
  async function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            bitmap: bitmap,
          };
        }
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      } catch (err) {
        // 部分浏览器对大图 / webp 会在此失败，继续走 <img> 兜底
      }
    }

    const decoded = await decodeWithImageElement(file);
    return {
      source: decoded.source,
      width: decoded.width,
      height: decoded.height,
      bitmap: null,
    };
  }

  /* ================= 图片压缩 ================= */

  // 优先 OffscreenCanvas，其次 <canvas>；都没有则返回 null
  function createCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') {
      try {
        return new OffscreenCanvas(width, height);
      } catch (err) {
        // 退回到 DOM canvas
      }
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return null;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    } catch (err) {
      // 极端环境（如受限的 WebView）创建失败，按不支持处理
      return null;
    }
  }

  // 兼容 OffscreenCanvas.convertToBlob 与 HTMLCanvasElement.toBlob
  function canvasToBlob(canvas, type, quality) {
    if (canvas && typeof canvas.convertToBlob === 'function') {
      return Promise.resolve(canvas.convertToBlob({ type: type, quality: quality }));
    }
    if (canvas && typeof canvas.toBlob === 'function') {
      return new Promise((resolve, reject) => {
        try {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(createError('encode-failed', '画布导出图片失败'));
          }, type, quality);
        } catch (err) {
          reject(createError('encode-failed', '画布导出图片失败', err));
        }
      });
    }
    return Promise.reject(createError('unsupported', '当前环境不支持画布导出'));
  }

  // 等比压缩为 JPEG
  async function renderCompressed(source, width, height) {
    const canvas = createCanvas(width, height);
    if (!canvas) throw createError('unsupported', '当前环境不支持画布压缩');

    let ctx = null;
    try {
      ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    } catch (err) {
      ctx = null;
    }
    if (!ctx) throw createError('unsupported', '当前环境不支持画布绘制');

    try {
      ctx.drawImage(source, 0, 0, width, height);
    } catch (err) {
      // 大图绘制可能因内存不足失败，归入解码失败
      throw createError('decode-failed', '图片压缩绘制失败', err);
    }

    try {
      return await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    } catch (err) {
      throw err && err.code ? err : createError('encode-failed', '图片压缩失败', err);
    }
  }

  /* ================= 对外：图片预处理 ================= */

  /**
   * 校验并解码图片；长边超过 4096 时等比压缩为 JPEG。
   * 浏览器专用（Node 下抛 code='unsupported'）。
   * @returns {Promise<{blob: Blob, width: number, height: number, mime: string, size: number}>}
   */
  async function prepareImage(file) {
    // 先做纯逻辑校验，失败直接抛出对应错误码
    const check = validateFile(file);
    if (!check.ok) {
      throw createError(check.code, '背景图片校验未通过：' + check.code);
    }

    // Node 环境没有 DOM，明确抛 unsupported 而不是 ReferenceError
    if (typeof document === 'undefined') {
      throw createError('unsupported', '当前环境不支持图片处理（缺少 DOM）');
    }

    let decoded;
    try {
      decoded = await decodeImage(file);
    } catch (err) {
      throw err && err.code ? err : createError('decode-failed', '图片解码失败', err);
    }

    try {
      const longEdge = Math.max(decoded.width, decoded.height);

      // 未超限：原样返回
      if (longEdge <= LIMITS.maxLongEdge) {
        return {
          blob: file,
          width: decoded.width,
          height: decoded.height,
          mime: resolveMime(file),
          size: readSize(file),
        };
      }

      // 超限：等比缩到长边 4096，转 JPEG
      const scale = LIMITS.maxLongEdge / longEdge;
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const blob = await renderCompressed(decoded.source, width, height);

      return {
        blob: blob,
        width: width,
        height: height,
        mime: 'image/jpeg',
        size: blob.size,
      };
    } finally {
      // 及时释放位图内存
      if (decoded.bitmap && typeof decoded.bitmap.close === 'function') {
        try {
          decoded.bitmap.close();
        } catch (err) {
          // 释放失败可忽略
        }
      }
    }
  }

  /* ================= DOM：背景图层 ================= */

  // 确保背景层节点存在（已存在则复用，不覆盖已有节点的引用）
  function ensureLayer() {
    if (typeof document === 'undefined' || !document.body) return null;

    let layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement('div');
      layer.id = LAYER_ID;
      layer.className = LAYER_CLASS;
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }

    let image = layer.querySelector('img.' + IMAGE_CLASS);
    if (!image) {
      image = document.createElement('img');
      image.className = IMAGE_CLASS;
      image.alt = '';
      layer.appendChild(image);
    }

    let shade = layer.querySelector('.' + SHADE_CLASS);
    if (!shade) {
      shade = document.createElement('div');
      shade.className = SHADE_CLASS;
      layer.appendChild(shade);
    }

    return { layer: layer, image: image, shade: shade };
  }

  /**
   * 应用阅读背景。
   * url 为空 / null 时等价于 clear()。Node 下直接返回，不抛异常。
   * @param {{url?: string|null, overlay?: number|string, theme?: string}} options
   */
  function apply(options) {
    if (typeof document === 'undefined') return;

    const opts = options || {};
    const url = typeof opts.url === 'string' ? opts.url.trim() : '';
    const overlay = normalizeOverlay(opts.overlay);
    const theme = typeof opts.theme === 'string' ? opts.theme.trim().toLowerCase() : '';

    // 无图：清除背景层
    if (!url) {
      clear();
      return;
    }

    const nodes = ensureLayer();
    if (!nodes) return;

    // 同一 URL 重复 apply 不重复设置 src，避免重复解码
    if (nodes.image.getAttribute('src') !== url) {
      nodes.image.setAttribute('src', url);
    }
    nodes.shade.style.background = overlayColor(theme, overlay);

    if (document.body) document.body.classList.add('has-reading-bg');

    state.activeUrl = url;
    state.overlay = overlay;
    state.theme = theme || 'light';
  }

  /**
   * 清除阅读背景：移除节点、去掉 body 标记、重置状态。幂等。
   * 不 revoke objectURL（URL 生命周期由调用方管理）。
   */
  function clear() {
    state.activeUrl = null;
    state.overlay = DEFAULT_OVERLAY;
    state.theme = 'light';

    if (typeof document === 'undefined') return;

    const layer = document.getElementById(LAYER_ID);
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    if (document.body) document.body.classList.remove('has-reading-bg');
  }

  // 当前生效的背景地址，无背景时返回 null
  function getActiveUrl() {
    return state.activeUrl;
  }

  /* ================= 导出 ================= */

  return {
    LIMITS: LIMITS,
    validateFile: validateFile,
    normalizeOverlay: normalizeOverlay,
    overlayColor: overlayColor,
    prepareImage: prepareImage,
    apply: apply,
    clear: clear,
    getActiveUrl: getActiveUrl,
  };
});
