/*!
 * Reader · 文件名语言判定（纯函数，无 DOM、无依赖）
 *
 * 用途：上传/导入书籍时，根据文件名中的语言标记推断阅读语言。
 * 约定：词边界精确匹配，只认 en/eng 与 zh/cn/chs/cht，命中中文优先。
 * 兼容：浏览器以传统 <script> 引入时挂到 window.ReaderLang；
 *       Node 环境 require 返回 api 对象。
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReaderLang = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 英文语言标记（必须与切分后的 token 完全相等）
  const EN_TOKENS = ['en', 'eng'];
  // 中文语言标记（必须与切分后的 token 完全相等）
  const ZH_TOKENS = ['zh', 'cn', 'chs', 'cht'];

  /**
   * 去掉文件名的最后一个扩展名（只去最后一段）。
   * 例：'a.b.pdf' → 'a.b'；没有扩展名或首字符即点号时原样返回。
   * @param {string} name
   * @returns {string}
   */
  function stripLastExtension(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return name;
    return name.slice(0, dot);
  }

  /**
   * 将文件名切分为语言 token 列表。
   * 处理顺序：去最后扩展名 → 转小写 → 按非字母数字切分 → 过滤空串。
   * 非字符串或空串返回空数组，不抛异常。
   * @param {string} filename
   * @returns {string[]}
   */
  function tokenize(filename) {
    if (typeof filename !== 'string' || filename.length === 0) return [];
    const base = stripLastExtension(filename);
    const parts = base.toLowerCase().split(/[^a-z0-9]+/);
    const tokens = [];
    for (const part of parts) {
      if (part) tokens.push(part);
    }
    return tokens;
  }

  /**
   * 根据文件名推断语言。
   * @param {string} filename
   * @returns {{ lang: 'zh'|'en', source: 'filename'|'conflict'|'default',
   *            matched: { en: string[], zh: string[] }, tokens: string[] }}
   */
  function detect(filename) {
    const tokens = tokenize(filename);
    const matched = { en: [], zh: [] };

    for (const token of tokens) {
      if (EN_TOKENS.indexOf(token) !== -1) matched.en.push(token);
      else if (ZH_TOKENS.indexOf(token) !== -1) matched.zh.push(token);
    }

    // 同时命中：中文优先，并标记为冲突来源
    if (matched.en.length > 0 && matched.zh.length > 0) {
      return { lang: 'zh', source: 'conflict', matched, tokens };
    }
    if (matched.en.length > 0) {
      return { lang: 'en', source: 'filename', matched, tokens };
    }
    if (matched.zh.length > 0) {
      return { lang: 'zh', source: 'filename', matched, tokens };
    }
    return { lang: 'zh', source: 'default', matched, tokens };
  }

  const api = {
    EN_TOKENS,
    ZH_TOKENS,
    tokenize,
    detect,
  };

  return api;
});
