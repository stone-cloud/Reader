/*!
 * Reader · PDF 引擎懒加载器
 *
 * 按需从 CDN 动态 import pdf.js（ESM 单文件），并把 worker 抓成同源 Blob URL；
 * 浏览器以传统 <script> 引入时挂到 window.ReaderPdfLoader。
 * 不访问 document、不操作 DOM，主线程与 Worker 线程均可安全调用。
 */
(function () {
  'use strict';

  const VERSION = '4.2.67';
  const BASE_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67';
  const WORKER_URL = BASE_URL + '/build/pdf.worker.min.mjs';

  // 运行时状态：单例 promise + 模块 / worker 来源缓存
  const runtime = {
    state: 'idle', // idle | loading | ready | error
    promise: null,
    pdfjs: null,
    worker: null, // 'blob' | 'cdn'
    blobUrl: null,
    error: null,
    generation: 0, // reset() 递增，用于丢弃被作废的加载结果
  };
  let workerFallbackWarned = false;

  // 把任意异常包装成带 code 的 Error，方便调用方区分「引擎加载失败」与其他失败
  function toLoadError(err) {
    const detail = err && err.message ? String(err.message) : String(err);
    const wrapped = new Error('PDF 引擎加载失败：' + detail);
    wrapped.code = 'pdfjs-load-failed';
    wrapped.detail = detail;
    return wrapped;
  }

  // 回收 blob URL；worker 启动时已读取脚本内容，revoke 不影响已创建的 worker
  function releaseBlobUrl() {
    if (!runtime.blobUrl) return;
    try {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(runtime.blobUrl);
      }
    } catch (err) {
      // 忽略回收失败
    }
    runtime.blobUrl = null;
  }

  function warnWorkerFallback(err) {
    if (workerFallbackWarned) return;
    workerFallbackWarned = true;
    console.warn('[ReaderPdfLoader] Worker 无法转为 Blob URL，改用 CDN 直连：', err && err.message ? err.message : err);
  }

  // 优先把 worker 脚本抓成本地 Blob URL（避开 CDN worker 的跨域限制）；失败则降级 CDN 地址
  async function configureWorker(mod) {
    const canFetch = typeof fetch === 'function';
    const canBlob = typeof Blob === 'function'
      && typeof URL !== 'undefined'
      && typeof URL.createObjectURL === 'function';
    if (canFetch && canBlob) {
      let url = null;
      try {
        const response = await fetch(WORKER_URL);
        if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : 'unknown'));
        const text = await response.text();
        if (!text) throw new Error('worker 内容为空');
        url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        mod.GlobalWorkerOptions.workerSrc = url;
        runtime.worker = 'blob';
        runtime.blobUrl = url;
        return;
      } catch (err) {
        if (url) {
          try { URL.revokeObjectURL(url); } catch (revokeErr) { /* 忽略 */ }
        }
        warnWorkerFallback(err);
      }
    } else {
      warnWorkerFallback(new Error('当前环境不支持 fetch/Blob/URL.createObjectURL'));
    }
    // 降级：直接使用 CDN 的 worker 地址（v4 的 module worker 支持跨域 CORS 加载）
    mod.GlobalWorkerOptions.workerSrc = WORKER_URL;
    runtime.worker = 'cdn';
  }

  // 加载 pdf.js 模块；并发调用共享同一个 promise，失败后清空 promise 允许重试
  async function load() {
    if (runtime.pdfjs) return runtime.pdfjs;
    if (runtime.promise) return runtime.promise;

    const generation = runtime.generation;
    runtime.state = 'loading';
    runtime.error = null;
    const task = (async () => {
      let mod;
      try {
        mod = await import(BASE_URL + '/build/pdf.min.mjs');
      } catch (err) {
        throw toLoadError(err);
      }
      try {
        await configureWorker(mod);
      } catch (err) {
        throw toLoadError(err);
      }
      if (generation === runtime.generation) {
        runtime.pdfjs = mod;
        runtime.state = 'ready';
      }
      return mod;
    })();
    runtime.promise = task;
    try {
      return await task;
    } catch (err) {
      if (generation === runtime.generation) {
        runtime.state = 'error';
        runtime.error = err && err.message ? String(err.message) : String(err);
        runtime.promise = null;
        runtime.worker = null;
        releaseBlobUrl();
      }
      throw err;
    }
  }

  function getStatus() {
    return {
      state: runtime.state,
      version: VERSION,
      worker: runtime.worker,
      error: runtime.error,
    };
  }

  function getAssetUrls() {
    return {
      cMapUrl: BASE_URL + '/cmaps/',
      standardFontDataUrl: BASE_URL + '/standard_fonts/',
    };
  }

  // 清空缓存，允许在加载失败或切换网络后重新加载
  function reset() {
    runtime.generation += 1;
    releaseBlobUrl();
    runtime.state = 'idle';
    runtime.promise = null;
    runtime.pdfjs = null;
    runtime.worker = null;
    runtime.error = null;
  }

  window.ReaderPdfLoader = {
    VERSION,
    BASE_URL,
    getAssetUrls,
    getStatus,
    load,
    reset,
  };
})();
