(function () {
  'use strict';

  // 兜底：i18n.js 加载失败时，应用依然可用，只是语言功能失效
  window.t = window.t || ((key) => key);
  window.getLang = window.getLang || (() => 'zh');
  window.applyTranslations = window.applyTranslations || (() => {});

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const t = window.t;

  const state = {
    books: [],
    currentBookId: null,
    currentChapterId: null,
    view: 'both',
    settings: { fontSize: 16, theme: 'light', language: window.getLang() },
    notes: [],
    pendingSelection: null,
    editingNoteId: null,
    editingTags: [],
    activeTagFilter: null,
    selectedNoteIds: new Set(),
    uploadQueue: [],
    selectedLibraryIds: new Set(),
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
    return {
      id: n.id, bookId: n.bookId || 'fde', chapterId: n.chapterId,
      lang: n.lang, quote: n.quote, selector: n.selector,
      note: n.note || '', tags: Array.isArray(n.tags) ? n.tags : [],
      createdAt: n.createdAt, updatedAt: n.updatedAt || n.createdAt,
    };
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
      this.dbName = 'fde-reader';
      this.version = 2;
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
        };
        req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
        req.onerror = (e) => reject(e.target.error);
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
    const uploaded = uploadedAll.filter((b) => !b.isBuiltin);

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
    state.currentBookId = bookId;
    state.currentChapterId = null;
    state.activeTagFilter = null;
    state.selectedNoteIds.clear();
    localStorage.setItem('fde-last-book', bookId);
    $('#book-select').value = bookId;

    const cSel = $('#chapter-select');
    cSel.innerHTML = '';
    book.chapters.forEach((ch) => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `${ch.titleZh} / ${ch.titleEn}`;
      cSel.appendChild(opt);
    });

    if (!book.chapters.length) {
      $('#pane-zh .markdown-body').innerHTML = `<h1>${t('chapter.no-chapters-zh')}</h1>`;
      $('#pane-en .markdown-body').innerHTML = `<h1>${t('chapter.no-chapters-en')}</h1>`;
      $('#toc-list').innerHTML = '';
      refreshNotesUI();
      updateReadingProgress();
      return;
    }

    let lastId = null;
    try { lastId = localStorage.getItem(`fde-last-chapter-${bookId}`); } catch (e) {}
    const chapterId = book.chapters.find((c) => c.id === lastId)?.id || book.chapters[0].id;
    await loadChapter(chapterId);
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
      meta.textContent = book.isBuiltin
        ? t('library.meta-builtin', { n: book.chapters.length })
        : t('library.meta-uploaded', { n: book.chapters.length });

      header.append(cb, titleEl, meta);

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
        li.textContent = `${ch.titleZh || ch.id} / ${ch.titleEn || ch.id}`;
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
    for (const id of ids) {
      const book = await db.get('books', id);
      if (!book || book.isBuiltin) continue;
      const files = allFiles
        .filter((f) => f.bookId === id)
        .map((f) => ({ path: f.path, content: f.content }));
      entries.push({ title: book.title, chapters: book.chapters, files });
    }
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

    if (!confirm(t('library.confirm-delete', {
      books: toDelete.length,
      notes: noteIds.length,
      files: fileKeys.length,
    }))) return;

    try {
      await db.bulkDelete('books', toDelete.map((b) => b.id));
      await db.bulkDelete('bookFiles', fileKeys);
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
    const article = startEl.closest('.markdown-body');
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
    clearHighlights();
    const notes = state.notes.filter((n) => n.bookId === state.currentBookId && n.chapterId === state.currentChapterId);
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
      if (note.bookId !== state.currentBookId || note.chapterId !== state.currentChapterId) continue;
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
    const pane = state.view === 'en' ? $('#pane-en') : $('#pane-zh');
    const max = pane.scrollHeight - pane.clientHeight;
    const pct = max > 0 ? (pane.scrollTop / max) * 100 : 0;
    $('#reading-progress-bar').style.width = pct.toFixed(2) + '%';
  }

  /* ================= 设置 ================= */
  function loadSettings() {
    try {
      Object.assign(state.settings, JSON.parse(localStorage.getItem('fde-settings') || '{}'));
    } catch (e) {}
    if (!state.settings.language) state.settings.language = window.getLang();
    window.currentLang = state.settings.language;
    $('#language-select').value = state.settings.language;
    applySettings();
  }
  function saveSettings() { localStorage.setItem('fde-settings', JSON.stringify(state.settings)); }
  function applySettings() {
    document.documentElement.style.setProperty('--font-size', state.settings.fontSize + 'px');
    document.documentElement.setAttribute('data-theme', state.settings.theme);
  }

  /* ================= 笔记 ================= */
  async function loadNotes() {
    state.notes = (await db.getAll('notes'))
      .map(cleanNoteForDB)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ================= 章节加载 ================= */
  async function loadChapter(chapterId) {
    const book = state.books.find((b) => b.id === state.currentBookId);
    if (!book) return;
    const ch = book.chapters.find((c) => c.id === chapterId);
    if (!ch) return;
    state.currentChapterId = chapterId;
    $('#chapter-select').value = chapterId;
    localStorage.setItem(`fde-last-chapter-${state.currentBookId}`, chapterId);
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
    localStorage.setItem('fde-view', view);
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
      const node = range.commonAncestorContainer;
      const pane = (node.nodeType === 1 ? node : node.parentElement)?.closest('.pane');
      if (!pane) { hideSelectionToolbar(); return; }
      const rect = range.getBoundingClientRect();
      const tb = $('#selection-toolbar');
      tb.classList.remove('hidden');
      tb.style.top = Math.max(8, rect.top - 44) + 'px';
      tb.style.left = Math.max(8, rect.left + rect.width / 2 - 60) + 'px';
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
      bookId: selInfo.bookId || state.currentBookId,
      chapterId: selInfo.chapterId || state.currentChapterId,
      lang: selInfo.lang || 'zh',
      quote,
      selector: selInfo.selector || { exact: quote, prefix: '', suffix: '', position: 0 },
      note: noteText, tags: tags || [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await db.put('notes', cleanNoteForDB(note));
    await loadNotes();
    refreshNotesUI(); applyHighlights();
  }

  /* ================= 笔记列表 ================= */
  function getFilteredNotes() {
    return state.notes.filter((n) => {
      if (n.bookId !== state.currentBookId) return false;
      if (n.chapterId !== state.currentChapterId) return false;
      if (state.activeTagFilter && !(n.tags || []).includes(state.activeTagFilter)) return false;
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
    const vis = getFilteredNotes();
    if (!vis.length) {
      const hint = state.activeTagFilter
        ? t('notes.empty-tag', { tag: state.activeTagFilter })
        : t('notes.empty-chapter');
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
      meta.textContent = (n.lang === 'zh' ? t('notes.lang-zh') : t('notes.lang-en'))
        + ' · ' + formatDate(n.createdAt);
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

  async function handleMultiUpload(rawFiles) {
    const status = $('#upload-status');
    if (!rawFiles.length) {
      status.className = 'upload-status error';
      status.textContent = t('upload.status-no-files');
      return;
    }
    const groups = groupFilesByBook(rawFiles);
    if (!groups.length) {
      status.className = 'upload-status error';
      status.textContent = t('upload.status-no-books');
      return;
    }
    const books = groups.map(parseBookGroup).filter((b) => b.chapters.length > 0);
    if (!books.length) {
      status.className = 'upload-status error';
      status.textContent = t('upload.status-no-chapters');
      return;
    }
    state.uploadQueue = books.map((b) => ({ ...b, checked: true }));
    renderUploadQueue();
    status.className = 'upload-status success';
    status.textContent = t('upload.status-detected', { n: books.length });
    $('#upload-import-db').disabled = false;
    $('#upload-export-zip').disabled = false;
  }

  function renderUploadQueue() {
    const wrap = $('#upload-books-list');
    wrap.innerHTML = '';
    state.uploadQueue.forEach((book) => {
      const card = document.createElement('div');
      card.className = 'upload-book-card';

      const header = document.createElement('div');
      header.className = 'upload-book-card-header';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = book.checked;
      cb.addEventListener('change', () => { book.checked = cb.checked; updateUploadButtons(); });

      const titleIn = document.createElement('input');
      titleIn.type = 'text';
      titleIn.className = 'upload-book-title';
      titleIn.value = book.title;
      titleIn.addEventListener('input', () => { book.title = titleIn.value; });

      const meta = document.createElement('span');
      meta.className = 'upload-book-meta';
      meta.textContent = `${book.chapters.length} · ${book.root || '/'}`;

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'upload-book-toggle';
      toggleBtn.textContent = t('library.chapters');
      const chaptersBox = document.createElement('div');
      chaptersBox.className = 'upload-book-chapters';
      chaptersBox.style.display = 'none';
      const ol = document.createElement('ol');
      book.chapters.forEach((ch) => {
        const li = document.createElement('li');
        li.textContent = `${ch.titleZh || ch.id} / ${ch.titleEn || ch.id}`;
        ol.appendChild(li);
      });
      chaptersBox.appendChild(ol);
      toggleBtn.addEventListener('click', () => {
        chaptersBox.style.display = chaptersBox.style.display === 'none' ? 'block' : 'none';
      });

      header.append(cb, titleIn, meta, toggleBtn);
      card.append(header, chaptersBox);
      wrap.appendChild(card);
    });
    updateUploadButtons();
  }

  function updateUploadButtons() {
    const anyChecked = state.uploadQueue.some((b) => b.checked);
    $('#upload-import-db').disabled = !anyChecked;
    $('#upload-export-zip').disabled = !anyChecked;
  }

  async function importToDB() {
    const selected = state.uploadQueue.filter((b) => b.checked);
    if (!selected.length) return;
    try {
      const importedIds = [];
      for (const book of selected) {
        const bookId = 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const record = {
          id: bookId,
          title: book.title,
          isBuiltin: false,
          chapters: book.chapters,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const files = book.files.map((f) => ({
          key: `${bookId}/${f.path}`,
          bookId,
          path: f.path,
          content: f.content,
        }));
        await db.put('books', record);
        if (files.length) await db.bulkPut('bookFiles', files);
        importedIds.push(bookId);
      }
      await loadLibrary();
      $('#upload-dialog').classList.add('hidden');
      resetUploadDialog();
      if (importedIds.length) await switchBook(importedIds[0]);
      showToast(t('upload.toast-imported', { n: importedIds.length }));
    } catch (e) {
      console.error(e);
      $('#upload-status').className = 'upload-status error';
      $('#upload-status').textContent = t('upload.status-import-failed', { msg: e.message });
    }
  }

  /* ================= 仓库包打包 ================= */
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
    const selected = state.uploadQueue.filter((b) => b.checked);
    await packageAsRepoZip(selected.map((b) => ({ title: b.title, chapters: b.chapters, files: b.files })));
  }

  function resetUploadDialog() {
    state.uploadQueue = [];
    $('#upload-status').textContent = '';
    $('#upload-status').className = 'upload-status';
    $('#upload-books-list').innerHTML = '';
    $('#upload-import-db').disabled = true;
    $('#upload-export-zip').disabled = true;
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

  async function readFolderFiles(fileList) {
    const out = [];
    for (const f of fileList) {
      const path = f.webkitRelativePath || f.name;
      if (isIgnoredPath(path)) continue;
      if (!path.endsWith('.md') && !path.endsWith('manifest.json')) continue;
      out.push({ path, content: await f.text() });
    }
    return out;
  }

  /* ================= 备份 / 恢复 ================= */
  function updateBackupReminder() {
    const last = parseInt(localStorage.getItem('fde-last-backup') || '0', 10);
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

  async function backupAll() {
    try {
      const zip = new JSZip();
      const notes = await db.getAll('notes');
      const allBooks = await db.getAll('books');
      const uploaded = allBooks.filter((b) => !b.isBuiltin);
      const files = await db.getAll('bookFiles');

      zip.file('notes.json', JSON.stringify(notes, null, 2));
      zip.file('books.json', JSON.stringify(uploaded, null, 2));
      for (const f of files) zip.file(`bookFiles/${f.key}`, f.content);
      zip.file('metadata.json', JSON.stringify({
        version: 'v0.0.6',
        backupAt: Date.now(),
        date: new Date().toISOString(),
        noteCount: notes.length,
        bookCount: uploaded.length,
        fileCount: files.length,
      }, null, 2));

      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `backup-${new Date().toISOString().slice(0, 10)}.zip`);
      localStorage.setItem('fde-last-backup', Date.now().toString());
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
      const notes = JSON.parse(await notesFile.async('text'));
      const books = JSON.parse(await booksFile.async('text'));

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

      const existingNotes = new Set((await db.getAll('notes')).map((n) => n.id));
      const newNotes = notes.filter((n) => !existingNotes.has(n.id));
      if (newNotes.length) await db.bulkPut('notes', newNotes);

      await loadLibrary();
      await loadNotes();
      refreshNotesUI(); applyHighlights();
      localStorage.setItem('fde-last-backup', Date.now().toString());
      updateBackupReminder();
      showToast(t('backup.restore-toast-done', { notes: newNotes.length, books: newBooks.length }));
    } catch (e) {
      console.error(e);
      showToast(t('backup.restore-toast-failed', { msg: e.message }), 'error');
    }
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
        const cSel = $('#chapter-select');
        const current = cSel.value;
        cSel.innerHTML = '';
        book.chapters.forEach((ch) => {
          const opt = document.createElement('option');
          opt.value = ch.id;
          opt.textContent = `${ch.titleZh} / ${ch.titleEn}`;
          cSel.appendChild(opt);
        });
        if (current) cSel.value = current;
      }
    }
    if (!$('#library-dialog').classList.contains('hidden')) renderLibraryList();
    if (!$('#upload-dialog').classList.contains('hidden')) renderUploadQueue();
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

  $('#upload-zip-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      $('#upload-status').className = 'upload-status';
      $('#upload-status').textContent = t('upload.status-extracting');
      const raw = await readZipFiles(files);
      await handleMultiUpload(raw);
    } catch (err) {
      $('#upload-status').className = 'upload-status error';
      $('#upload-status').textContent = t('upload.status-extract-failed', { msg: err.message });
    }
  });

  $('#upload-folder-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      $('#upload-status').className = 'upload-status';
      $('#upload-status').textContent = t('upload.status-reading');
      const raw = await readFolderFiles(files);
      await handleMultiUpload(raw);
    } catch (err) {
      $('#upload-status').className = 'upload-status error';
      $('#upload-status').textContent = t('upload.status-read-failed', { msg: err.message });
    }
  });

  $('#upload-import-db').addEventListener('click', importToDB);
  $('#upload-export-zip').addEventListener('click', exportQueueAsRepoZip);

  $('#book-select').addEventListener('change', (e) => switchBook(e.target.value));
  $('#chapter-select').addEventListener('change', (e) => loadChapter(e.target.value));

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
        ...n, bookId: n.bookId || 'fde', tags: n.tags || [],
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
    if (state.view !== 'both' || syncing) return;
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
    setView(localStorage.getItem('fde-view') || 'both');
    if (!hasHighlightAPI()) {
      console.warn('CSS Custom Highlight API not supported; falling back to mark.');
    }
    try {
      await loadNotes();
      await loadLibrary();
      const lastId = localStorage.getItem('fde-last-book');
      const target = state.books.find((b) => b.id === lastId) || state.books[0];
      if (target) await switchBook(target.id);
      updateBackupReminder();
    } catch (e) {
      console.error(e);
      $('#pane-zh .markdown-body').innerHTML =
        `<h1>${t('init.failed')}</h1><p>${e.message}</p><p>${t('init.hint')}</p>`;
    }
  }
  init();
})();