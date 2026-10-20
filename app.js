(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const state = {
    manifest: null,
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

  /* ================= Toast ================= */
  let toastTimer = null;
  function showToast(message, type = 'success') {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    if (toastTimer) clearTimeout(toastTimer);
    const toast = document.createElement('div');
    toast.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    }, 2000);
  }

  /* ================= 存库白名单 ================= */
  function cleanNoteForDB(note) {
    return {
      id: note.id,
      chapterId: note.chapterId,
      lang: note.lang,
      quote: note.quote,
      selector: note.selector,
      note: note.note || '',
      tags: Array.isArray(note.tags) ? note.tags : [],
      createdAt: note.createdAt,
      updatedAt: note.updatedAt || note.createdAt,
    };
  }

  /* ================= IndexedDB ================= */
  class NotesDB {
    constructor(name = 'fde-reader', store = 'notes') {
      this.dbName = name;
      this.storeName = store;
      this._db = null;
    }
    async open() {
      if (this._db) return this._db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'id' });
          }
        };
        req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
        req.onerror = (e) => reject(e.target.error);
      });
    }
    async getAll() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(this.storeName, 'readonly').objectStore(this.storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }
    async put(note) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put(note);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    async delete(id) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    async bulkPut(notes) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        notes.forEach((n) => store.put(n));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }
  const notesDB = new NotesDB();

  async function migrateLegacyNotes() {
    const raw = localStorage.getItem('fde-notes');
    if (!raw) return;
    try {
      const old = JSON.parse(raw);
      if (!Array.isArray(old) || old.length === 0) {
        localStorage.removeItem('fde-notes');
        return;
      }
      const existing = await notesDB.getAll();
      const existingIds = new Set(existing.map((n) => n.id));
      const migrated = old
        .filter((n) => !existingIds.has(n.id))
        .map((n) => cleanNoteForDB({
          ...n,
          tags: n.tags || [],
          selector: n.selector || { exact: n.quote || '', prefix: '', suffix: '', position: 0 },
        }));
      if (migrated.length) await notesDB.bulkPut(migrated);
      localStorage.removeItem('fde-notes');
    } catch (e) {
      console.warn('迁移旧笔记失败', e);
    }
  }

  /* ================= TextQuoteSelector ================= */
  function serializeSelection(range) {
    const exact = range.toString();
    if (!exact) return null;
    const startNode = range.startContainer;
    const startEl = startNode.nodeType === 1 ? startNode : startNode.parentElement;
    const article = startEl.closest('.markdown-body');
    if (!article) return null;

    const preRange = document.createRange();
    preRange.selectNodeContents(article);
    preRange.setEnd(range.startContainer, range.startOffset);
    const before = preRange.toString();

    const postRange = document.createRange();
    postRange.selectNodeContents(article);
    postRange.setStart(range.endContainer, range.endOffset);
    const after = postRange.toString();

    return {
      exact,
      prefix: before.slice(-32),
      suffix: after.slice(0, 32),
      position: before.length,
    };
  }

  function findTextPosition(article, selector) {
    if (!selector || !selector.exact) return null;
    const { exact, prefix = '', suffix = '', position = 0 } = selector;

    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const textNodes = [];
    let fullText = '';
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push({ node, start: fullText.length });
      fullText += node.nodeValue;
    }
    if (!fullText) return null;

    const matches = [];
    let idx = 0;
    while ((idx = fullText.indexOf(exact, idx)) !== -1) {
      matches.push(idx);
      idx += 1;
    }
    if (matches.length === 0) return null;

    let best = matches[0], bestScore = -Infinity;
    for (const m of matches) {
      let score = 0;
      const b = fullText.slice(Math.max(0, m - prefix.length), m);
      const a = fullText.slice(m + exact.length, m + exact.length + suffix.length);
      if (prefix && b.endsWith(prefix)) score += 20;
      else if (prefix && b && prefix.endsWith(b)) score += b.length / 2;
      if (suffix && a.startsWith(suffix)) score += 20;
      else if (suffix && a && suffix.startsWith(a)) score += a.length / 2;
      score -= Math.abs(m - position) / 1000;
      if (score > bestScore) { bestScore = score; best = m; }
    }

    const startPos = best;
    const endPos = best + exact.length;
    const startTn = findNodeAt(textNodes, startPos);
    const endTn = findNodeAt(textNodes, endPos);
    if (!startTn || !endTn) return null;

    const range = document.createRange();
    range.setStart(startTn.node, startPos - startTn.start);
    range.setEnd(endTn.node, endPos - endTn.start);
    return range;
  }

  function findNodeAt(textNodes, pos) {
    let last = null;
    for (const tn of textNodes) {
      if (pos >= tn.start && pos <= tn.start + tn.node.nodeValue.length) return tn;
      last = tn;
    }
    return last;
  }

  /* ================= CSS Custom Highlight API ================= */
  const HIGHLIGHT_NAME = 'fde-note';
  const supportsHighlightAPI = () =>
    typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  function clearHighlights() {
    noteRanges.clear();
    if (supportsHighlightAPI()) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }
    $$('.markdown-body mark[data-note-id]').forEach((m) => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }

  function applyHighlights() {
    clearHighlights();
    const notes = state.notes.filter((n) => n.chapterId === state.currentChapterId);
    const useAPI = supportsHighlightAPI();
    const highlight = useAPI ? new Highlight() : null;

    for (const note of notes) {
      if (!note.selector) continue;
      const article = note.lang === 'zh'
        ? $('#pane-zh .markdown-body')
        : $('#pane-en .markdown-body');
      if (!article) continue;
      const range = findTextPosition(article, note.selector);
      if (!range) continue;
      noteRanges.set(note.id, range);

      if (useAPI) {
        highlight.add(range);
      } else {
        try {
          const mark = document.createElement('mark');
          mark.dataset.noteId = note.id;
          range.surroundContents(mark);
        } catch (e) { /* 忽略 */ }
      }
    }
    if (useAPI && highlight.size > 0) CSS.highlights.set(HIGHLIGHT_NAME, highlight);
  }

  function handleContentClick(e) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (!supportsHighlightAPI()) return;

    let pointRange = null;
    if (document.caretRangeFromPoint) {
      pointRange = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        pointRange = document.createRange();
        pointRange.setStart(pos.offsetNode, pos.offset);
        pointRange.setEnd(pos.offsetNode, pos.offset);
      }
    }
    if (!pointRange) return;

    for (const note of state.notes) {
      if (note.chapterId !== state.currentChapterId) continue;
      const range = noteRanges.get(note.id);
      if (!range) continue;
      if (range.isPointInRange(pointRange.startContainer, pointRange.startOffset)) {
        $('#notes-panel').classList.remove('hidden');
        refreshNotesUI();
        const item = document.querySelector(`#notes-list [data-note-id="${note.id}"]`);
        if (item) {
          item.scrollIntoView({ block: 'nearest' });
          item.style.transition = 'background 0.3s';
          item.style.background = 'var(--highlight)';
          setTimeout(() => { item.style.background = ''; }, 1200);
        }
        return;
      }
    }
  }

  /* ================= 阅读进度条 ================= */
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
  async function loadNotes() {
    await migrateLegacyNotes();
    state.notes = (await notesDB.getAll())
      .map(cleanNoteForDB)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ================= manifest & 章节 ================= */
  async function loadManifest() {
    const res = await fetch('content/manifest.json');
    if (!res.ok) throw new Error('无法加载 manifest.json');
    state.manifest = await res.json();
    const sel = $('#chapter-select');
    sel.innerHTML = '';
    state.manifest.chapters.forEach((ch) => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `${ch.titleZh} / ${ch.titleEn}`;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => loadChapter(sel.value));
  }

  async function loadChapter(id) {
    const ch = state.manifest.chapters.find((c) => c.id === id);
    if (!ch) return;
    state.currentChapterId = id;
    $('#chapter-select').value = id;
    localStorage.setItem('fde-last-chapter', id);

    state.selectedNoteIds.clear();
    state.activeTagFilter = null;

    const [zhText, enText] = await Promise.all([
      fetch(ch.zh).then((r) => (r.ok ? r.text() : '# 加载失败')),
      fetch(ch.en).then((r) => (r.ok ? r.text() : '# Failed to load')),
    ]);

    $('#pane-zh .markdown-body').innerHTML = DOMPurify.sanitize(md.render(zhText));
    $('#pane-en .markdown-body').innerHTML = DOMPurify.sanitize(md.render(enText));

    addAnchors($('#pane-zh .markdown-body'));
    addAnchors($('#pane-en .markdown-body'));
    buildToc($('#pane-zh .markdown-body'));
    applyHighlights();
    refreshNotesUI();

    $('#pane-zh').scrollTop = 0;
    $('#pane-en').scrollTop = 0;
    updateReadingProgress();
  }

  function slugify(text) {
    return text.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
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
          $$('#toc-list a').forEach((a) =>
            a.classList.toggle('active', a.dataset.target === e.target.id)
          );
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

  /* ================= 选区工具栏 ================= */
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
      const toolbar = $('#selection-toolbar');
      toolbar.classList.remove('hidden');
      toolbar.style.top = Math.max(8, rect.top - 44) + 'px';
      toolbar.style.left = Math.max(8, rect.left + rect.width / 2 - 60) + 'px';
      state.pendingSelection = {
        text,
        lang: pane.id === 'pane-zh' ? 'zh' : 'en',
        chapterId: state.currentChapterId,
        selector: serializeSelection(savedRange),
      };
    }, 0);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.selection-toolbar') && !e.target.closest('.modal-content')) {
      hideSelectionToolbar();
    }
  });
  function hideSelectionToolbar() { $('#selection-toolbar').classList.add('hidden'); }

  $('#selection-toolbar').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !state.pendingSelection) return;
    const action = btn.dataset.action;
    if (action === 'highlight') {
      try {
        await addNote(state.pendingSelection.text, '', state.pendingSelection, []);
        showToast('✓ 已高亮并保存');
      } catch (err) {
        showToast('保存失败：' + err.message, 'error');
      }
    } else if (action === 'note') {
      openNoteDialog(state.pendingSelection.text, '', null, []);
    }
    hideSelectionToolbar();
    window.getSelection().removeAllRanges();
  });

  /* ================= v3.2: 标签编辑器 + 已有标签建议 ================= */

  // 全库已有标签（跨章节），用于建议
  function getGlobalTags() {
    const set = new Set();
    state.notes.forEach((n) => (n.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }

  function renderTagEditor() {
    const editor = $('#note-tags-editor');
    editor.innerHTML = '';
    state.editingTags.forEach((tag, i) => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '×';
      btn.title = '移除标签';
      btn.addEventListener('click', () => {
        state.editingTags.splice(i, 1);
        refreshTagEditorUI();
      });
      span.appendChild(btn);
      editor.appendChild(span);
    });
  }

  // 渲染建议 chips：去掉已添加的、按输入框关键词过滤
  function renderTagSuggestions() {
    const wrap = $('#note-tag-suggestions');
    if (!wrap) return;
    wrap.innerHTML = '';
    const query = ($('#note-tag-input').value || '').trim().toLowerCase();
    const suggestions = getGlobalTags()
      .filter((t) => !state.editingTags.includes(t))
      .filter((t) => !query || t.toLowerCase().includes(query));

    suggestions.forEach((tag) => {
      const el = document.createElement('span');
      el.className = 'tag clickable';
      el.textContent = tag;
      el.title = '点击添加此标签';
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

  function refreshTagEditorUI() {
    renderTagEditor();
    renderTagSuggestions();
  }

  $('#note-tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/[,，]/g, '');
      if (val && !state.editingTags.includes(val)) {
        state.editingTags.push(val);
        e.target.value = '';
        refreshTagEditorUI();
      } else if (val) {
        // 已存在则清空输入框
        e.target.value = '';
        renderTagSuggestions();
      }
    } else if (e.key === 'Backspace' && e.target.value === '' && state.editingTags.length > 0) {
      state.editingTags.pop();
      refreshTagEditorUI();
    }
  });

  // 输入时过滤建议
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
        if (!n) {
          showToast('保存失败：找不到该笔记', 'error');
          closeNoteDialog();
          return;
        }
        const updated = {
          ...n,
          note: noteText,
          tags,
          updatedAt: Date.now(),
        };
        await notesDB.put(cleanNoteForDB(updated));
        await loadNotes();
        refreshNotesUI();
        applyHighlights();
        showToast('✓ 笔记已更新');
      } else if (state.pendingSelection) {
        await addNote(state.pendingSelection.text, noteText, state.pendingSelection, tags);
        showToast('✓ 笔记已保存');
      }
    } catch (e) {
      console.error('保存笔记失败', e);
      showToast('保存失败：' + e.message, 'error');
    }
    closeNoteDialog();
  });

  async function addNote(quote, noteText, selInfo, tags = []) {
    const note = {
      id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      chapterId: selInfo.chapterId || state.currentChapterId,
      lang: selInfo.lang || 'zh',
      quote,
      selector: selInfo.selector || { exact: quote, prefix: '', suffix: '', position: 0 },
      note: noteText,
      tags: tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await notesDB.put(cleanNoteForDB(note));
    await loadNotes();
    refreshNotesUI();
    applyHighlights();
  }

  /* ================= 笔记列表 / 标签 / 批量 ================= */
  function getFilteredNotes() {
    return state.notes.filter((n) => {
      if (n.chapterId !== state.currentChapterId) return false;
      if (state.activeTagFilter && !(n.tags || []).includes(state.activeTagFilter)) return false;
      return true;
    });
  }

  function getAllTags() {
    const set = new Set();
    state.notes
      .filter((n) => n.chapterId === state.currentChapterId)
      .forEach((n) => (n.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }

  function renderTagFilter() {
    const wrap = $('#tag-filter');
    wrap.innerHTML = '';
    const tags = getAllTags();
    if (tags.length === 0) {
      wrap.style.display = 'none';
      return;
    }
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
    const visible = getFilteredNotes();
    const selectedCount = state.selectedNoteIds.size;
    const btn = $('#batch-delete-notes');
    btn.disabled = selectedCount === 0;
    btn.textContent = selectedCount > 0 ? `🗑 ${selectedCount}` : '🗑';
    btn.title = selectedCount > 0 ? `删除选中的 ${selectedCount} 条` : '删除选中';

    const allChecked = visible.length > 0 && visible.every((n) => state.selectedNoteIds.has(n.id));
    const someChecked = visible.some((n) => state.selectedNoteIds.has(n.id));
    const cb = $('#select-all-notes');
    cb.checked = allChecked;
    cb.indeterminate = !allChecked && someChecked;
    cb.disabled = visible.length === 0;
  }

  function renderNotesList() {
    const list = $('#notes-list');
    list.innerHTML = '';
    const filtered = getFilteredNotes();

    if (filtered.length === 0) {
      const hint = state.activeTagFilter
        ? `无「${state.activeTagFilter}」标签的笔记`
        : '本章暂无笔记';
      list.innerHTML = `<li style="cursor:default;color:var(--text-secondary)">${hint}</li>`;
      return;
    }

    filtered.forEach((n) => {
      const li = document.createElement('li');
      li.dataset.noteId = n.id;
      li.classList.toggle('selected', state.selectedNoteIds.has(n.id));

      const rowHead = document.createElement('div');
      rowHead.className = 'note-row-head';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selectedNoteIds.has(n.id);
      checkbox.title = '选中以批量操作';
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (checkbox.checked) state.selectedNoteIds.add(n.id);
        else state.selectedNoteIds.delete(n.id);
        li.classList.toggle('selected', checkbox.checked);
        updateBatchControls();
      });
      checkbox.addEventListener('click', (e) => e.stopPropagation());

      const main = document.createElement('div');
      main.className = 'note-main';

      const quoteEl = document.createElement('div');
      quoteEl.className = 'note-quote-text';
      quoteEl.textContent = n.quote;
      main.appendChild(quoteEl);

      if (n.tags && n.tags.length) {
        const tagsWrap = document.createElement('div');
        tagsWrap.className = 'note-tags';
        n.tags.forEach((t) => {
          const tagEl = document.createElement('span');
          tagEl.className = 'tag clickable';
          tagEl.textContent = t;
          tagEl.addEventListener('click', (e) => {
            e.stopPropagation();
            state.activeTagFilter = state.activeTagFilter === t ? null : t;
            refreshNotesUI();
          });
          tagsWrap.appendChild(tagEl);
        });
        main.appendChild(tagsWrap);
      }

      const bodyEl = document.createElement('div');
      bodyEl.className = 'note-body';
      bodyEl.textContent = n.note || '(仅高亮)';
      main.appendChild(bodyEl);

      const meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = (n.lang === 'zh' ? '中文' : 'English') + ' · ' +
        new Date(n.createdAt).toLocaleString('zh-CN');
      main.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'note-actions';
      const jumpBtn = document.createElement('button');
      jumpBtn.textContent = '跳转';
      jumpBtn.addEventListener('click', (e) => { e.stopPropagation(); jumpToNote(n); });
      const editBtn = document.createElement('button');
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openNoteDialog(n.quote, n.note, n.id, n.tags);
      });
      const delBtn = document.createElement('button');
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(n.id); });
      actions.append(jumpBtn, editBtn, delBtn);
      main.appendChild(actions);

      rowHead.appendChild(checkbox);
      rowHead.appendChild(main);
      li.appendChild(rowHead);

      li.addEventListener('click', (e) => {
        if (e.target.closest('input, button, .tag')) return;
        jumpToNote(n);
      });

      list.appendChild(li);
    });
  }

  function refreshNotesUI() {
    renderTagFilter();
    renderNotesList();
    updateBatchControls();
  }

  async function deleteNote(id) {
    if (!confirm('确认删除这条笔记？')) return;
    try {
      await notesDB.delete(id);
      state.selectedNoteIds.delete(id);
      await loadNotes();
      refreshNotesUI();
      applyHighlights();
      showToast('✓ 已删除 1 条笔记');
    } catch (e) {
      showToast('删除失败：' + e.message, 'error');
    }
  }

  $('#select-all-notes').addEventListener('change', (e) => {
    const visible = getFilteredNotes();
    if (e.target.checked) {
      visible.forEach((n) => state.selectedNoteIds.add(n.id));
    } else {
      visible.forEach((n) => state.selectedNoteIds.delete(n.id));
    }
    renderNotesList();
    updateBatchControls();
  });

  $('#batch-delete-notes').addEventListener('click', async () => {
    const ids = Array.from(state.selectedNoteIds);
    if (ids.length === 0) return;
    if (!confirm(`确认删除选中的 ${ids.length} 条笔记？此操作不可撤销。`)) return;
    try {
      for (const id of ids) await notesDB.delete(id);
      state.selectedNoteIds.clear();
      await loadNotes();
      refreshNotesUI();
      applyHighlights();
      showToast(`✓ 已删除 ${ids.length} 条笔记`);
    } catch (e) {
      showToast('批量删除失败：' + e.message, 'error');
    }
  });

  function jumpToNote(note) {
    let range = noteRanges.get(note.id);
    if (!range) {
      const article = note.lang === 'zh'
        ? $('#pane-zh .markdown-body')
        : $('#pane-en .markdown-body');
      if (article && note.selector) {
        range = findTextPosition(article, note.selector);
        if (range) noteRanges.set(note.id, range);
      }
    }
    if (range) {
      const el = range.startContainer.parentElement;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background 0.3s';
      const old = el.style.background;
      el.style.background = 'var(--highlight)';
      setTimeout(() => { el.style.background = old; }, 1500);
    }
  }

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
    showToast('✓ 已导出 ' + state.notes.length + ' 条笔记');
  });
  $('#import-notes-btn').addEventListener('click', () => $('#import-notes-input').click());
  $('#import-notes-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (Array.isArray(data)) {
        const ids = new Set(state.notes.map((n) => n.id));
        const toAdd = data
          .filter((n) => !ids.has(n.id))
          .map((n) => cleanNoteForDB({
            ...n,
            tags: n.tags || [],
            selector: n.selector || { exact: n.quote || '', prefix: '', suffix: '', position: 0 },
          }));
        if (toAdd.length) {
          await notesDB.bulkPut(toAdd);
          await loadNotes();
          refreshNotesUI();
          applyHighlights();
        }
        showToast(`✓ 导入完成，新增 ${toAdd.length} 条`);
      }
    } catch (err) { showToast('导入失败：' + err.message, 'error'); }
    e.target.value = '';
  });

  /* ================= 滚动同步 & 进度条 ================= */
  let syncing = false;
  function syncScroll(from, to) {
    if (state.view !== 'both' || syncing) return;
    syncing = true;
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    setTimeout(() => { syncing = false; }, 60);
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
    applySettings(); saveSettings();
    setTimeout(updateReadingProgress, 0);
  });
  $('#font-dec').addEventListener('click', () => {
    state.settings.fontSize = Math.max(12, state.settings.fontSize - 1);
    applySettings(); saveSettings();
    setTimeout(updateReadingProgress, 0);
  });
  const THEMES = ['light', 'sepia', 'dark'];
  $('#theme-toggle').addEventListener('click', () => {
    const idx = THEMES.indexOf(state.settings.theme);
    state.settings.theme = THEMES[(idx + 1) % THEMES.length];
    applySettings(); saveSettings();
  });

  /* ================= 其它 ================= */
  $$('.view-switch button').forEach((btn) =>
    btn.addEventListener('click', () => setView(btn.dataset.view))
  );
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

    if (!supportsHighlightAPI()) {
      console.warn('当前浏览器不支持 CSS Custom Highlight API，将降级为 mark 高亮（跨节点仍会失效）。建议 Chrome 105+ / Edge 105+ / Safari 17.2+ / Firefox 140+。');
    }

    try {
      await loadNotes();
      await loadManifest();
      const last = localStorage.getItem('fde-last-chapter') || state.manifest.chapters[0].id;
      await loadChapter(last);
      updateReadingProgress();
    } catch (e) {
      $('#pane-zh .markdown-body').innerHTML =
        '<h1>初始化失败</h1><p>' + e.message + '</p>' +
        '<p>请通过 HTTP 服务器访问（如 <code>python3 -m http.server</code>），不要直接双击打开。</p>';
    }
  }
  init();
})();