(function () {
  'use strict';

  // 兜底：i18n.js 加载失败时，应用依然可用，只是语言功能失效
  window.t = window.t || ((key) => key);
  window.getLang = window.getLang || (() => 'zh');
  window.applyTranslations = window.applyTranslations || (() => {});

  /* ================= 版本 / 存储键（v0.0.6 去品牌化 + 旧数据平滑迁移） ================= */
  const APP_VERSION = '0.0.6';
  const BUILTIN_BOOK_ID = 'guide';
  const DB_NAME = 'reader-db';
  const DB_VERSION = 3;
  const PDF_PAGES_PER_CHAPTER = 20;
  const BACKGROUND_ASSET_KEY = 'reading-background';

  // 旧版本（v0.0.5 及以前）的数据名称，仅用于一次性迁移；新代码不再写入这些名字。
  const LEGACY_DB_NAME = 'fde-reader';
  const LEGACY_SETTINGS_KEY = 'fde-settings';
  const LEGACY_LAST_BOOK_KEY = 'fde-last-book';
  const LEGACY_VIEW_KEY = 'fde-view';
  const LEGACY_LAST_BACKUP_KEY = 'fde-last-backup';
  const LEGACY_CHAPTER_PREFIX = 'fde-last-chapter-';
  const LEGACY_BUILTIN_BOOK_ID = 'fde';

  const STORAGE = {
    settings: 'reader-settings',
    lastBook: 'reader-last-book',
    view: 'reader-view',
    lastBackup: 'reader-last-backup',
    dbMigrated: 'reader-db-migrated',
    chapterPrefix: 'reader-last-chapter-',
    pdfProgressPrefix: 'reader-pdf-progress-',
  };

  function normalizeBookId(bookId) {
    if (bookId === LEGACY_BUILTIN_BOOK_ID) return BUILTIN_BOOK_ID;
    return bookId || BUILTIN_BOOK_ID;
  }

  // 旧版 localStorage 键一次性迁移到新键；失败只告警，不影响启动。
  function migrateLegacyStorage() {
    try {
      const pairs = [
        [LEGACY_SETTINGS_KEY, STORAGE.settings],
        [LEGACY_LAST_BOOK_KEY, STORAGE.lastBook],
        [LEGACY_VIEW_KEY, STORAGE.view],
        [LEGACY_LAST_BACKUP_KEY, STORAGE.lastBackup],
      ];
      for (const [oldKey, newKey] of pairs) {
        const value = localStorage.getItem(oldKey);
        if (value === null) continue;
        if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value);
        localStorage.removeItem(oldKey);
      }
      const chapterKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(LEGACY_CHAPTER_PREFIX)) chapterKeys.push(key);
      }
      for (const key of chapterKeys) {
        const rawBookId = key.slice(LEGACY_CHAPTER_PREFIX.length);
        const newKey = STORAGE.chapterPrefix + normalizeBookId(rawBookId);
        const value = localStorage.getItem(key);
        if (value !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value);
        localStorage.removeItem(key);
      }
      const lastBook = localStorage.getItem(STORAGE.lastBook);
      if (lastBook === LEGACY_BUILTIN_BOOK_ID) localStorage.setItem(STORAGE.lastBook, BUILTIN_BOOK_ID);
    } catch (e) {
      console.warn('[Storage] 旧版本地设置迁移失败', e);
    }
  }

  migrateLegacyStorage();

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const t = window.t;

  const state = {
    books: [],
    currentBookId: null,
    currentChapterId: null,
    view: 'both',
    settings: { fontSize: 16, theme: 'light', language: window.getLang(), bgOverlay: 0.72, pdfZoom: 'fit-width' },
    notes: [],
    pendingSelection: null,
    editingNoteId: null,
    editingTags: [],
    activeTagFilter: null,
    selectedNoteIds: new Set(),
    uploadQueue: [],
    selectedLibraryIds: new Set(),
    migrationInfo: null,
  };
  window.currentLang = state.settings.language;

  const noteRanges = new Map();
  const md = window.markdownit({ html: false, linkify: true, typographer: true });

  /* ================= 工具 ================= */
  function showToast(message, type = 'success') {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 250); }, 2200);
  }

  function cleanNoteForDB(n) {
    const note = {
      id: n.id, bookId: normalizeBookId(n.bookId), chapterId: n.chapterId,
      lang: n.lang, quote: n.quote, selector: n.selector,
      note: n.note || '', tags: Array.isArray(n.tags) ? n.tags : [],
      createdAt: n.createdAt, updatedAt: n.updatedAt || n.createdAt,
    };
    // PDF 笔记额外记录页码，md 笔记不写这两个字段，保持旧数据形状
    if (n.kind === 'pdf') {
      note.kind = 'pdf';
      const page = Number(n.page);
      if (Number.isFinite(page) && page > 0) note.page = Math.round(page);
    }
    return note;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function slugify(s) {
    return (s || 'book').toLowerCase().trim()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'book';
  }

  function isIgnoredPath(path) {
    const name = (path || '').split('/').pop();
    if (!name) return true;
    if (name.startsWith('._')) return true;
    if (name === '.DS_Store' || name === '.Thumbs.db') return true;
    if (name.startsWith('.')) return true;
    return false;
  }

  function formatDate(ts) {
    try { return new Date(ts).toLocaleString(t('date.locale')); }
    catch (e) { return new Date(ts).toLocaleString(); }
  }

  /* ================= IndexedDB ================= */
  class DB {
    constructor() {
      this.dbName = DB_NAME;
      this.version = DB_VERSION;
      this._db = null;
    }
    async open() {
      if (this._db) return this._db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, this.version);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (e.oldVersion < 1) {
            if (!db.objectStoreNames.contains('notes')) {
              db.createObjectStore('notes', { keyPath: 'id' });
            }
          }
          if (e.oldVersion < 2) {
            if (!db.objectStoreNames.contains('books')) {
              db.createObjectStore('books', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('bookFiles')) {
              db.createObjectStore('bookFiles', { keyPath: 'key' });
            }
          }
          // v3：PDF 二进制 + 背景资源。只新增 store，不改动已有记录，旧书/旧笔记零迁移。
          if (e.oldVersion < 3) {
            if (!db.objectStoreNames.contains('bookBinary')) {
              db.createObjectStore('bookBinary', { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains('assets')) {
              db.createObjectStore('assets', { keyPath: 'key' });
            }
          }
        };
        req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
        req.onerror = (e) => reject(e.target.error || new Error('IndexedDB open failed'));
        req.onblocked = () => console.warn('[DB] 数据库升级被其它标签页阻塞，请关闭其它页面后刷新');
      });
    }
    async getAll(store) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const r = db.transaction(store, 'readonly').objectStore(store).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
    }
    async get(store, key) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const r = db.transaction(store, 'readonly').objectStore(store).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    async put(store, val) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(val);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
    async bulkPut(store, vals) {
      if (!vals.length) return;
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        vals.forEach((v) => s.put(v));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
    async delete(store, key) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
    async bulkDelete(store, keys) {
      if (!keys.length) return;
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        keys.forEach((k) => s.delete(k));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
    async clear(store) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
  }
  const db = new DB();

  /* ================= 旧版数据库迁移（改名 + v2 → v3 平滑迁移） ================= */
  function openRawDatabase(name, version, upgrade) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = (event) => {
        if (upgrade) upgrade(event.target.result, event.oldVersion);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => console.warn('[DB] 旧数据库被其它标签页占用，请关闭其它页面后重试');
    });
  }

  function readAllFrom(dbHandle, storeName) {
    return new Promise((resolve) => {
      try {
        if (!dbHandle.objectStoreNames.contains(storeName)) { resolve([]); return; }
        const request = dbHandle.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  }

  async function legacyDatabaseExists() {
    try {
      if (!indexedDB.databases) return false;
      const list = await indexedDB.databases();
      return Array.isArray(list) && list.some((item) => item && item.name === LEGACY_DB_NAME);
    } catch (e) {
      return false;
    }
  }

  // 仅当新库为空且检测到旧库时复制数据，完成后删除旧库；任何异常都保留原数据。
  async function migrateLegacyDatabase() {
    try {
      if (localStorage.getItem(STORAGE.dbMigrated) === '1') return false;
      if (!(await legacyDatabaseExists())) {
        localStorage.setItem(STORAGE.dbMigrated, '1');
        return false;
      }
      const existingNotes = await db.getAll('notes');
      const existingBooks = await db.getAll('books');
      if (existingNotes.length || existingBooks.length) {
        localStorage.setItem(STORAGE.dbMigrated, '1');
        return false;
      }
      const legacy = await openRawDatabase(LEGACY_DB_NAME, DB_VERSION, (legacyDb) => {
        if (!legacyDb.objectStoreNames.contains('bookBinary')) {
          legacyDb.createObjectStore('bookBinary', { keyPath: 'key' });
        }
        if (!legacyDb.objectStoreNames.contains('assets')) {
          legacyDb.createObjectStore('assets', { keyPath: 'key' });
        }
      });
      const [legacyNotes, legacyBooks, legacyFiles, legacyBinary, legacyAssets] = await Promise.all([
        readAllFrom(legacy, 'notes'),
        readAllFrom(legacy, 'books'),
        readAllFrom(legacy, 'bookFiles'),
        readAllFrom(legacy, 'bookBinary'),
        readAllFrom(legacy, 'assets'),
      ]);
      legacy.close();
      if (legacyNotes.length) {
        await db.bulkPut('notes', legacyNotes.map((note) => cleanNoteForDB({ ...note, bookId: normalizeBookId(note.bookId) })));
      }
      if (legacyBooks.length) {
        await db.bulkPut('books', legacyBooks.map((book) => ({ ...book, kind: book.kind || 'markdown' })));
      }
      if (legacyFiles.length) await db.bulkPut('bookFiles', legacyFiles);
      if (legacyBinary.length) await db.bulkPut('bookBinary', legacyBinary);
      if (legacyAssets.length) await db.bulkPut('assets', legacyAssets);
      try {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(LEGACY_DB_NAME);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        });
      } catch (e) { console.warn('[DB] 旧数据库删除失败（不影响使用）', e); }
      localStorage.setItem(STORAGE.dbMigrated, '1');
      if (legacyNotes.length || legacyBooks.length) {
        state.migrationInfo = { notes: legacyNotes.length, books: legacyBooks.length };
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[DB] 旧数据库迁移失败，保留原数据', e);
      return false;
    }
  }

  /* ================= 路径解析 ================= */
  function resolveBuiltinPath(book, chapterPath) {
    if (!chapterPath) return '';
    if (!book.path) return chapterPath;
    if (chapterPath.startsWith(book.path + '/')) return chapterPath;
    return `${book.path}/${chapterPath}`;
  }

  function relativeTo(path, root) {
    if (!root) return path;
    if (path.startsWith(root + '/')) return path.slice(root.length + 1);
    return path;
  }

  /* ================= 书库加载 ================= */
  async function loadBuiltinBooks() {
    let library;
    try {
      const res = await fetch('content/library.json', { cache: 'no-cache' });
      library = res.ok ? await res.json() : { books: [] };
    } catch (e) {
      library = { books: [] };
    }
    if (!library || !Array.isArray(library.books)) library = { books: [] };

    const out = [];
    for (const entry of library.books) {
      if (!entry || !entry.id || !entry.path) continue;
      try {
        const manifestPath = `${entry.path}/manifest.json`;
        const res = await fetch(manifestPath, { cache: 'no-cache' });
        if (!res.ok) { console.warn(`[Library] ${entry.id} manifest load failed`); continue; }
        const manifest = await res.json();
        out.push({
          id: entry.id,
          title: manifest.title || entry.id,
          path: entry.path,
          isBuiltin: true,
          kind: 'markdown',
          chapters: manifest.chapters || [],
          createdAt: entry.createdAt || Date.now(),
          updatedAt: Date.now(),
        });
      } catch (e) {
        console.warn(`[Library] ${entry.id} load failed`, e);
      }
    }
    return out;
  }

  async function loadLibrary() {
    const builtin = await loadBuiltinBooks();
    const uploadedAll = await db.getAll('books');
    // 旧记录的 kind 缺省视为 markdown，无需写回数据库
    const uploaded = uploadedAll.filter((b) => !b.isBuiltin).map((b) => ({ ...b, kind: b.kind || 'markdown' }));

    const builtinIds = new Set(builtin.map((b) => b.id));
    const stale = uploadedAll.filter((b) => b.isBuiltin && !builtinIds.has(b.id));
    if (stale.length) await db.bulkDelete('books', stale.map((b) => b.id));

    const merged = [...builtin, ...uploaded];
    merged.sort((a, b) => {
      if (a.isBuiltin && !b.isBuiltin) return -1;
      if (!a.isBuiltin && b.isBuiltin) return 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    state.books = merged;
    renderBookSelect();
  }

  function renderBookSelect() {
    const sel = $('#book-select');
    sel.innerHTML = '';
    state.books.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.title + (b.isBuiltin ? t('book.builtin-suffix') : '');
      sel.appendChild(opt);
    });
    if (state.currentBookId) sel.value = state.currentBookId;
  }

  async function switchBook(bookId) {
    const book = state.books.find((b) => b.id === bookId);
    if (!book) return;
    await closeActiveReader();
    state.currentBookId = bookId;
    state.currentChapterId = null;
    state.activeTagFilter = null;
    state.selectedNoteIds.clear();
    localStorage.setItem(STORAGE.lastBook, bookId);
    $('#book-select').value = bookId;
    renderChapterSelect(book);

    if (!book.chapters.length) {
      ensureMarkdownPanes();
      $('#pane-zh .markdown-body').innerHTML = `<h1>${t('chapter.no-chapters-zh')}</h1>`;
      $('#pane-en .markdown-body').innerHTML = `<h1>${t('chapter.no-chapters-en')}</h1>`;
      $('#toc-list').innerHTML = '';
      refreshNotesUI();
      updateReadingProgress();
      return;
    }

    if (book.kind === 'pdf') {
      await openPdfBook(book);
      return;
    }

    ensureMarkdownPanes();
    let lastId = null;
    try { lastId = localStorage.getItem(STORAGE.chapterPrefix + bookId); } catch (e) {}
    const chapterId = book.chapters.find((c) => c.id === lastId)?.id || book.chapters[0].id;
    await loadChapter(chapterId);
  }

  function chapterLabel(book, chapter) {
    if (book.kind === 'pdf') {
      const title = chapter.title || '';
      const start = chapter.startPage;
      const end = chapter.endPage;
      // 无书签兜底章节的标题本身就是页码范围，避免展示成“第 1–3 页（第 1–3 页）”
      if (title === `第 ${start}–${end} 页` || title === `Pages ${start}–${end}`) return title;
      return t('pdf.chapter-label', { title, start, end });
    }
    return `${chapter.titleZh || chapter.id} / ${chapter.titleEn || chapter.id}`;
  }

  function renderChapterSelect(book) {
    const cSel = $('#chapter-select');
    cSel.innerHTML = '';
    (book.chapters || []).forEach((ch) => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = chapterLabel(book, ch);
      cSel.appendChild(opt);
    });
  }

  // PDF 阅读会替换 #pane-zh 内容，切回 markdown 书时恢复原有结构
  function ensureMarkdownPanes() {
    const zh = $('#pane-zh');
    if (zh && !zh.querySelector('.markdown-body')) zh.innerHTML = '<article class="markdown-body"></article>';
    const en = $('#pane-en');
    if (en && !en.querySelector('.markdown-body')) en.innerHTML = '<article class="markdown-body"></article>';
  }

  async function loadBookFile(book, chapterPath) {
    if (!chapterPath) return '';
    if (book.isBuiltin) {
      const fullPath = resolveBuiltinPath(book, chapterPath);
      const res = await fetch(fullPath, { cache: 'no-cache' });
      return res.ok ? res.text() : '';
    }

    const cleaned = chapterPath.replace(/^\.?\//, '');
    const candidates = new Set([cleaned]);
    if (cleaned.startsWith('content/')) {
      candidates.add(cleaned.slice('content/'.length));
    }
    const firstSlash = cleaned.indexOf('/');
    if (firstSlash > 0) {
      const rest = cleaned.slice(firstSlash + 1);
      if (rest.startsWith('zh/') || rest.startsWith('en/')) candidates.add(rest);
    }

    for (const rel of candidates) {
      const f = await db.get('bookFiles', `${book.id}/${rel}`);
      if (f) return f.content;
    }

    const targetBasename = cleaned.split('/').pop();
    const allFiles = await db.getAll('bookFiles');
    const match = allFiles.find((f) =>
      f.bookId === book.id && f.path.split('/').pop() === targetBasename
    );
    return match ? match.content : '';
  }

  async function refreshBuiltinBook(bookId) {
    showToast(t('toast.refreshing'));
    try {
      await loadLibrary();
      if (state.currentBookId === bookId) await switchBook(bookId);
      if (!$('#library-dialog').classList.contains('hidden')) renderLibraryList();
      showToast(t('toast.refreshed'));
    } catch (e) {
      showToast(t('toast.refresh-failed', { msg: e.message }), 'error');
    }
  }

  /* ================= 书库管理 ================= */
  function openLibraryManager() {
    state.selectedLibraryIds.clear();
    $('#library-status').textContent = '';
    $('#library-status').className = 'upload-status';
    renderLibraryList();
    $('#library-dialog').classList.remove('hidden');
  }

  function renderLibraryList() {
    const wrap = $('#library-list');
    wrap.innerHTML = '';
    if (!state.books.length) {
      wrap.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary)">${t('library.empty')}</div>`;
      updateLibraryButtons();
      return;
    }

    state.books.forEach((book) => {
      const card = document.createElement('div');
      card.className = 'upload-book-card';

      const header = document.createElement('div');
      header.className = 'upload-book-card-header';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = !!book.isBuiltin;
      cb.checked = state.selectedLibraryIds.has(book.id);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedLibraryIds.add(book.id);
        else state.selectedLibraryIds.delete(book.id);
        updateLibraryButtons();
      });

      const titleEl = document.createElement('span');
      titleEl.className = 'upload-book-title';
      titleEl.style.background = 'transparent';
      titleEl.style.border = 'none';
      titleEl.style.cursor = 'default';
      titleEl.textContent = book.title + (book.isBuiltin ? t('book.builtin-suffix') : '');

      const meta = document.createElement('span');
      meta.className = 'upload-book-meta';
      if (book.kind === 'pdf') {
        meta.textContent = t('library.meta-pdf', { chapters: book.chapters.length, pages: book.pageCount || 0 });
      } else if (book.isBuiltin) {
        meta.textContent = t('library.meta-builtin', { n: book.chapters.length });
      } else {
        meta.textContent = t('library.meta-uploaded', { n: book.chapters.length });
      }

      header.append(cb, titleEl, meta);

      if (book.kind === 'pdf') {
        const langBadge = document.createElement('span');
        langBadge.className = 'tag';
        langBadge.textContent = book.lang === 'zh' ? t('lang.zh') : t('lang.en');
        langBadge.title = t('lang.source.default');
        if (book.langSource === 'user') langBadge.title = t('lang.source.user');
        else if (book.langSource === 'conflict') langBadge.title = t('lang.source.conflict');
        else if (book.langSource === 'filename') langBadge.title = t('lang.source.filename');
        header.appendChild(langBadge);
      }

      if (book.isBuiltin) {
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'upload-book-toggle';
        refreshBtn.textContent = '🔄';
        refreshBtn.title = t('library.refresh-title');
        refreshBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          refreshBuiltinBook(book.id);
        });
        header.appendChild(refreshBtn);
      }

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'upload-book-toggle';
      toggleBtn.textContent = t('library.chapters');
      const chaptersBox = document.createElement('div');
      chaptersBox.className = 'upload-book-chapters';
      chaptersBox.style.display = 'none';
      const ol = document.createElement('ol');
      book.chapters.forEach((ch) => {
        const li = document.createElement('li');
        li.textContent = chapterLabel(book, ch);
        ol.appendChild(li);
      });
      chaptersBox.appendChild(ol);
      toggleBtn.addEventListener('click', () => {
        chaptersBox.style.display = chaptersBox.style.display === 'none' ? 'block' : 'none';
      });
      header.appendChild(toggleBtn);

      card.append(header, chaptersBox);
      wrap.appendChild(card);
    });

    updateLibraryButtons();
  }

  function updateLibraryButtons() {
    const n = state.selectedLibraryIds.size;
    const exportBtn = $('#library-export');
    const deleteBtn = $('#library-delete');
    exportBtn.disabled = n === 0;
    deleteBtn.disabled = n === 0;
    exportBtn.textContent = n > 0 ? t('library.export', { n }) : t('library.export-empty');
    deleteBtn.textContent = n > 0 ? t('library.delete', { n }) : t('library.delete-empty');
  }

  async function exportFromLibrary() {
    const ids = Array.from(state.selectedLibraryIds);
    if (!ids.length) { showToast(t('toast.no-selection'), 'error'); return; }

    const allFiles = await db.getAll('bookFiles');
    const entries = [];
    let skippedPdf = 0;
    for (const id of ids) {
      const book = await db.get('books', id);
      if (!book || book.isBuiltin) continue;
      if (book.kind === 'pdf') { skippedPdf += 1; continue; }
      const files = allFiles
        .filter((f) => f.bookId === id)
        .map((f) => ({ path: f.path, content: f.content }));
      entries.push({ title: book.title, chapters: book.chapters, files });
    }
    if (skippedPdf) showToast(t('library.pdf-export-unsupported'), 'error');
    if (!entries.length) return;
    await packageAsRepoZip(entries);
  }

  async function deleteFromLibrary() {
    const ids = Array.from(state.selectedLibraryIds);
    if (!ids.length) return;

    const books = await db.getAll('books');
    const toDelete = books.filter((b) => ids.includes(b.id) && !b.isBuiltin);
    if (!toDelete.length) return;

    const allNotes = await db.getAll('notes');
    const noteIds = allNotes.filter((n) => ids.includes(n.bookId)).map((n) => n.id);
    const allFiles = await db.getAll('bookFiles');
    const fileKeys = allFiles.filter((f) => ids.includes(f.bookId)).map((f) => f.key);
    const allBinary = await db.getAll('bookBinary');
    const binaryKeys = allBinary.filter((f) => ids.includes(f.bookId)).map((f) => f.key);

    if (!confirm(t('library.confirm-delete', {
      books: toDelete.length,
      notes: noteIds.length,
      files: fileKeys.length + binaryKeys.length,
    }))) return;

    try {
      await db.bulkDelete('books', toDelete.map((b) => b.id));
      await db.bulkDelete('bookFiles', fileKeys);
      await db.bulkDelete('bookBinary', binaryKeys);
      await db.bulkDelete('notes', noteIds);

      state.selectedLibraryIds.clear();
      await loadLibrary();
      await loadNotes();

      if (ids.includes(state.currentBookId)) {
        const builtin = state.books.find((b) => b.isBuiltin);
        if (builtin) await switchBook(builtin.id);
      }

      renderLibraryList();
      refreshNotesUI();
      applyHighlights();
      showToast(t('library.toast-deleted', { n: toDelete.length }));
    } catch (e) {
      console.error(e);
      showToast(t('library.toast-delete-failed', { msg: e.message }), 'error');
    }
  }

  /* ================= TextQuoteSelector ================= */
  function serializeSelection(range) {
    const exact = range.toString();
    if (!exact) return null;
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const article = startEl.closest('.markdown-body, .pdf-text-layer');
    if (!article) return null;
    const pre = document.createRange();
    pre.selectNodeContents(article);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = pre.toString();
    const post = document.createRange();
    post.selectNodeContents(article);
    post.setStart(range.endContainer, range.endOffset);
    const after = post.toString();
    return { exact, prefix: before.slice(-32), suffix: after.slice(0, 32), position: before.length };
  }

  function findNodeAt(textNodes, pos) {
    let last = null;
    for (const tn of textNodes) {
      if (pos >= tn.start && pos <= tn.start + tn.node.nodeValue.length) return tn;
      last = tn;
    }
    return last;
  }

  function findTextPosition(article, selector) {
    if (!selector || !selector.exact) return null;
    const { exact, prefix = '', suffix = '', position = 0 } = selector;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const tns = [];
    let full = '';
    let n;
    while ((n = walker.nextNode())) { tns.push({ node: n, start: full.length }); full += n.nodeValue; }
    if (!full) return null;
    const matches = [];
    let i = 0;
    while ((i = full.indexOf(exact, i)) !== -1) { matches.push(i); i++; }
    if (!matches.length) return null;
    let best = matches[0], bestScore = -Infinity;
    for (const m of matches) {
      let s = 0;
      const b = full.slice(Math.max(0, m - prefix.length), m);
      const a = full.slice(m + exact.length, m + exact.length + suffix.length);
      if (prefix && b.endsWith(prefix)) s += 20;
      else if (prefix && b && prefix.endsWith(b)) s += b.length / 2;
      if (suffix && a.startsWith(suffix)) s += 20;
      else if (suffix && a && suffix.startsWith(a)) s += a.length / 2;
      s -= Math.abs(m - position) / 1000;
      if (s > bestScore) { bestScore = s; best = m; }
    }
    const startTn = findNodeAt(tns, best);
    const endTn = findNodeAt(tns, best + exact.length);
    if (!startTn || !endTn) return null;
    const range = document.createRange();
    range.setStart(startTn.node, best - startTn.start);
    range.setEnd(endTn.node, best + exact.length - endTn.start);
    return range;
  }

  /* ================= Highlight ================= */
  const HL_NAME = 'reader-note';
  const hasHighlightAPI = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  function clearHighlights() {
    noteRanges.clear();
    if (hasHighlightAPI()) { CSS.highlights.delete(HL_NAME); return; }
    $$('.markdown-body mark[data-note-id]').forEach((m) => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m); p.normalize();
    });
  }

  function applyHighlights() {
    if (pdfReader) { applyAllPdfHighlights(); return; }
    clearHighlights();
    const notes = state.notes.filter((n) =>
      n.bookId === state.currentBookId && n.chapterId === state.currentChapterId && n.kind !== 'pdf');
    const useAPI = hasHighlightAPI();
    const hl = useAPI ? new Highlight() : null;
    for (const note of notes) {
      if (!note.selector) continue;
      const article = note.lang === 'zh' ? $('#pane-zh .markdown-body') : $('#pane-en .markdown-body');
      const range = findTextPosition(article, note.selector);
      if (!range) continue;
      noteRanges.set(note.id, range);
      if (useAPI) hl.add(range);
      else {
        try { const m = document.createElement('mark'); m.dataset.noteId = note.id; range.surroundContents(m); } catch (e) {}
      }
    }
    if (useAPI && hl.size > 0) CSS.highlights.set(HL_NAME, hl);
  }

  function handleContentClick(e) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (!hasHighlightAPI()) return;
    let pr = null;
    if (document.caretRangeFromPoint) pr = document.caretRangeFromPoint(e.clientX, e.clientY);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) { pr = document.createRange(); pr.setStart(p.offsetNode, p.offset); pr.setEnd(p.offsetNode, p.offset); }
    }
    if (!pr) return;
    for (const note of state.notes) {
      if (note.bookId !== state.currentBookId) continue;
      if (note.kind === 'pdf' ? !pdfReader : note.chapterId !== state.currentChapterId) continue;
      const range = noteRanges.get(note.id);
      if (!range) continue;
      if (range.isPointInRange(pr.startContainer, pr.startOffset)) {
        $('#notes-panel').classList.remove('hidden');
        refreshNotesUI();
        const item = document.querySelector(`#notes-list [data-note-id="${note.id}"]`);
        if (item) { item.scrollIntoView({ block: 'nearest' }); item.style.background = 'var(--highlight)'; setTimeout(() => item.style.background = '', 1200); }
        return;
      }
    }
  }

  /* ================= 阅读进度 ================= */
  function updateReadingProgress() {
    if (pdfReader) {
      const total = pdfReader.getPageCount() || 1;
      const pct = (pdfReader.getCurrentPage() / total) * 100;
      $('#reading-progress-bar').style.width = Math.max(0, Math.min(100, pct)).toFixed(2) + '%';
      return;
    }
    const pane = state.view === 'en' ? $('#pane-en') : $('#pane-zh');
    const max = pane.scrollHeight - pane.clientHeight;
    const pct = max > 0 ? (pane.scrollTop / max) * 100 : 0;
    $('#reading-progress-bar').style.width = pct.toFixed(2) + '%';
  }

  /* ================= 设置 ================= */
  function loadSettings() {
    try {
      Object.assign(state.settings, JSON.parse(localStorage.getItem(STORAGE.settings) || '{}'));
    } catch (e) {}
    if (!state.settings.language) state.settings.language = window.getLang();
    if (typeof state.settings.bgOverlay !== 'number' || Number.isNaN(state.settings.bgOverlay)) {
      state.settings.bgOverlay = 0.72;
    }
    state.settings.bgOverlay = Math.min(1, Math.max(0, state.settings.bgOverlay));
    if (!state.settings.pdfZoom) state.settings.pdfZoom = 'fit-width';
    window.currentLang = state.settings.language;
    $('#language-select').value = state.settings.language;
    applySettings();
  }
  function saveSettings() { localStorage.setItem(STORAGE.settings, JSON.stringify(state.settings)); }
  function applySettings() {
    document.documentElement.style.setProperty('--font-size', state.settings.fontSize + 'px');
    document.documentElement.setAttribute('data-theme', state.settings.theme);
    applyBackgroundLayer();
  }

  /* ================= 笔记 ================= */
  async function loadNotes() {
    state.notes = (await db.getAll('notes'))
      .map(cleanNoteForDB)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ================= 章节加载 ================= */
  async function loadChapter(chapterId) {
    if (state.books.find((b) => b.id === state.currentBookId)?.kind === 'pdf') {
      const pdfBook = state.books.find((b) => b.id === state.currentBookId);
      const target = pdfBook.chapters.find((c) => c.id === chapterId);
      if (target && pdfReader) await pdfReader.goToPage(target.startPage);
      return;
    }
    ensureMarkdownPanes();
    const book = state.books.find((b) => b.id === state.currentBookId);
    if (!book) return;
    const ch = book.chapters.find((c) => c.id === chapterId);
    if (!ch) return;
    state.currentChapterId = chapterId;
    $('#chapter-select').value = chapterId;
    localStorage.setItem(STORAGE.chapterPrefix + state.currentBookId, chapterId);
    state.selectedNoteIds.clear();
    state.activeTagFilter = null;

    const [zhText, enText] = await Promise.all([
      loadBookFile(book, ch.zh),
      loadBookFile(book, ch.en),
    ]);

    $('#pane-zh .markdown-body').innerHTML = DOMPurify.sanitize(md.render(zhText || t('chapter.load-failed-zh')));
    $('#pane-en .markdown-body').innerHTML = DOMPurify.sanitize(md.render(enText || t('chapter.load-failed-en')));

    addAnchors($('#pane-zh .markdown-body'));
    addAnchors($('#pane-en .markdown-body'));
    buildToc($('#pane-zh .markdown-body'));
    applyHighlights();
    refreshNotesUI();
    $('#pane-zh').scrollTop = 0;
    $('#pane-en').scrollTop = 0;
    updateReadingProgress();
  }

  function slugifyHeading(t) {
    return t.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function addAnchors(container) {
    const used = new Set();
    container.querySelectorAll('h1,h2,h3,h4').forEach((h, i) => {
      const base = slugifyHeading(h.textContent) || 'h-' + i;
      let id = base, n = 1;
      while (used.has(id)) id = base + '-' + n++;
      used.add(id);
      h.id = id;
    });
  }

  /* ================= TOC ================= */
  let scrollSpy = null;
  function buildToc(container) {
    const toc = $('#toc-list');
    toc.innerHTML = '';
    container.querySelectorAll('h1,h2,h3').forEach((h) => {
      const level = parseInt(h.tagName[1], 10);
      const li = document.createElement('li');
      li.className = 'level-' + level;
      const a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      a.dataset.target = h.id;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        ['#pane-zh', '#pane-en'].forEach((sel) => {
          const el = $(sel).querySelector('#' + CSS.escape(h.id));
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      li.appendChild(a);
      toc.appendChild(li);
    });
    if (scrollSpy) scrollSpy.disconnect();
    scrollSpy = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          $$('#toc-list a').forEach((a) => a.classList.toggle('active', a.dataset.target === e.target.id));
        }
      });
    }, { root: $('#pane-zh'), rootMargin: '-10% 0px -70% 0px', threshold: 0 });
    container.querySelectorAll('h1,h2,h3').forEach((h) => scrollSpy.observe(h));
  }

  /* ================= 视图 ================= */
  function setView(view) {
    state.view = view;
    $$('.view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.body.classList.remove('view-zh', 'view-en', 'view-both');
    document.body.classList.add('view-' + view);
    localStorage.setItem(STORAGE.view, view);
    setTimeout(updateReadingProgress, 0);
  }

  /* ================= 选区 ================= */
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('.selection-toolbar') || e.target.closest('.modal')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel.toString().trim();
      if (!text) { hideSelectionToolbar(); return; }
      const range = sel.getRangeAt(0);
      const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
      const startPageEl = startEl && startEl.closest ? startEl.closest('.pdf-page') : null;
      const endPageEl = endEl && endEl.closest ? endEl.closest('.pdf-page') : null;
      const rect = range.getBoundingClientRect();
      const tb = $('#selection-toolbar');
      tb.classList.remove('hidden');
      tb.style.top = Math.max(8, rect.top - 44) + 'px';
      tb.style.left = Math.max(8, rect.left + rect.width / 2 - 60) + 'px';

      if (startPageEl || endPageEl) {
        if (!pdfReader) { hideSelectionToolbar(); return; }
        if (!startPageEl || !endPageEl || startPageEl !== endPageEl) {
          hideSelectionToolbar();
          showToast(t('pdf.cross-page'), 'error');
          return;
        }
        state.pendingSelection = {
          text,
          lang: (pdfViewerBook && pdfViewerBook.lang) || 'zh',
          chapterId: (pdfViewerBook && chapterAtPage(pdfViewerBook, parseInt(startPageEl.dataset.page, 10)) || {}).id
            || state.currentChapterId,
          bookId: state.currentBookId,
          page: parseInt(startPageEl.dataset.page, 10),
          kind: 'pdf',
          selector: serializeSelection(range.cloneRange()),
        };
        return;
      }

      const node = range.commonAncestorContainer;
      const pane = (node.nodeType === 1 ? node : node.parentElement)?.closest('.pane');
      if (!pane) { hideSelectionToolbar(); return; }
      state.pendingSelection = {
        text, lang: pane.id === 'pane-zh' ? 'zh' : 'en',
        chapterId: state.currentChapterId, bookId: state.currentBookId,
        selector: serializeSelection(range.cloneRange()),
      };
    }, 0);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.selection-toolbar') && !e.target.closest('.modal-content')) hideSelectionToolbar();
  });
  function hideSelectionToolbar() { $('#selection-toolbar').classList.add('hidden'); }

  $('#selection-toolbar').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !state.pendingSelection) return;
    if (btn.dataset.action === 'highlight') {
      try { await addNote(state.pendingSelection.text, '', state.pendingSelection, []); showToast(t('toast.highlight-saved')); }
      catch (err) { showToast(t('toast.save-failed', { msg: err.message }), 'error'); }
    } else if (btn.dataset.action === 'note') {
      openNoteDialog(state.pendingSelection.text, '', null, []);
    }
    hideSelectionToolbar();
    window.getSelection().removeAllRanges();
  });

  /* ================= 标签 ================= */
  function getGlobalTags() {
    const set = new Set();
    state.notes.filter((n) => n.bookId === state.currentBookId)
      .forEach((n) => (n.tags || []).forEach((tag) => set.add(tag)));
    return Array.from(set).sort();
  }

  function renderTagEditor() {
    const ed = $('#note-tags-editor');
    ed.innerHTML = '';
    state.editingTags.forEach((tag, i) => {
      const s = document.createElement('span');
      s.className = 'tag';
      s.textContent = tag;
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '×'; b.title = '×';
      b.addEventListener('click', () => { state.editingTags.splice(i, 1); refreshTagEditorUI(); });
      s.appendChild(b);
      ed.appendChild(s);
    });
  }

  function renderTagSuggestions() {
    const wrap = $('#note-tag-suggestions');
    if (!wrap) return;
    wrap.innerHTML = '';
    const q = ($('#note-tag-input').value || '').trim().toLowerCase();
    getGlobalTags()
      .filter((tag) => !state.editingTags.includes(tag))
      .filter((tag) => !q || tag.toLowerCase().includes(q))
      .forEach((tag) => {
        const el = document.createElement('span');
        el.className = 'tag clickable';
        el.textContent = tag;
        el.addEventListener('click', () => {
          if (!state.editingTags.includes(tag)) {
            state.editingTags.push(tag);
            $('#note-tag-input').value = '';
            refreshTagEditorUI();
            $('#note-tag-input').focus();
          }
        });
        wrap.appendChild(el);
      });
  }

  function refreshTagEditorUI() { renderTagEditor(); renderTagSuggestions(); }

  $('#note-tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = e.target.value.trim().replace(/[,，]/g, '');
      if (v && !state.editingTags.includes(v)) {
        state.editingTags.push(v); e.target.value = ''; refreshTagEditorUI();
      } else if (v) { e.target.value = ''; renderTagSuggestions(); }
    } else if (e.key === 'Backspace' && e.target.value === '' && state.editingTags.length) {
      state.editingTags.pop(); refreshTagEditorUI();
    }
  });
  $('#note-tag-input').addEventListener('input', () => renderTagSuggestions());

  /* ================= 笔记弹窗 ================= */
  function openNoteDialog(quote, existingNote, editId, existingTags) {
    state.editingNoteId = editId;
    state.editingTags = Array.isArray(existingTags) ? [...existingTags] : [];
    $('#note-quote').textContent = quote;
    $('#note-input').value = existingNote || '';
    $('#note-tag-input').value = '';
    refreshTagEditorUI();
    $('#note-dialog').classList.remove('hidden');
    setTimeout(() => $('#note-input').focus(), 30);
  }
  function closeNoteDialog() {
    $('#note-dialog').classList.add('hidden');
    state.editingNoteId = null;
    state.editingTags = [];
  }
  $('#note-cancel').addEventListener('click', closeNoteDialog);

  $('#note-save').addEventListener('click', async () => {
    const noteText = $('#note-input').value.trim();
    const tags = [...state.editingTags];
    const editingId = state.editingNoteId;
    try {
      if (editingId) {
        const n = state.notes.find((x) => x.id === editingId);
        if (!n) { showToast(t('toast.note-not-found'), 'error'); closeNoteDialog(); return; }
        await db.put('notes', cleanNoteForDB({ ...n, note: noteText, tags, updatedAt: Date.now() }));
        await loadNotes();
        refreshNotesUI(); applyHighlights();
        showToast(t('toast.note-updated'));
      } else if (state.pendingSelection) {
        await addNote(state.pendingSelection.text, noteText, state.pendingSelection, tags);
        showToast(t('toast.note-saved'));
      }
    } catch (e) {
      console.error(e);
      showToast(t('toast.save-failed', { msg: e.message }), 'error');
    }
    closeNoteDialog();
  });

  async function addNote(quote, noteText, selInfo, tags = []) {
    const note = {
      id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      bookId: normalizeBookId(selInfo.bookId || state.currentBookId),
      chapterId: selInfo.chapterId || state.currentChapterId,
      lang: selInfo.lang || 'zh',
      quote,
      selector: selInfo.selector || { exact: quote, prefix: '', suffix: '', position: 0 },
      note: noteText, tags: tags || [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    if (selInfo.kind === 'pdf') {
      note.kind = 'pdf';
      note.page = selInfo.page;
    }
    await db.put('notes', cleanNoteForDB(note));
    await loadNotes();
    refreshNotesUI(); applyHighlights();
  }

  /* ================= 笔记列表 ================= */
  function getFilteredNotes() {
    const pdfMode = !!pdfReader;
    return state.notes.filter((n) => {
      if (n.bookId !== state.currentBookId) return false;
      if (state.activeTagFilter && !(n.tags || []).includes(state.activeTagFilter)) return false;
      if (pdfMode) return true; // PDF 书按整本展示，列表里按页码排序
      if (n.chapterId !== state.currentChapterId || n.kind === 'pdf') return false;
      return true;
    });
  }

  function getAllTags() {
    const set = new Set();
    state.notes.filter((n) => n.bookId === state.currentBookId && n.chapterId === state.currentChapterId)
      .forEach((n) => (n.tags || []).forEach((tag) => set.add(tag)));
    return Array.from(set).sort();
  }

  function renderTagFilter() {
    const wrap = $('#tag-filter');
    wrap.innerHTML = '';
    const tags = getAllTags();
    if (!tags.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    tags.forEach((tag) => {
      const el = document.createElement('span');
      el.className = 'tag clickable' + (state.activeTagFilter === tag ? ' active' : '');
      el.textContent = tag;
      el.addEventListener('click', () => {
        state.activeTagFilter = state.activeTagFilter === tag ? null : tag;
        refreshNotesUI();
      });
      wrap.appendChild(el);
    });
  }

  function updateBatchControls() {
    const vis = getFilteredNotes();
    const cnt = state.selectedNoteIds.size;
    const btn = $('#batch-delete-notes');
    btn.disabled = cnt === 0;
    btn.textContent = cnt > 0 ? t('notes.batch-delete-with-count', { n: cnt }) : t('notes.batch-delete');
    const all = vis.length > 0 && vis.every((n) => state.selectedNoteIds.has(n.id));
    const some = vis.some((n) => state.selectedNoteIds.has(n.id));
    const cb = $('#select-all-notes');
    cb.checked = all; cb.indeterminate = !all && some; cb.disabled = vis.length === 0;
  }

  function renderNotesList() {
    const list = $('#notes-list');
    list.innerHTML = '';
    let vis = getFilteredNotes();
    if (pdfReader) vis = vis.slice().sort((a, b) => ((a.page || 0) - (b.page || 0)) || (a.createdAt - b.createdAt));
    if (!vis.length) {
      const hint = state.activeTagFilter
        ? t('notes.empty-tag', { tag: state.activeTagFilter })
        : (pdfReader ? t('notes.empty-book') : t('notes.empty-chapter'));
      list.innerHTML = `<li style="cursor:default;color:var(--text-secondary)">${hint}</li>`;
      return;
    }
    vis.forEach((n) => {
      const li = document.createElement('li');
      li.dataset.noteId = n.id;
      li.classList.toggle('selected', state.selectedNoteIds.has(n.id));
      const head = document.createElement('div');
      head.className = 'note-row-head';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selectedNoteIds.has(n.id);
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        if (cb.checked) state.selectedNoteIds.add(n.id); else state.selectedNoteIds.delete(n.id);
        li.classList.toggle('selected', cb.checked);
        updateBatchControls();
      });
      cb.addEventListener('click', (e) => e.stopPropagation());
      const main = document.createElement('div');
      main.className = 'note-main';
      const quote = document.createElement('div');
      quote.className = 'note-quote-text';
      quote.textContent = n.quote;
      main.appendChild(quote);
      if (n.tags && n.tags.length) {
        const tw = document.createElement('div');
        tw.className = 'note-tags';
        n.tags.forEach((tag) => {
          const el = document.createElement('span');
          el.className = 'tag clickable';
          el.textContent = tag;
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            state.activeTagFilter = state.activeTagFilter === tag ? null : tag;
            refreshNotesUI();
          });
          tw.appendChild(el);
        });
        main.appendChild(tw);
      }
      const body = document.createElement('div');
      body.className = 'note-body';
      body.textContent = n.note || t('notes.highlight-only');
      main.appendChild(body);
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      if (n.kind === 'pdf') {
        meta.textContent = t('notes.pdf-meta', {
          page: n.page || 1,
          lang: n.lang === 'zh' ? t('notes.lang-zh') : t('notes.lang-en'),
          date: formatDate(n.createdAt),
        });
      } else {
        meta.textContent = (n.lang === 'zh' ? t('notes.lang-zh') : t('notes.lang-en'))
          + ' · ' + formatDate(n.createdAt);
      }
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'note-actions';
      const jb = document.createElement('button'); jb.textContent = t('notes.jump');
      jb.addEventListener('click', (e) => { e.stopPropagation(); jumpToNote(n); });
      const eb = document.createElement('button'); eb.textContent = t('notes.edit');
      eb.addEventListener('click', (e) => { e.stopPropagation(); openNoteDialog(n.quote, n.note, n.id, n.tags); });
      const db_ = document.createElement('button'); db_.textContent = t('notes.delete');
      db_.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(n.id); });
      actions.append(jb, eb, db_);
      main.appendChild(actions);
      head.appendChild(cb); head.appendChild(main);
      li.appendChild(head);
      li.addEventListener('click', (e) => {
        if (e.target.closest('input, button, .tag')) return;
        jumpToNote(n);
      });
      list.appendChild(li);
    });
  }

  function refreshNotesUI() { renderTagFilter(); renderNotesList(); updateBatchControls(); }

  async function deleteNote(id) {
    if (!confirm(t('notes.confirm-delete-one'))) return;
    try {
      await db.delete('notes', id);
      state.selectedNoteIds.delete(id);
      await loadNotes();
      refreshNotesUI(); applyHighlights();
      showToast(t('toast.deleted-one'));
    } catch (e) { showToast(t('toast.delete-failed', { msg: e.message }), 'error'); }
  }

  $('#select-all-notes').addEventListener('change', (e) => {
    const vis = getFilteredNotes();
    if (e.target.checked) vis.forEach((n) => state.selectedNoteIds.add(n.id));
    else vis.forEach((n) => state.selectedNoteIds.delete(n.id));
    renderNotesList(); updateBatchControls();
  });

  $('#batch-delete-notes').addEventListener('click', async () => {
    const ids = Array.from(state.selectedNoteIds);
    if (!ids.length) return;
    if (!confirm(t('notes.confirm-delete-batch', { n: ids.length }))) return;
    try {
      await db.bulkDelete('notes', ids);
      state.selectedNoteIds.clear();
      await loadNotes();
      refreshNotesUI(); applyHighlights();
      showToast(t('toast.deleted-batch', { n: ids.length }));
    } catch (e) { showToast(t('toast.batch-delete-failed', { msg: e.message }), 'error'); }
  });

  function jumpToNote(note) {
    if (note.kind === 'pdf') { jumpToPdfNote(note); return; }
    let range = noteRanges.get(note.id);
    if (!range) {
      const article = note.lang === 'zh' ? $('#pane-zh .markdown-body') : $('#pane-en .markdown-body');
      if (article && note.selector) {
        range = findTextPosition(article, note.selector);
        if (range) noteRanges.set(note.id, range);
      }
    }
    if (range) {
      const el = range.startContainer.parentElement;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const old = el.style.background;
      el.style.transition = 'background 0.3s';
      el.style.background = 'var(--highlight)';
      setTimeout(() => el.style.background = old, 1500);
    }
  }

  /* ================= 上传：多书分组 ================= */
  function findBookRoot(path) {
    if (path.endsWith('manifest.json')) {
      const idx = path.lastIndexOf('/');
      return idx >= 0 ? path.slice(0, idx) : '';
    }
    const m = path.match(/^(.*?)(?:\/|^)(?:zh|en)\/[^/]+\.md$/i);
    if (m) return m[1];
    return null;
  }

  function groupFilesByBook(files) {
    const roots = new Map();
    for (const f of files) {
      if (isIgnoredPath(f.path)) continue;
      const root = findBookRoot(f.path);
      if (root === null) continue;
      if (!roots.has(root)) roots.set(root, []);
      roots.get(root).push(f);
    }
    return Array.from(roots.entries()).map(([root, fs]) => ({ root, files: fs }));
  }

  function extractTitleFromMd(content, fallback) {
    const m = content.match(/^#\s+(.+?)\s*$/m);
    return m ? m[1].trim() : fallback;
  }

  const ZH_DIGITS = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function zhNumToInt(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.length === 1) return ZH_DIGITS[s] ?? null;
    if (s.length === 2) {
      if (s[0] === '十') return 10 + (ZH_DIGITS[s[1]] ?? 0);
      if (s[1] === '十') return (ZH_DIGITS[s[0]] ?? 0) * 10;
    }
    if (s.length === 3 && s[1] === '十') return (ZH_DIGITS[s[0]] ?? 0) * 10 + (ZH_DIGITS[s[2]] ?? 0);
    return null;
  }

  function extractOrder(filename) {
    const base = filename.replace(/\.md$/i, '');
    let m = base.match(/第\s*([零〇一二两三四五六七八九十]+)\s*[章讲课节回]/);
    if (m) { const n = zhNumToInt(m[1]); if (n !== null) return n; }
    m = base.match(/ch(?:apter)?[\s._-]*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = base.match(/^(\d+)[\s._-]/);
    if (m) return parseInt(m[1], 10);
    m = base.match(/^(\d+)$/);
    if (m) return parseInt(m[1], 10);
    m = base.match(/[\s._-](\d+)$/);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  function inferChapters(bookFiles, root) {
    const zhMap = new Map(), enMap = new Map();
    for (const f of bookFiles) {
      const rel = relativeTo(f.path, root);
      const zh = rel.match(/^zh\/([^/]+\.md)$/i);
      const en = rel.match(/^en\/([^/]+\.md)$/i);
      if (zh) zhMap.set(zh[1], { ...f, rel });
      else if (en) enMap.set(en[1], { ...f, rel });
    }
    const all = new Set([...zhMap.keys(), ...enMap.keys()]);
    const chapters = [];
    for (const basename of Array.from(all).sort()) {
      const zhF = zhMap.get(basename), enF = enMap.get(basename);
      chapters.push({
        id: basename.replace(/\.md$/i, ''),
        titleZh: zhF ? extractTitleFromMd(zhF.content, basename) : (enF ? extractTitleFromMd(enF.content, basename) : basename),
        titleEn: enF ? extractTitleFromMd(enF.content, basename) : (zhF ? extractTitleFromMd(zhF.content, basename) : basename),
        zh: zhF ? zhF.rel : '',
        en: enF ? enF.rel : '',
      });
    }
    chapters.sort((a, b) => {
      const ao = extractOrder(a.id), bo = extractOrder(b.id);
      if (ao !== null && bo !== null && ao !== bo) return ao - bo;
      if (ao !== null && bo === null) return -1;
      if (ao === null && bo !== null) return 1;
      return a.id.localeCompare(b.id);
    });
    return chapters;
  }

  function parseBookGroup(group) {
    const { root, files } = group;
    const manifestFile = files.find((f) => f.path.endsWith('manifest.json'));
    let manifest = null;
    if (manifestFile) {
      try { manifest = JSON.parse(manifestFile.content); }
      catch (e) { console.warn(t('manifest.parse-failed', { msg: e.message })); }
    }
    let chapters;
    if (manifest && Array.isArray(manifest.chapters) && manifest.chapters.length) {
      chapters = manifest.chapters.map((ch) => ({
        ...ch,
        zh: ch.zh ? relativeTo(ch.zh, root) : '',
        en: ch.en ? relativeTo(ch.en, root) : '',
      }));
    } else {
      chapters = inferChapters(files, root);
    }
    const title = (manifest && manifest.title) || root.split('/').pop() || 'Untitled';
    const bookFiles = files
      .filter((f) => !f.path.endsWith('manifest.json'))
      .map((f) => ({ path: relativeTo(f.path, root), content: f.content }));
    return { root, title, chapters, files: bookFiles };
  }

  /* ================= 统一上传队列（Markdown 书 / PDF） ================= */
  let uploadSeq = 0;
  function newUploadItemId() {
    uploadSeq += 1;
    return 'u-' + Date.now() + '-' + uploadSeq;
  }

  function pdfItemLang(item) {
    return item.langOverride || (item.parsed && item.parsed.lang) || 'zh';
  }

  function pdfItemLangSourceLabel(item) {
    if (item.langOverride) return t('lang.source.user');
    const source = item.parsed && item.parsed.langSource;
    if (source === 'filename') return t('lang.source.filename');
    if (source === 'conflict') return t('lang.source.conflict');
    return t('lang.source.default');
  }

  function isUploadItemImportable(item) {
    if (!item || item.error || item.parsing) return false;
    if (item.kind === 'pdf') return !!(item.parsed && item.parsed.chapters);
    return !!(item.chapters && item.chapters.length);
  }

  function createBookItems(rawFiles, source) {
    const groups = groupFilesByBook(rawFiles);
    const books = groups.map(parseBookGroup).filter((b) => b.chapters.length > 0);
    return books.map((book) => ({
      id: newUploadItemId(),
      kind: 'book',
      source,
      root: book.root,
      title: book.title,
      chapters: book.chapters,
      files: book.files,
      checked: true,
      error: null,
    }));
  }

  function createPdfItem(file, source) {
    const baseName = (file.name || '').split(/[\\/]/).pop() || 'PDF';
    return {
      id: newUploadItemId(),
      kind: 'pdf',
      source,
      file,
      title: baseName.replace(/\.[^.]+$/, ''),
      parsed: null,
      parsing: false,
      error: null,
      checked: true,
      langOverride: null,
    };
  }

  function createChapterPreview(item) {
    const chapters = item.kind === 'book' ? item.chapters : ((item.parsed && item.parsed.chapters) || []);
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'upload-book-toggle';
    toggleBtn.textContent = t('library.chapters');
    toggleBtn.disabled = !chapters.length;
    const chaptersBox = document.createElement('div');
    chaptersBox.className = 'upload-book-chapters';
    chaptersBox.style.display = 'none';
    if (chapters.length) {
      const ol = document.createElement('ol');
      chapters.forEach((ch) => {
        const li = document.createElement('li');
        li.textContent = item.kind === 'book'
          ? `${ch.titleZh || ch.id} / ${ch.titleEn || ch.id}`
          : t('pdf.chapter-label', { title: ch.title, start: ch.startPage, end: ch.endPage });
        ol.appendChild(li);
      });
      chaptersBox.appendChild(ol);
    }
    toggleBtn.addEventListener('click', () => {
      chaptersBox.style.display = chaptersBox.style.display === 'none' ? 'block' : 'none';
    });
    return { toggleBtn, chaptersBox };
  }

  function renderUploadQueue() {
    const wrap = $('#upload-books-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    state.uploadQueue.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'upload-book-card';

      const header = document.createElement('div');
      header.className = 'upload-book-card-header';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = !isUploadItemImportable(item);
      cb.checked = !!item.checked && isUploadItemImportable(item);
      cb.addEventListener('change', () => { item.checked = cb.checked; updateUploadButtons(); });

      const titleIn = document.createElement('input');
      titleIn.type = 'text';
      titleIn.className = 'upload-book-title';
      titleIn.value = item.title || '';
      titleIn.addEventListener('input', () => { item.title = titleIn.value; });

      const meta = document.createElement('span');
      meta.className = 'upload-book-meta';
      if (item.kind === 'book') {
        meta.textContent = t('upload.kind-book', { n: item.chapters.length });
      } else if (item.parsing) {
        meta.textContent = t('upload.kind-pdf') + ' · ' + t('pdf.loading');
      } else if (item.error) {
        meta.textContent = t('upload.kind-pdf') + ' · ' + t('pdf.load-failed');
      } else if (item.parsed) {
        const parsed = item.parsed;
        const tocText = parsed.tocSource === 'outline'
          ? t('pdf.meta-outline', { n: parsed.outlineCount })
          : t('pdf.meta-no-outline');
        const langText = pdfItemLang(item) === 'zh' ? t('lang.zh') : t('lang.en');
        meta.textContent = `${t('upload.kind-pdf')} · ${t('pdf.meta-pages', { n: parsed.pageCount })} · ${tocText} · ${langText}`;
      } else {
        meta.textContent = t('upload.kind-pdf');
      }

      const preview = createChapterPreview(item);
      header.append(cb, titleIn, meta, preview.toggleBtn);
      card.appendChild(header);
      card.appendChild(preview.chaptersBox);

      if (item.kind === 'pdf' && item.parsed && !item.error) {
        const tools = document.createElement('div');
        tools.className = 'upload-book-tools';
        const langLabel = document.createElement('label');
        langLabel.textContent = t('pdf.lang-manual');
        const langSelect = document.createElement('select');
        const autoOpt = document.createElement('option');
        autoOpt.value = '';
        autoOpt.textContent = t('pdf.lang-auto', {
          lang: item.parsed.lang === 'zh' ? t('lang.zh') : t('lang.en'),
        });
        langSelect.appendChild(autoOpt);
        const zhOpt = document.createElement('option');
        zhOpt.value = 'zh';
        zhOpt.textContent = t('pdf.lang-zh');
        langSelect.appendChild(zhOpt);
        const enOpt = document.createElement('option');
        enOpt.value = 'en';
        enOpt.textContent = t('pdf.lang-en');
        langSelect.appendChild(enOpt);
        langSelect.value = item.langOverride || '';
        langSelect.addEventListener('change', () => {
          item.langOverride = langSelect.value || null;
          renderUploadQueue();
        });
        tools.append(langLabel, langSelect);
        card.appendChild(tools);

        const sourceLine = document.createElement('div');
        sourceLine.className = 'upload-book-meta';
        sourceLine.style.marginTop = '6px';
        sourceLine.textContent = pdfItemLangSourceLabel(item);
        card.appendChild(sourceLine);

        if (item.parsed.hasTextLayer === false) {
          const warn = document.createElement('div');
          warn.className = 'upload-book-warn';
          warn.textContent = t('pdf.scanned-hint');
          card.appendChild(warn);
        }
        if (item.parsed.tocSource !== 'outline') {
          const warn = document.createElement('div');
          warn.className = 'upload-book-warn';
          warn.textContent = t('pdf.fallback-hint', { n: PDF_PAGES_PER_CHAPTER });
          card.appendChild(warn);
        }
      }

      if (item.error) {
        const err = document.createElement('div');
        err.className = 'upload-book-error';
        err.textContent = item.kind === 'pdf' ? pdfErrorMessage(item.error) : t('upload.status-no-chapters');
        card.appendChild(err);
      }

      wrap.appendChild(card);
    });
    updateUploadButtons();
  }

  function uploadQueueSelection() {
    const checked = state.uploadQueue.filter((item) => item.checked && isUploadItemImportable(item));
    const books = checked.filter((item) => item.kind === 'book');
    const pdfs = checked.filter((item) => item.kind === 'pdf');
    return { checked, books, pdfs };
  }

  function updateUploadButtons() {
    const { books, pdfs } = uploadQueueSelection();
    const importBtn = $('#upload-import');
    const exportBtn = $('#upload-export-zip');
    const parsing = state.uploadQueue.some((item) => item.parsing);
    if (importBtn) importBtn.disabled = parsing || books.length + pdfs.length === 0;
    const hasBookItems = state.uploadQueue.some((item) => item.kind === 'book');
    if (exportBtn) {
      // 队列里没有任何 Markdown 书时隐藏“导出仓库包”（PDF 不参与导出）
      exportBtn.style.display = hasBookItems ? '' : 'none';
      exportBtn.disabled = books.length === 0;
    }
  }

  async function importQueue() {
    const { checked } = uploadQueueSelection();
    if (!checked.length) { showToast(t('upload.import-empty'), 'error'); return; }
    const status = $('#upload-status');
    const createdBookIds = [];
    const createdFileKeys = [];
    const createdBinaryKeys = [];
    try {
      for (const item of checked) {
        const bookId = 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        if (item.kind === 'book') {
          const record = {
            id: bookId,
            title: item.title || 'Untitled',
            isBuiltin: false,
            kind: 'markdown',
            chapters: item.chapters,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const files = item.files.map((f) => ({
            key: `${bookId}/${f.path}`,
            bookId,
            path: f.path,
            content: f.content,
          }));
          await db.put('books', record);
          if (files.length) await db.bulkPut('bookFiles', files);
          createdBookIds.push(bookId);
          files.forEach((f) => createdFileKeys.push(f.key));
        } else {
          const parsed = item.parsed;
          const lang = item.langOverride || parsed.lang || 'zh';
          const record = {
            id: bookId,
            title: item.title || parsed.title || item.file.name,
            kind: 'pdf',
            isBuiltin: false,
            lang,
            langSource: item.langOverride ? 'user' : (parsed.langSource || 'default'),
            fileName: item.file.name,
            pageCount: parsed.pageCount,
            tocSource: parsed.tocSource,
            outlineCount: parsed.outlineCount || 0,
            hasTextLayer: parsed.hasTextLayer !== false,
            byteSize: item.file.size,
            chapters: parsed.chapters || [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const key = `${bookId}/source.pdf`;
          await db.put('books', record);
          await db.put('bookBinary', {
            key,
            bookId,
            path: 'source.pdf',
            blob: item.file,
            mime: 'application/pdf',
            size: item.file.size,
            updatedAt: Date.now(),
          });
          createdBookIds.push(bookId);
          createdBinaryKeys.push(key);
        }
      }
      await loadLibrary();
      $('#upload-dialog').classList.add('hidden');
      resetUploadDialog();
      if (createdBookIds.length) await switchBook(createdBookIds[0]);
      showToast(t('upload.toast-imported', { n: createdBookIds.length }));
    } catch (e) {
      console.error(e);
      // 回滚本次已写入的部分，避免书库出现半成品
      try {
        if (createdBookIds.length) await db.bulkDelete('books', createdBookIds);
        if (createdFileKeys.length) await db.bulkDelete('bookFiles', createdFileKeys);
        if (createdBinaryKeys.length) await db.bulkDelete('bookBinary', createdBinaryKeys);
      } catch (rollbackError) {
        console.warn('[Upload] 导入失败后的清理异常', rollbackError);
      }
      const isQuota = e && /quota/i.test(e.name || '');
      const message = isQuota ? t('pdf.error.quota') : t('upload.status-import-failed', { msg: (e && e.message) || '' });
      if (status) {
        status.className = 'upload-status error';
        status.textContent = message;
      }
      showToast(message, 'error');
    }
  }

  /* ================= 文件 / 文件夹上传入口（统一路由） ================= */
  function appendBookItems(rawFiles, source) {
    const books = createBookItems(rawFiles, source);
    if (!books.length) return 0;
    state.uploadQueue.push(...books);
    renderUploadQueue();
    return books.length;
  }

  async function addPdfItemsAndParse(files, source, status) {
    const items = files.map((file) => createPdfItem(file, source));
    if (!items.length) return 0;
    state.uploadQueue.push(...items);
    renderUploadQueue();
    await parsePdfItems(items, status);
    return items.filter((item) => item.parsed && !item.error).length;
  }

  async function parsePdfItems(items, status) {
    if (!window.ReaderPdfImport) {
      if (status) {
        status.className = 'upload-status error';
        status.textContent = t('pdf.error.pdfjs-load-failed');
      }
      return;
    }
    const valid = [];
    for (const item of items) {
      try {
        const validation = await window.ReaderPdfImport.validateFile(item.file);
        if (!validation.ok) { item.error = validation.code; item.checked = false; }
      } catch (e) {
        console.warn('[PDF] 校验失败', e);
        item.error = 'unreadable';
        item.checked = false;
      }
      if (!item.error) valid.push(item);
    }
    renderUploadQueue();
    if (!valid.length) {
      const failed = items.find((item) => item.error);
      if (status) {
        status.className = 'upload-status error';
        status.textContent = failed ? pdfErrorMessage(failed.error) : t('upload.status-no-files');
      }
      return;
    }
    for (let i = 0; i < valid.length; i += 1) {
      const item = valid[i];
      item.parsing = true;
      if (status) {
        status.className = 'upload-status';
        status.textContent = t('upload.status-processing', { i: i + 1, n: valid.length });
      }
      renderUploadQueue();
      try {
        item.parsed = await window.ReaderPdfImport.parseFile(item.file, { lang: null, title: item.title });
        if (item.parsed && item.parsed.title) item.title = item.parsed.title;
      } catch (e) {
        console.warn('[PDF] 解析失败', e);
        item.error = (e && e.code) || 'unknown';
        item.checked = false;
        item.parsed = null;
      } finally {
        item.parsing = false;
        renderUploadQueue();
      }
    }
    const okCount = items.filter((item) => item.parsed && !item.error).length;
    if (status) {
      if (okCount) {
        status.className = 'upload-status success';
        status.textContent = t('upload.status-detected', { n: okCount });
      } else {
        const failed = items.find((item) => item.error);
        status.className = 'upload-status error';
        status.textContent = failed ? pdfErrorMessage(failed.error) : t('upload.status-no-files');
      }
    }
    updateUploadButtons();
  }

  async function handleSelectedFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const status = $('#upload-status');
    const zipFiles = files.filter((file) => /\.zip$/i.test(file.name || ''));
    const pdfFiles = files.filter((file) => /\.pdf$/i.test(file.name || ''));
    const ignored = files.filter((file) => !zipFiles.includes(file) && !pdfFiles.includes(file));
    try {
      if (zipFiles.length) {
        status.className = 'upload-status';
        status.textContent = t('upload.status-extracting');
        for (const zipFile of zipFiles) {
          try {
            const raw = await readZipFiles([zipFile]);
            appendBookItems(raw, 'zip');
          } catch (err) {
            console.warn('[Upload] zip 解析失败', err);
            showToast(t('upload.status-extract-failed', { msg: (err && err.message) || '' }), 'error');
          }
        }
      }
      if (pdfFiles.length) {
        status.className = 'upload-status';
        status.textContent = t('upload.status-processing', { i: 1, n: pdfFiles.length });
        await addPdfItemsAndParse(pdfFiles, 'file', status);
      }
      renderUploadQueue();
      const importable = state.uploadQueue.filter((item) => item.checked && isUploadItemImportable(item)).length;
      if (importable) {
        status.className = 'upload-status success';
        status.textContent = t('upload.status-detected', { n: importable });
      } else if (ignored.length) {
        status.className = 'upload-status error';
        status.textContent = t('upload.status-ignored', { n: ignored.length });
      }
      updateUploadButtons();
    } catch (e) {
      console.error(e);
      status.className = 'upload-status error';
      status.textContent = t('upload.status-read-failed', { msg: (e && e.message) || '' });
    }
  }

  async function handleFolderUpload(fileList) {
    const status = $('#upload-status');
    status.className = 'upload-status';
    status.textContent = t('upload.status-reading');
    try {
      const { mdFiles, pdfFiles } = await readFolderEntries(fileList);
      const added = mdFiles.length ? appendBookItems(mdFiles, 'folder') : 0;
      let pdfAdded = 0;
      if (pdfFiles.length) pdfAdded = await addPdfItemsAndParse(pdfFiles, 'folder', status);
      renderUploadQueue();
      const importable = state.uploadQueue.filter((item) => item.checked && isUploadItemImportable(item)).length;
      if (importable) {
        status.className = 'upload-status success';
        status.textContent = t('upload.status-detected', { n: importable });
      } else if (!added && !pdfAdded) {
        status.className = 'upload-status error';
        status.textContent = t('upload.status-no-books');
      }
      updateUploadButtons();
    } catch (e) {
      console.error(e);
      status.className = 'upload-status error';
      status.textContent = t('upload.status-read-failed', { msg: (e && e.message) || '' });
    }
  }

  async function packageAsRepoZip(entries) {
    if (!entries.length) { showToast(t('toast.no-selection'), 'error'); return; }
    try {
      const zip = new JSZip();
      const librarySnippet = { books: [] };
      const usedSlugs = new Set();

      for (const book of entries) {
        let slug = slugify(book.title);
        let n = 1;
        while (usedSlugs.has(slug)) slug = slugify(book.title) + '-' + n++;
        usedSlugs.add(slug);

        const folder = zip.folder(slug);
        const manifest = {
          title: book.title,
          chapters: (book.chapters || []).map((ch) => ({
            id: ch.id,
            titleZh: ch.titleZh || ch.id,
            titleEn: ch.titleEn || ch.id,
            zh: (ch.zh || '').replace(/^\//, ''),
            en: (ch.en || '').replace(/^\//, ''),
          })),
        };
        folder.file('manifest.json', JSON.stringify(manifest, null, 2));
        for (const f of book.files) folder.file(f.path, f.content);
        librarySnippet.books.push({ id: slug, path: `content/books/${slug}` });
      }

      zip.file('library-snippet.json', JSON.stringify(librarySnippet, null, 2));
      zip.file('README.txt',
        'Setup:\n' +
        '1. Extract the book folders from this zip (excluding library-snippet.json and README.txt) into content/books/\n' +
        '2. Open content/library.json and merge the books entries from library-snippet.json\n' +
        '3. git add . && git commit -m "add: new books" && git push\n' +
        'After deploy, these books become built-in and persist with the repo.\n'
      );

      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `books-${new Date().toISOString().slice(0, 10)}.zip`);
      showToast(t('toast.export-zip-done', { n: entries.length }));
    } catch (e) {
      console.error(e);
      showToast(t('toast.export-failed', { msg: e.message }), 'error');
    }
  }

  async function exportQueueAsRepoZip() {
    const { books, pdfs } = uploadQueueSelection();
    if (!books.length) { showToast(t('upload.import-empty'), 'error'); return; }
    if (pdfs.length) showToast(t('upload.export-pdf-hint'), 'error');
    await packageAsRepoZip(books.map((b) => ({ title: b.title, chapters: b.chapters, files: b.files })));
  }

  function resetUploadDialog() {
    state.uploadQueue = [];
    const status = $('#upload-status');
    if (status) { status.textContent = ''; status.className = 'upload-status'; }
    const list = $('#upload-books-list');
    if (list) list.innerHTML = '';
    const importBtn = $('#upload-import');
    if (importBtn) importBtn.disabled = true;
    const exportBtn = $('#upload-export-zip');
    if (exportBtn) { exportBtn.disabled = true; exportBtn.style.display = 'none'; }
    updateUploadButtons();
  }

  async function readZipFiles(fileList) {
    const out = [];
    for (const file of fileList) {
      if (!window.JSZip) throw new Error('JSZip not loaded');
      const zip = await JSZip.loadAsync(file);
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (isIgnoredPath(path)) continue;
        if (!path.endsWith('.md') && !path.endsWith('manifest.json')) continue;
        out.push({ path, content: await entry.async('text') });
      }
    }
    return out;
  }

  // 文件夹上传：同时收集 Markdown 书文件与 PDF（PDF 可位于任意子目录）
  async function readFolderEntries(fileList) {
    const mdFiles = [];
    const pdfFiles = [];
    for (const f of fileList) {
      const path = f.webkitRelativePath || f.name;
      if (isIgnoredPath(path)) continue;
      const lower = path.toLowerCase();
      if (lower.endsWith('.pdf')) { pdfFiles.push(f); continue; }
      if (!lower.endsWith('.md') && !lower.endsWith('manifest.json')) continue;
      mdFiles.push({ path, content: await f.text() });
    }
    return { mdFiles, pdfFiles };
  }

  /* ================= 备份 / 恢复 ================= */
  function updateBackupReminder() {
    const last = parseInt(localStorage.getItem(STORAGE.lastBackup) || '0', 10);
    const days = last ? Math.floor((Date.now() - last) / (24 * 60 * 60 * 1000)) : 999;
    const badge = $('#backup-badge');
    const hint = $('#backup-hint');
    if (days >= 7) {
      if (badge) {
        badge.style.display = 'block';
        badge.title = last ? t('notes.badge-title', { n: days }) : t('notes.badge-never');
      }
      if (hint) {
        hint.style.display = 'block';
        hint.textContent = last ? t('notes.hint-last-backup', { n: days }) : t('notes.hint-never');
      }
    } else {
      if (badge) badge.style.display = 'none';
      if (hint) hint.style.display = 'none';
    }
  }

  function backgroundExtension(mime, name) {
    const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    if (map[mime]) return map[mime];
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? '.' + m[1].toLowerCase() : '.img';
  }

  async function backupAll() {
    try {
      const zip = new JSZip();
      const notes = await db.getAll('notes');
      const allBooks = await db.getAll('books');
      const uploaded = allBooks.filter((b) => !b.isBuiltin);
      const files = await db.getAll('bookFiles');
      const binary = await db.getAll('bookBinary');
      const background = await db.get('assets', BACKGROUND_ASSET_KEY);

      zip.file('notes.json', JSON.stringify(notes, null, 2));
      zip.file('books.json', JSON.stringify(uploaded, null, 2));
      for (const f of files) zip.file(`bookFiles/${f.key}`, f.content);
      for (const f of binary) { if (f && f.blob) zip.file(`pdfs/${f.key}`, f.blob); }
      if (background && background.blob) {
        zip.file('assets/reading-background' + backgroundExtension(background.mime, background.name), background.blob);
      }
      zip.file('metadata.json', JSON.stringify({
        version: 'v' + APP_VERSION,
        backupAt: Date.now(),
        date: new Date().toISOString(),
        noteCount: notes.length,
        bookCount: uploaded.length,
        fileCount: files.length,
        pdfCount: binary.length,
        hasBackground: !!(background && background.blob),
      }, null, 2));

      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `backup-${new Date().toISOString().slice(0, 10)}.zip`);
      localStorage.setItem(STORAGE.lastBackup, Date.now().toString());
      updateBackupReminder();
      showToast(t('backup.toast-done', { notes: notes.length, books: uploaded.length }));
    } catch (e) {
      console.error(e);
      showToast(t('backup.toast-failed', { msg: e.message }), 'error');
    }
  }

  async function restoreAll(file) {
    try {
      const zip = await JSZip.loadAsync(file);
      const metadataFile = zip.file('metadata.json');
      const notesFile = zip.file('notes.json');
      const booksFile = zip.file('books.json');
      if (!metadataFile || !notesFile || !booksFile) {
        throw new Error(t('backup.missing-entries'));
      }
      const metadata = JSON.parse(await metadataFile.async('text'));
      const notes = JSON.parse(await notesFile.async('text')).map((n) =>
        cleanNoteForDB({ ...n, bookId: normalizeBookId(n.bookId) }));
      const books = JSON.parse(await booksFile.async('text')).map((b) => ({ ...b, kind: b.kind || 'markdown' }));

      const doOverwrite = !confirm(t('backup.confirm-restore', {
        date: formatDate(metadata.backupAt),
        notes: metadata.noteCount,
        books: metadata.bookCount,
      }));

      if (doOverwrite) {
        const allNotes = await db.getAll('notes');
        await db.bulkDelete('notes', allNotes.map((n) => n.id));
        const allBooks = await db.getAll('books');
        const uploaded = allBooks.filter((b) => !b.isBuiltin);
        await db.bulkDelete('books', uploaded.map((b) => b.id));
        await db.clear('bookFiles');
        await db.clear('bookBinary');
        await db.clear('assets');
      }

      const existingBooks = new Set((await db.getAll('books')).map((b) => b.id));
      const newBooks = books.filter((b) => !existingBooks.has(b.id));
      if (newBooks.length) await db.bulkPut('books', newBooks);

      const fileEntries = Object.entries(zip.files).filter(([p, e]) => !e.dir && p.startsWith('bookFiles/'));
      const newFiles = [];
      for (const [path, entry] of fileEntries) {
        const key = path.replace(/^bookFiles\//, '');
        const bookId = key.split('/')[0];
        const pathInBook = key.slice(bookId.length + 1);
        newFiles.push({ key, bookId, path: pathInBook, content: await entry.async('text') });
      }
      if (newFiles.length) await db.bulkPut('bookFiles', newFiles);

      // v0.0.6：PDF 二进制与阅读背景（旧备份没有这些条目时自动跳过）
      const pdfEntries = Object.entries(zip.files).filter(([p, e]) => !e.dir && p.startsWith('pdfs/'));
      for (const [path, entry] of pdfEntries) {
        const key = path.replace(/^pdfs\//, '');
        const bookId = key.split('/')[0];
        const blob = await entry.async('blob');
        await db.put('bookBinary', {
          key,
          bookId,
          path: key.slice(bookId.length + 1) || 'source.pdf',
          blob,
          mime: 'application/pdf',
          size: blob.size,
          updatedAt: Date.now(),
        });
      }
      const bgPath = Object.keys(zip.files).find((p) => !zip.files[p].dir && /^assets\/reading-background/.test(p));
      if (bgPath) {
        const bgEntry = zip.files[bgPath];
        const blob = await bgEntry.async('blob');
        const ext = (/\.[a-z0-9]+$/i.exec(bgPath) || ['.jpg'])[0].toLowerCase();
        const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
        await db.put('assets', {
          key: BACKGROUND_ASSET_KEY,
          blob,
          mime,
          name: 'reading-background' + ext,
          size: blob.size,
          updatedAt: Date.now(),
        });
      }

      const existingNotes = new Set((await db.getAll('notes')).map((n) => n.id));
      const newNotes = notes.filter((n) => !existingNotes.has(n.id));
      if (newNotes.length) await db.bulkPut('notes', newNotes);

      await loadLibrary();
      await loadNotes();
      await loadBackground();
      if (state.currentBookId) await switchBook(state.currentBookId);
      refreshNotesUI(); applyHighlights();
      localStorage.setItem(STORAGE.lastBackup, Date.now().toString());
      updateBackupReminder();
      showToast(t('backup.restore-toast-done', { notes: newNotes.length, books: newBooks.length }));
    } catch (e) {
      console.error(e);
      showToast(t('backup.restore-toast-failed', { msg: e.message }), 'error');
    }
  }

  /* ================= PDF 阅读器 ================= */
  let pdfReader = null;
  let pdfViewerBook = null;
  const PDF_HIGHLIGHT_NAME = 'reader-pdf-note';
  const pdfHighlightRanges = new Map(); // noteId -> { page, range }

  const PDF_ERROR_CODES = [
    'empty', 'too-large', 'not-pdf-extension', 'not-pdf-mime', 'not-pdf-magic',
    'encrypted', 'invalid', 'timeout', 'pdfjs-load-failed', 'network', 'unreadable',
  ];

  function pdfErrorMessage(errOrCode) {
    const code = typeof errOrCode === 'string' ? errOrCode : ((errOrCode && errOrCode.code) || 'unknown');
    const safeCode = PDF_ERROR_CODES.includes(code) ? code : 'unknown';
    const detail = (errOrCode && typeof errOrCode === 'object')
      ? (errOrCode.detail || errOrCode.message || '')
      : '';
    if (safeCode === 'unknown' && detail) return t('pdf.error.unknown', { msg: detail });
    return t('pdf.error.' + safeCode);
  }

  function clearAllPdfHighlights() {
    pdfHighlightRanges.clear();
    if (hasHighlightAPI()) CSS.highlights.delete(PDF_HIGHLIGHT_NAME);
    $$('.pdf-text-layer mark[data-note-id]').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function rebuildPdfHighlights() {
    if (!hasHighlightAPI()) return;
    const hl = new Highlight();
    pdfHighlightRanges.forEach((item) => { if (item && item.range) hl.add(item.range); });
    if (hl.size > 0) CSS.highlights.set(PDF_HIGHLIGHT_NAME, hl);
    else CSS.highlights.delete(PDF_HIGHLIGHT_NAME);
  }

  function applyPdfPageHighlights(book, page, textLayerEl) {
    if (!book || !textLayerEl) return;
    for (const [id, item] of Array.from(pdfHighlightRanges.entries())) {
      if (item.page === page) { pdfHighlightRanges.delete(id); noteRanges.delete(id); }
    }
    const useAPI = hasHighlightAPI();
    const notes = state.notes.filter((n) =>
      n.bookId === book.id && n.kind === 'pdf' && Number(n.page) === Number(page) && n.selector);
    for (const note of notes) {
      let range = null;
      try { range = findTextPosition(textLayerEl, note.selector); } catch (e) { range = null; }
      if (!range) continue;
      pdfHighlightRanges.set(note.id, { page, range });
      noteRanges.set(note.id, range);
      if (!useAPI) {
        try { const mark = document.createElement('mark'); mark.dataset.noteId = note.id; range.surroundContents(mark); } catch (e) {}
      }
    }
    rebuildPdfHighlights();
  }

  function applyAllPdfHighlights() {
    if (!pdfViewerBook) return;
    clearAllPdfHighlights();
    $$('#pane-zh .pdf-page[data-rendered="1"]').forEach((pageEl) => {
      const page = parseInt(pageEl.dataset.page, 10);
      const textLayer = pageEl.querySelector('.pdf-text-layer');
      if (textLayer && Number.isFinite(page)) applyPdfPageHighlights(pdfViewerBook, page, textLayer);
    });
  }

  function releasePdfPageHighlights(pages) {
    let changed = false;
    for (const page of (pages || [])) {
      for (const [id, item] of Array.from(pdfHighlightRanges.entries())) {
        if (item.page === page) { pdfHighlightRanges.delete(id); noteRanges.delete(id); changed = true; }
      }
    }
    if (changed) rebuildPdfHighlights();
  }

  async function jumpToPdfNote(note) {
    if (!pdfReader) return;
    try { await pdfReader.goToPage(Number(note.page) || 1); } catch (e) { return; }
    applyAllPdfHighlights();
    const item = pdfHighlightRanges.get(note.id);
    if (!item || !item.range) return;
    const el = item.range.startContainer.parentElement;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const old = el.style.background;
    el.style.transition = 'background 0.3s';
    el.style.background = 'var(--highlight)';
    setTimeout(() => { el.style.background = old; }, 1500);
  }

  function readPdfProgress(bookId) {
    try {
      return JSON.parse(localStorage.getItem(STORAGE.pdfProgressPrefix + bookId) || 'null') || null;
    } catch (e) { return null; }
  }

  function savePdfProgress(bookId, page) {
    try {
      localStorage.setItem(STORAGE.pdfProgressPrefix + bookId, JSON.stringify({ page, updatedAt: Date.now() }));
    } catch (e) {}
  }

  function chapterAtPage(book, page) {
    if (!book || !Array.isArray(book.chapters)) return null;
    return book.chapters.find((c) => page >= c.startPage && page <= c.endPage) || null;
  }

  function buildPdfToc(book) {
    const toc = $('#toc-list');
    toc.innerHTML = '';
    if (!book.chapters || !book.chapters.length) {
      toc.innerHTML = `<li style="padding:12px 16px;color:var(--text-secondary);font-size:13px">${t('pdf.toc-empty')}</li>`;
      return;
    }
    book.chapters.forEach((ch) => {
      const li = document.createElement('li');
      li.className = 'pdf-toc-item';
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.chapterId = ch.id;
      a.style.paddingLeft = (16 + (Math.min(ch.level || 1, 6) - 1) * 14) + 'px';
      a.textContent = ch.title || '';
      const pages = document.createElement('span');
      pages.className = 'pdf-toc-pages';
      pages.textContent = 'p.' + ch.startPage + (ch.endPage > ch.startPage ? '–' + ch.endPage : '');
      a.appendChild(pages);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (pdfReader) pdfReader.goToPage(ch.startPage);
      });
      li.appendChild(a);
      toc.appendChild(li);
    });
  }

  function updatePdfTocActive(book, page) {
    const current = chapterAtPage(book, page);
    $$('#toc-list li.pdf-toc-item a').forEach((a) => {
      a.classList.toggle('active', !!current && a.dataset.chapterId === current.id);
    });
  }

  function onPdfPageChange(book, page, chapter) {
    const pageInput = $('#pdf-page-input');
    if (pageInput && document.activeElement !== pageInput) pageInput.value = String(page);
    if (chapter && chapter.id) {
      state.currentChapterId = chapter.id;
      const chapterSelect = $('#chapter-select');
      if (chapterSelect && chapterSelect.value !== chapter.id) chapterSelect.value = chapter.id;
    }
    updatePdfTocActive(book, page);
    updateReadingProgress();
  }

  function closePdfReaderOnly() {
    if (pdfReader) {
      try { pdfReader.destroy(); } catch (e) { console.warn('[PDF] 销毁阅读器失败', e); }
      pdfReader = null;
    }
    pdfViewerBook = null;
    clearAllPdfHighlights();
    const pane = $('#pane-zh');
    if (pane) pane.classList.remove('pdf-pane');
  }

  async function closeActiveReader() {
    closePdfReaderOnly();
    document.body.classList.remove('mode-pdf');
    $('#pdf-controls').classList.add('hidden');
    const badge = $('#pdf-mode-badge');
    if (badge) badge.classList.add('hidden');
    ensureMarkdownPanes();
  }

  function renderPdfError(book, message) {
    closePdfReaderOnly();
    const container = $('#pane-zh');
    document.body.classList.add('mode-pdf');
    container.classList.add('pdf-pane');
    container.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'pdf-error-panel';
    const titleEl = document.createElement('h2');
    titleEl.textContent = t('pdf.load-failed');
    const descEl = document.createElement('p');
    descEl.textContent = message || '';
    const retryBtn = document.createElement('button');
    retryBtn.textContent = t('pdf.retry');
    retryBtn.addEventListener('click', () => { if (book) switchBook(book.id); });
    panel.append(titleEl, descEl, retryBtn);
    container.appendChild(panel);
    $('#pdf-controls').classList.add('hidden');
    const badge = $('#pdf-mode-badge');
    if (badge) badge.classList.add('hidden');
    refreshNotesUI();
    updateReadingProgress();
  }

  function updatePdfZoomUi() {
    const zoom = state.settings.pdfZoom;
    const fit = zoom === 'fit-width' || zoom === 'fit' || zoom == null;
    const btn = $('#pdf-fit');
    if (btn) btn.classList.toggle('active', fit);
  }

  async function applyPdfZoom(action) {
    if (!pdfReader) return;
    try { await pdfReader.setZoom(action); } catch (e) { console.warn('[PDF] 缩放失败', e); return; }
    if (action === 'fit-width') state.settings.pdfZoom = 'fit-width';
    else if (typeof action === 'number') state.settings.pdfZoom = action;
    else state.settings.pdfZoom = pdfReader.getScale();
    saveSettings();
    updatePdfZoomUi();
  }

  async function openPdfBook(book) {
    await closeActiveReader();
    document.body.classList.add('mode-pdf');
    $('#pdf-controls').classList.remove('hidden');
    const modeBadge = $('#pdf-mode-badge');
    if (modeBadge) modeBadge.classList.remove('hidden');
    state.currentChapterId = null;
    const container = $('#pane-zh');
    container.innerHTML = '';
    container.classList.add('pdf-pane');
    $('#toc-list').innerHTML = '';
    updateReadingProgress();
    refreshNotesUI();

    let record = null;
    try { record = await db.get('bookBinary', `${book.id}/source.pdf`); } catch (e) { record = null; }
    if (!record || !record.blob) { renderPdfError(book, t('pdf.missing')); return; }

    let bytes;
    try { bytes = new Uint8Array(await record.blob.arrayBuffer()); } catch (e) { renderPdfError(book, t('pdf.error.unreadable')); return; }
    if (!window.ReaderPdfReader) { renderPdfError(book, t('pdf.error.pdfjs-load-failed')); return; }

    const progress = readPdfProgress(book.id);
    const initialPage = (progress && progress.page)
      ? progress.page
      : ((book.chapters[0] && book.chapters[0].startPage) || 1);

    pdfViewerBook = book;
    container.innerHTML = '';
    container.classList.add('pdf-pane');
    try {
      pdfReader = window.ReaderPdfReader.create(container, {
        bytes,
        pageCount: book.pageCount,
        chapters: book.chapters || [],
        lang: book.lang || 'zh',
        initialPage,
        zoom: state.settings.pdfZoom || 'fit-width',
        onPageChange: (page, chapter) => onPdfPageChange(book, page, chapter),
        onProgress: (info) => {
          if (info && info.page) savePdfProgress(book.id, info.page);
          updateReadingProgress();
        },
        onPageRendered: (page, textLayerEl) => applyPdfPageHighlights(book, page, textLayerEl),
        onPagesReleased: (pages) => releasePdfPageHighlights(pages),
        onReady: (info) => {
          const total = (info && info.pageCount) || book.pageCount || 0;
          $('#pdf-page-total').textContent = '/ ' + total;
          const input = $('#pdf-page-input');
          if (input) {
            input.max = String(total);
            input.value = String(pdfReader ? pdfReader.getCurrentPage() : 1);
          }
          updatePdfZoomUi();
          buildPdfToc(book);
          updateReadingProgress();
          if (book.tocSource !== 'outline') {
            showToast(t('pdf.fallback-hint', { n: PDF_PAGES_PER_CHAPTER }));
          }
          if (book.hasTextLayer === false) {
            setTimeout(() => showToast(t('pdf.scanned-hint'), 'error'), 2600);
          }
        },
        onError: (err) => {
          console.warn('[PDF] 渲染错误', err);
          showToast(pdfErrorMessage(err), 'error');
        },
      });
      await pdfReader.open();
    } catch (e) {
      console.error(e);
      renderPdfError(book, pdfErrorMessage(e));
    }
  }

  function bindPdfControls() {
    const prev = $('#pdf-prev');
    if (!prev) return;
    prev.addEventListener('click', () => { if (pdfReader) pdfReader.goToPage(pdfReader.getCurrentPage() - 1); });
    $('#pdf-next').addEventListener('click', () => { if (pdfReader) pdfReader.goToPage(pdfReader.getCurrentPage() + 1); });
    const input = $('#pdf-page-input');
    const jump = () => {
      if (!pdfReader) return;
      const total = pdfReader.getPageCount();
      let page = parseInt(input.value, 10);
      if (!Number.isFinite(page)) page = pdfReader.getCurrentPage();
      page = Math.min(total, Math.max(1, page));
      input.value = String(page);
      pdfReader.goToPage(page);
    };
    input.addEventListener('change', jump);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); jump(); input.blur(); }
    });
    $('#pdf-zoom-in').addEventListener('click', () => applyPdfZoom('in'));
    $('#pdf-zoom-out').addEventListener('click', () => applyPdfZoom('out'));
    $('#pdf-fit').addEventListener('click', () => applyPdfZoom('fit-width'));
    const badge = $('#pdf-mode-badge');
    if (badge) badge.addEventListener('click', () => showToast(t('pdf.single-col-hint')));
  }
  bindPdfControls();

  /* ================= 阅读背景 / 外观设置 ================= */
  let backgroundUrl = null;
  let backgroundMeta = null;

  function bgErrorMessage(code) {
    const map = {
      empty: 'empty',
      'too-large': 'too-large',
      'bad-extension': 'bad-extension',
      'bad-mime': 'bad-mime',
      'decode-failed': 'decode-failed',
      invalid: 'decode-failed',
      'encode-failed': 'unsupported',
      unsupported: 'unsupported',
    };
    return t('appearance.error.' + (map[code] || 'decode-failed'));
  }

  function applyBackgroundLayer() {
    if (!window.ReaderBackground) return;
    const overlay = window.ReaderBackground.normalizeOverlay(state.settings.bgOverlay);
    if (backgroundUrl) {
      window.ReaderBackground.apply({ url: backgroundUrl, overlay, theme: state.settings.theme });
    } else {
      window.ReaderBackground.clear();
    }
  }

  async function loadBackground() {
    try {
      const asset = await db.get('assets', BACKGROUND_ASSET_KEY);
      if (backgroundUrl) {
        try { URL.revokeObjectURL(backgroundUrl); } catch (e) {}
        backgroundUrl = null;
      }
      backgroundMeta = null;
      if (asset && asset.blob) {
        backgroundMeta = asset;
        backgroundUrl = URL.createObjectURL(asset.blob);
      }
      applyBackgroundLayer();
      renderAppearanceDialog();
    } catch (e) {
      console.warn('[Background] 读取背景失败', e);
    }
  }

  function renderAppearanceDialog() {
    const preview = $('#bg-preview');
    if (!preview) return;
    const clearBtn = $('#bg-clear');
    if (backgroundUrl) {
      preview.style.backgroundImage = `url("${backgroundUrl}")`;
      preview.classList.add('has-image');
      preview.textContent = '';
      if (clearBtn) clearBtn.disabled = false;
    } else {
      preview.style.backgroundImage = '';
      preview.classList.remove('has-image');
      preview.textContent = t('appearance.none');
      if (clearBtn) clearBtn.disabled = true;
    }
    const overlay = window.ReaderBackground
      ? window.ReaderBackground.normalizeOverlay(state.settings.bgOverlay)
      : 0.72;
    const overlayInput = $('#bg-overlay');
    const overlayValue = $('#bg-overlay-value');
    if (overlayInput && document.activeElement !== overlayInput) overlayInput.value = String(Math.round(overlay * 100));
    if (overlayValue) overlayValue.textContent = Math.round(overlay * 100) + '%';
  }

  function openAppearanceDialog() {
    renderAppearanceDialog();
    $('#appearance-dialog').classList.remove('hidden');
  }
  function closeAppearanceDialog() { $('#appearance-dialog').classList.add('hidden'); }

  async function handleBackgroundFile(file) {
    if (!file) return;
    if (!window.ReaderBackground) { showToast(t('appearance.error.unsupported'), 'error'); return; }
    const validation = window.ReaderBackground.validateFile(file);
    if (!validation.ok) { showToast(bgErrorMessage(validation.code), 'error'); return; }
    showToast(t('appearance.processing'));
    let prepared;
    try {
      prepared = await window.ReaderBackground.prepareImage(file);
    } catch (e) {
      console.warn('[Background] 图片处理失败', e);
      showToast(bgErrorMessage(e && e.code), 'error');
      return;
    }
    try {
      const asset = {
        key: BACKGROUND_ASSET_KEY,
        blob: prepared.blob,
        mime: prepared.mime,
        name: file.name,
        size: prepared.size,
        width: prepared.width,
        height: prepared.height,
        updatedAt: Date.now(),
      };
      await db.put('assets', asset);
      if (backgroundUrl) { try { URL.revokeObjectURL(backgroundUrl); } catch (e) {} }
      backgroundMeta = asset;
      backgroundUrl = URL.createObjectURL(prepared.blob);
      applyBackgroundLayer();
      renderAppearanceDialog();
      showToast(t('appearance.saved'));
    } catch (e) {
      console.error(e);
      const isQuota = e && /quota/i.test(e.name || '');
      showToast(isQuota ? t('pdf.error.quota') : t('appearance.save-failed', { msg: (e && e.message) || '' }), 'error');
    }
  }

  async function clearBackground() {
    try {
      await db.delete('assets', BACKGROUND_ASSET_KEY);
    } catch (e) {
      console.error(e);
      showToast(t('appearance.save-failed', { msg: e.message }), 'error');
      return;
    }
    if (backgroundUrl) { try { URL.revokeObjectURL(backgroundUrl); } catch (e) {} }
    backgroundUrl = null;
    backgroundMeta = null;
    applyBackgroundLayer();
    renderAppearanceDialog();
    showToast(t('appearance.cleared'));
  }

  function bindAppearanceControls() {
    const toggle = $('#appearance-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', openAppearanceDialog);
    $('#appearance-close').addEventListener('click', closeAppearanceDialog);
    $('#appearance-dialog').addEventListener('click', (e) => {
      if (e.target && e.target.id === 'appearance-dialog') closeAppearanceDialog();
    });
    $('#bg-clear').addEventListener('click', clearBackground);
    $('#bg-file-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) await handleBackgroundFile(file);
    });
    $('#bg-overlay').addEventListener('input', (e) => {
      const value = Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0));
      state.settings.bgOverlay = value / 100;
      const label = $('#bg-overlay-value');
      if (label) label.textContent = value + '%';
      applyBackgroundLayer();
      saveSettings();
    });
  }
  bindAppearanceControls();

  function updateVersionLabel() {
    const el = $('#app-version');
    if (el) el.textContent = t('library.version', { version: APP_VERSION });
  }

  /* ================= 事件绑定 ================= */
  $('#language-select').addEventListener('change', (e) => {
    state.settings.language = e.target.value;
    window.currentLang = e.target.value;
    saveSettings();
    window.applyTranslations();
    renderBookSelect();
    if (state.currentBookId) {
      const book = state.books.find((b) => b.id === state.currentBookId);
      if (book) {
        const current = $('#chapter-select').value;
        renderChapterSelect(book);
        if (current) $('#chapter-select').value = current;
      }
    }
    if (!$('#library-dialog').classList.contains('hidden')) renderLibraryList();
    if (!$('#upload-dialog').classList.contains('hidden')) renderUploadQueue();
    updateVersionLabel();
    refreshNotesUI();
    updateBackupReminder();
  });

  $('#open-library').addEventListener('click', openLibraryManager);
  $('#library-close').addEventListener('click', () => $('#library-dialog').classList.add('hidden'));
  $('#library-export').addEventListener('click', exportFromLibrary);
  $('#library-delete').addEventListener('click', deleteFromLibrary);

  $('#upload-book').addEventListener('click', () => {
    resetUploadDialog();
    $('#upload-dialog').classList.remove('hidden');
  });
  $('#upload-cancel').addEventListener('click', () => {
    $('#upload-dialog').classList.add('hidden');
    resetUploadDialog();
  });

  $('#upload-file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      await handleSelectedFiles(files);
    } catch (err) {
      console.error(err);
      const status = $('#upload-status');
      if (status) {
        status.className = 'upload-status error';
        status.textContent = t('upload.status-read-failed', { msg: (err && err.message) || '' });
      }
    }
  });

  $('#upload-folder-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      await handleFolderUpload(files);
    } catch (err) {
      console.error(err);
      const status = $('#upload-status');
      if (status) {
        status.className = 'upload-status error';
        status.textContent = t('upload.status-read-failed', { msg: (err && err.message) || '' });
      }
    }
  });

  $('#upload-import').addEventListener('click', importQueue);
  $('#upload-export-zip').addEventListener('click', exportQueueAsRepoZip);

  $('#book-select').addEventListener('change', (e) => switchBook(e.target.value));
  $('#chapter-select').addEventListener('change', (e) => {
    if (pdfReader) {
      const book = state.books.find((b) => b.id === state.currentBookId);
      const chapter = book && (book.chapters || []).find((c) => c.id === e.target.value);
      if (chapter) {
        state.currentChapterId = chapter.id;
        pdfReader.goToPage(chapter.startPage);
      }
      return;
    }
    loadChapter(e.target.value);
  });

  $('#toggle-notes').addEventListener('click', () => {
    $('#notes-panel').classList.toggle('hidden');
    refreshNotesUI();
    updateBackupReminder();
  });
  $('#close-notes').addEventListener('click', () => $('#notes-panel').classList.add('hidden'));

  $('#backup-all').addEventListener('click', backupAll);
  $('#restore-all-btn').addEventListener('click', () => $('#restore-all-input').click());
  $('#restore-all-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await restoreAll(file);
  });

  $('#export-notes').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.notes, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'notes-' + new Date().toISOString().slice(0, 10) + '.json');
    showToast(t('toast.exported', { n: state.notes.length }));
  });
  $('#import-notes-btn').addEventListener('click', () => $('#import-notes-input').click());
  $('#import-notes-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error(t('format.invalid'));
      const ids = new Set(state.notes.map((n) => n.id));
      const toAdd = data.filter((n) => !ids.has(n.id)).map((n) => cleanNoteForDB({
        ...n, bookId: normalizeBookId(n.bookId), tags: n.tags || [],
        selector: n.selector || { exact: n.quote || '', prefix: '', suffix: '', position: 0 },
      }));
      if (toAdd.length) {
        await db.bulkPut('notes', toAdd);
        await loadNotes();
        refreshNotesUI(); applyHighlights();
      }
      showToast(t('toast.import-done', { n: toAdd.length }));
    } catch (err) { showToast(t('toast.import-failed', { msg: err.message }), 'error'); }
  });

  /* ================= 滚动 & 进度 ================= */
  let syncing = false;
  function syncScroll(from, to) {
    if (pdfReader || state.view !== 'both' || syncing) return;
    syncing = true;
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    setTimeout(() => syncing = false, 60);
  }
  $('#pane-zh').addEventListener('scroll', () => {
    syncScroll($('#pane-zh'), $('#pane-en'));
    if (state.view !== 'en') updateReadingProgress();
  });
  $('#pane-en').addEventListener('scroll', () => {
    syncScroll($('#pane-en'), $('#pane-zh'));
    if (state.view === 'en') updateReadingProgress();
  });

  /* ================= 字体 / 主题 ================= */
  $('#font-inc').addEventListener('click', () => {
    state.settings.fontSize = Math.min(24, state.settings.fontSize + 1);
    applySettings(); saveSettings(); setTimeout(updateReadingProgress, 0);
  });
  $('#font-dec').addEventListener('click', () => {
    state.settings.fontSize = Math.max(12, state.settings.fontSize - 1);
    applySettings(); saveSettings(); setTimeout(updateReadingProgress, 0);
  });
  const THEMES = ['light', 'sepia', 'dark'];
  $('#theme-toggle').addEventListener('click', () => {
    const i = THEMES.indexOf(state.settings.theme);
    state.settings.theme = THEMES[(i + 1) % THEMES.length];
    applySettings(); saveSettings();
  });

  /* ================= 其它 ================= */
  $$('.view-switch button').forEach((b) =>
    b.addEventListener('click', () => setView(b.dataset.view)));
  $('#toggle-nav').addEventListener('click', () => $('#nav-panel').classList.toggle('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideSelectionToolbar(); closeNoteDialog(); }
  });
  $('#pane-zh').addEventListener('click', handleContentClick);
  $('#pane-en').addEventListener('click', handleContentClick);

  /* ================= 初始化 ================= */
  async function init() {
    loadSettings();
    window.applyTranslations();
    setView(localStorage.getItem(STORAGE.view) || 'both');
    updateVersionLabel();
    if (!hasHighlightAPI()) {
      console.warn('CSS Custom Highlight API not supported; falling back to mark.');
    }
    try {
      await migrateLegacyDatabase();
      await loadNotes();
      await loadBackground();
      await loadLibrary();
      const lastId = localStorage.getItem(STORAGE.lastBook);
      const target = state.books.find((b) => b.id === lastId) || state.books[0];
      if (target) await switchBook(target.id);
      updateBackupReminder();
      if (state.migrationInfo) {
        showToast(t('migration.done', {
          notes: state.migrationInfo.notes,
          books: state.migrationInfo.books,
        }));
      }
    } catch (e) {
      console.error(e);
      ensureMarkdownPanes();
      const pane = $('#pane-zh .markdown-body');
      if (pane) {
        pane.innerHTML = `<h1>${t('init.failed')}</h1><p>${e.message}</p><p>${t('init.hint')}</p>`;
      }
    }
  }

  // 窗口尺寸变化：PDF 适应宽度模式重新排版（防抖）
  let pdfResizeTimer = null;
  window.addEventListener('resize', () => {
    if (!pdfReader) return;
    if (pdfResizeTimer) clearTimeout(pdfResizeTimer);
    pdfResizeTimer = setTimeout(() => {
      pdfResizeTimer = null;
      if (pdfReader) { try { pdfReader.resize(); } catch (e) { console.warn('[PDF] 重排失败', e); } }
    }, 200);
  });

  // 兜底：任何未捕获的异步异常都给出提示，避免静默失败
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    console.error('[Unhandled]', reason);
    try { showToast(t('toast.unexpected', { msg: (reason && reason.message) || '' }), 'error'); } catch (e) {}
  });

  init();
})();