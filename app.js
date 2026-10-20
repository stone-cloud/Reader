(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const state = {
    books: [],
    currentBookId: null,
    currentChapterId: null,
    view: 'both',
    settings: { fontSize: 16, theme: 'light' },
    notes: [],
    pendingSelection: null,
    editingNoteId: null,
    editingTags: [],
    activeTagFilter: null,
    selectedNoteIds: new Set(),
  };

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

  function stripPrefix(path, prefix) {
    if (prefix && path.startsWith(prefix)) return path.slice(prefix.length);
    return path;
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
  }
  const db = new DB();

  /* ================= 内置书 & 书籍管理 ================= */
  async function ensureBuiltinBook() {
    let book = await db.get('books', 'fde');
    if (book) return book;
    const res = await fetch('content/manifest.json');
    if (!res.ok) throw new Error('无法加载 content/manifest.json');
    const manifest = await res.json();
    book = {
      id: 'fde',
      title: manifest.title || 'FDE - The Guidance Book',
      isBuiltin: true,
      chapters: manifest.chapters,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.put('books', book);
    return book;
  }

  async function loadBooks() {
    const all = await db.getAll('books');
    all.sort((a, b) => {
      if (a.isBuiltin && !b.isBuiltin) return -1;
      if (!a.isBuiltin && b.isBuiltin) return 1;
      return a.createdAt - b.createdAt;
    });
    state.books = all;
    renderBookSelect();
  }

  function renderBookSelect() {
    const sel = $('#book-select');
    sel.innerHTML = '';
    state.books.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.title + (b.isBuiltin ? ' (内置)' : '');
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

    let lastId = null;
    try { lastId = localStorage.getItem(`fde-last-chapter-${bookId}`); } catch (e) {}
    const chapterId = book.chapters.find((c) => c.id === lastId)?.id || book.chapters[0].id;
    await loadChapter(chapterId);
  }

  async function loadBookFile(book, path) {
    if (!path) return '';
    if (book.isBuiltin) {
      const res = await fetch(path);
      return res.ok ? res.text() : '';
    }
    const f = await db.get('bookFiles', `${book.id}/${path}`);
    return f ? f.content : '';
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

  /* ================= CSS Highlight ================= */
  const HL_NAME = 'fde-note';
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
    try { Object.assign(state.settings, JSON.parse(localStorage.getItem('fde-settings') || '{}')); } catch (e) {}
    applySettings();
  }
  function saveSettings() { localStorage.setItem('fde-settings', JSON.stringify(state.settings)); }
  function applySettings() {
    document.documentElement.style.setProperty('--font-size', state.settings.fontSize + 'px');
    document.documentElement.setAttribute('data-theme', state.settings.theme);
  }

  /* ================= 笔记加载 ================= */
  async function migrateLegacyNotes() {
    const raw = localStorage.getItem('fde-notes');
    if (!raw) return;
    try {
      const old = JSON.parse(raw);
      if (!Array.isArray(old) || !old.length) { localStorage.removeItem('fde-notes'); return; }
      const existing = await db.getAll('notes');
      const ids = new Set(existing.map((n) => n.id));
      const toAdd = old.filter((n) => !ids.has(n.id)).map((n) => cleanNoteForDB({
        ...n, bookId: 'fde', tags: n.tags || [],
        selector: n.selector || { exact: n.quote || '', prefix: '', suffix: '', position: 0 },
      }));
      if (toAdd.length) await db.bulkPut('notes', toAdd);
      localStorage.removeItem('fde-notes');
    } catch (e) { console.warn('迁移旧笔记失败', e); }
  }

  async function loadNotes() {
    await migrateLegacyNotes();
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

    $('#pane-zh .markdown-body').innerHTML = DOMPurify.sanitize(md.render(zhText || '# 加载失败'));
    $('#pane-en .markdown-body').innerHTML = DOMPurify.sanitize(md.render(enText || '# Failed to load'));

    addAnchors($('#pane-zh .markdown-body'));
    addAnchors($('#pane-en .markdown-body'));
    buildToc($('#pane-zh .markdown-body'));
    applyHighlights();
    refreshNotesUI();
    $('#pane-zh').scrollTop = 0;
    $('#pane-en').scrollTop = 0;
    updateReadingProgress();
  }

  function slugify(t) {
    return t.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function addAnchors(container) {
    const used = new Set();
    container.querySelectorAll('h1,h2,h3,h4').forEach((h, i) => {
      const base = slugify(h.textContent) || 'h-' + i;
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
  let savedRange = null;
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
      savedRange = range.cloneRange();
      const rect = range.getBoundingClientRect();
      const tb = $('#selection-toolbar');
      tb.classList.remove('hidden');
      tb.style.top = Math.max(8, rect.top - 44) + 'px';
      tb.style.left = Math.max(8, rect.left + rect.width / 2 - 60) + 'px';
      state.pendingSelection = {
        text, lang: pane.id === 'pane-zh' ? 'zh' : 'en',
        chapterId: state.currentChapterId, bookId: state.currentBookId,
        selector: serializeSelection(savedRange),
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
      try { await addNote(state.pendingSelection.text, '', state.pendingSelection, []); showToast('✓ 已高亮并保存'); }
      catch (err) { showToast('保存失败：' + err.message, 'error'); }
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
      .forEach((n) => (n.tags || []).forEach((t) => set.add(t)));
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
      b.type = 'button'; b.textContent = '×'; b.title = '移除';
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
      .filter((t) => !state.editingTags.includes(t))
      .filter((t) => !q || t.toLowerCase().includes(q))
      .forEach((tag) => {
        const el = document.createElement('span');
        el.className = 'tag clickable';
        el.textContent = tag;
        el.title = '点击添加';
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
        if (!n) { showToast('找不到该笔记', 'error'); closeNoteDialog(); return; }
        await db.put('notes', cleanNoteForDB({ ...n, note: noteText, tags, updatedAt: Date.now() }));
        await loadNotes();
        refreshNotesUI(); applyHighlights();
        showToast('✓ 笔记已更新');
      } else if (state.pendingSelection) {
        await addNote(state.pendingSelection.text, noteText, state.pendingSelection, tags);
        showToast('✓ 笔记已保存');
      }
    } catch (e) {
      console.error(e);
      showToast('保存失败：' + e.message, 'error');
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
      .forEach((n) => (n.tags || []).forEach((t) => set.add(t)));
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
    btn.textContent = cnt > 0 ? `🗑 ${cnt}` : '🗑';
    btn.title = cnt > 0 ? `删除选中的 ${cnt} 条` : '删除选中';
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
      const hint = state.activeTagFilter ? `无「${state.activeTagFilter}」标签的笔记` : '本章暂无笔记';
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
        n.tags.forEach((t) => {
          const el = document.createElement('span');
          el.className = 'tag clickable';
          el.textContent = t;
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            state.activeTagFilter = state.activeTagFilter === t ? null : t;
            refreshNotesUI();
          });
          tw.appendChild(el);
        });
        main.appendChild(tw);
      }
      const body = document.createElement('div');
      body.className = 'note-body';
      body.textContent = n.note || '(仅高亮)';
      main.appendChild(body);
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = (n.lang === 'zh' ? '中文' : 'English') + ' · ' +
        new Date(n.createdAt).toLocaleString('zh-CN');
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'note-actions';
      const jb = document.createElement('button'); jb.textContent = '跳转';
      jb.addEventListener('click', (e) => { e.stopPropagation(); jumpToNote(n); });
      const eb = document.createElement('button'); eb.textContent = '编辑';
      eb.addEventListener('click', (e) => { e.stopPropagation(); openNoteDialog(n.quote, n.note, n.id, n.tags); });
      const db_ = document.createElement('button'); db_.textContent = '删除';
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
    if (!confirm('确认删除这条笔记？')) return;
    try {
      await db.delete('notes', id);
      state.selectedNoteIds.delete(id);
      await loadNotes();
      refreshNotesUI(); applyHighlights();
      showToast('✓ 已删除 1 条');
    } catch (e) { showToast('删除失败：' + e.message, 'error'); }
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
    if (!confirm(`确认删除选中的 ${ids.length} 条笔记？此操作不可撤销。`)) return;
    try {
      for (const id of ids) await db.delete('notes', id);
      state.selectedNoteIds.clear();
      await loadNotes();
      refreshNotesUI(); applyHighlights();
      showToast(`✓ 已删除 ${ids.length} 条`);
    } catch (e) { showToast('批量删除失败：' + e.message, 'error'); }
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

  /* ================= 上传书籍 ================= */
  let uploadData = { files: [], title: '', chapters: null, rootPrefix: '' };

  function resetUploadDialog() {
    uploadData = { files: [], title: '', chapters: null, rootPrefix: '' };
    $('#upload-status').textContent = '';
    $('#upload-status').className = 'upload-status';
    $('#upload-preview').innerHTML = '';
    $('#upload-title-wrap').style.display = 'none';
    $('#upload-confirm').disabled = true;
    $('#upload-title').value = '';
  }

  function extractTitle(content, fallback) {
    const m = content.match(/^#\s+(.+?)\s*$/m);
    return m ? m[1].trim() : fallback;
  }

  function analyzeFilesForUpload(files) {
    const zhMap = new Map(), enMap = new Map();
    for (const f of files) {
      const zh = f.path.match(/(?:^|\/)zh\/([^/]+\.md)$/i);
      const en = f.path.match(/(?:^|\/)en\/([^/]+\.md)$/i);
      if (zh) zhMap.set(zh[1], f);
      else if (en) enMap.set(en[1], f);
    }
    const all = new Set([...zhMap.keys(), ...enMap.keys()]);
    const chapters = [];
    for (const basename of Array.from(all).sort()) {
      const zhF = zhMap.get(basename), enF = enMap.get(basename);
      chapters.push({
        id: basename.replace(/\.md$/i, ''),
        titleZh: zhF ? extractTitle(zhF.content, basename) : (enF ? extractTitle(enF.content, basename) : basename),
        titleEn: enF ? extractTitle(enF.content, basename) : (zhF ? extractTitle(zhF.content, basename) : basename),
        zh: zhF ? zhF.path : '',
        en: enF ? enF.path : '',
      });
    }
    return chapters;
  }

  async function handleUploadFiles(files) {
    const status = $('#upload-status');
    if (!files.length) {
      status.className = 'upload-status error';
      status.textContent = '没有找到文件';
      return;
    }

    const mdFiles = files.filter((f) => f.path.endsWith('.md'));
    const manifestFile = files.find((f) => f.path.endsWith('manifest.json'));

    if (!mdFiles.length) {
      status.className = 'upload-status error';
      status.textContent = '没有找到任何 .md 文件';
      return;
    }

    let manifest, rootPrefix = '';

    if (manifestFile) {
      try { manifest = JSON.parse(manifestFile.content); }
      catch (e) {
        status.className = 'upload-status error';
        status.textContent = 'manifest.json 解析失败：' + e.message;
        return;
      }
      // 推断根前缀（manifest 所在位置相对于书根）
      if (manifestFile.path.endsWith('content/manifest.json')) {
        rootPrefix = manifestFile.path.slice(0, -'content/manifest.json'.length);
      } else if (manifestFile.path.endsWith('/manifest.json')) {
        rootPrefix = manifestFile.path.slice(0, -'manifest.json'.length);
      } else if (manifestFile.path === 'manifest.json') {
        rootPrefix = '';
      }
      // manifest 里的路径是相对书根，直接使用；文件存的时候要剥掉 rootPrefix
    } else {
      const chapters = analyzeFilesForUpload(mdFiles);
      if (!chapters.length) {
        status.className = 'upload-status error';
        status.textContent = '没有在 zh/ 或 en/ 目录下找到 .md 文件，也没有 manifest.json';
        return;
      }
      // 推断根前缀
      const sample = mdFiles.find((f) => /(?:^|\/)zh\/[^/]+\.md$/i.test(f.path));
      if (sample) {
        const m = sample.path.match(/^(.*?)(?:content\/)?zh\//i);
        if (m) rootPrefix = m[1] || '';
      }
      manifest = { title: '', chapters };
    }

    uploadData.files = files;
    uploadData.chapters = manifest.chapters;
    uploadData.rootPrefix = rootPrefix;

    // 书名默认值
    let defaultTitle = manifest.title || '';
    if (!defaultTitle && rootPrefix) {
      defaultTitle = rootPrefix.replace(/\/$/, '').split('/').pop();
    }
    if (!defaultTitle) defaultTitle = '导入的书籍';
    uploadData.title = defaultTitle;
    $('#upload-title').value = defaultTitle;
    $('#upload-title-wrap').style.display = 'flex';

    // 预览
    const prev = $('#upload-preview');
    prev.innerHTML = '';
    const ul = document.createElement('ul');
    manifest.chapters.slice(0, 20).forEach((ch, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${ch.titleZh || ch.id} / ${ch.titleEn || ch.id}`;
      ul.appendChild(li);
    });
    if (manifest.chapters.length > 20) {
      const li = document.createElement('li');
      li.style.color = 'var(--text-secondary)';
      li.textContent = `... 还有 ${manifest.chapters.length - 20} 章`;
      ul.appendChild(li);
    }
    prev.appendChild(ul);

    status.className = 'upload-status success';
    status.textContent = `✓ 共 ${manifest.chapters.length} 章，${mdFiles.length} 个 md 文件`;
    $('#upload-confirm').disabled = false;
  }

  async function readZip(file) {
    if (!window.JSZip) throw new Error('JSZip 未加载');
    const zip = await JSZip.loadAsync(file);
    const files = [];
    const entries = Object.entries(zip.files);
    for (const [path, entry] of entries) {
      if (entry.dir) continue;
      if (!path.endsWith('.md') && !path.endsWith('manifest.json')) continue;
      files.push({ path, content: await entry.async('text') });
    }
    return files;
  }

  async function readFolder(fileList) {
    const files = [];
    for (const f of fileList) {
      if (!f.name.endsWith('.md') && !f.name.endsWith('manifest.json')) continue;
      const path = f.webkitRelativePath || f.name;
      files.push({ path, content: await f.text() });
    }
    return files;
  }

  $('#upload-book').addEventListener('click', () => {
    resetUploadDialog();
    $('#upload-dialog').classList.remove('hidden');
  });
  $('#upload-cancel').addEventListener('click', () => {
    $('#upload-dialog').classList.add('hidden');
    resetUploadDialog();
  });
  $('#upload-title').addEventListener('input', (e) => { uploadData.title = e.target.value; });

  $('#upload-zip-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      $('#upload-status').className = 'upload-status';
      $('#upload-status').textContent = '正在解压…';
      const files = await readZip(file);
      await handleUploadFiles(files);
    } catch (err) {
      $('#upload-status').className = 'upload-status error';
      $('#upload-status').textContent = '解压失败：' + err.message;
    }
  });

  $('#upload-folder-input').addEventListener('change', async (e) => {
    const fileList = e.target.files;
    e.target.value = '';
    if (!fileList || !fileList.length) return;
    try {
      $('#upload-status').className = 'upload-status';
      $('#upload-status').textContent = '正在读取文件夹…';
      const files = await readFolder(fileList);
      await handleUploadFiles(files);
    } catch (err) {
      $('#upload-status').className = 'upload-status error';
      $('#upload-status').textContent = '读取失败：' + err.message;
    }
  });

  $('#upload-confirm').addEventListener('click', async () => {
    if (!uploadData.chapters || !uploadData.files.length) return;
    const title = ($('#upload-title').value || uploadData.title || '导入的书籍').trim();
    try {
      const bookId = 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const book = {
        id: bookId,
        title,
        isBuiltin: false,
        chapters: uploadData.chapters,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 存文件（剥掉 rootPrefix），跳过 manifest.json
      const toSave = [];
      for (const f of uploadData.files) {
        if (f.path.endsWith('manifest.json')) continue;
        const rel = stripPrefix(f.path, uploadData.rootPrefix);
        toSave.push({ key: `${bookId}/${rel}`, bookId, path: rel, content: f.content });
      }

      await db.put('books', book);
      if (toSave.length) await db.bulkPut('bookFiles', toSave);

      await loadBooks();
      $('#upload-dialog').classList.add('hidden');
      resetUploadDialog();
      await switchBook(bookId);
      showToast(`✓ 已导入「${title}」`);
    } catch (e) {
      console.error(e);
      $('#upload-status').className = 'upload-status error';
      $('#upload-status').textContent = '导入失败：' + e.message;
    }
  });

  $('#book-select').addEventListener('change', (e) => switchBook(e.target.value));
  $('#chapter-select').addEventListener('change', (e) => loadChapter(e.target.value));

  /* ================= 面板 & 导入导出 ================= */
  $('#toggle-notes').addEventListener('click', () => {
    $('#notes-panel').classList.toggle('hidden');
    refreshNotesUI();
  });
  $('#close-notes').addEventListener('click', () => $('#notes-panel').classList.add('hidden'));

  $('#export-notes').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.notes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fde-notes-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('✓ 已导出 ' + state.notes.length + ' 条');
  });
  $('#import-notes-btn').addEventListener('click', () => $('#import-notes-input').click());
  $('#import-notes-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error('格式错误');
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
      showToast(`✓ 导入完成，新增 ${toAdd.length} 条`);
    } catch (err) { showToast('导入失败：' + err.message, 'error'); }
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
    setView(localStorage.getItem('fde-view') || 'both');
    if (!hasHighlightAPI()) {
      console.warn('当前浏览器不支持 CSS Custom Highlight API，高亮降级为 mark 方案。');
    }
    try {
      await loadNotes();
      await ensureBuiltinBook();
      await loadBooks();
      const lastId = localStorage.getItem('fde-last-book') || 'fde';
      const target = state.books.find((b) => b.id === lastId) || state.books[0];
      await switchBook(target.id);
    } catch (e) {
      console.error(e);
      $('#pane-zh .markdown-body').innerHTML =
        '<h1>初始化失败</h1><p>' + e.message + '</p>' +
        '<p>请通过 HTTP 服务器访问（如 <code>python3 -m http.server</code>），不要直接双击打开。</p>';
    }
  }
  init();
})();