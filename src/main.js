import './style.css';

// --- Storage ---
// Three tiers, in resolution order at startup:
//   1. /api/store  — Vite dev middleware (data/store.json). Local development.
//   2. GitHub gist — cross-device sync, configured per-browser via the sync dialog.
//   3. localStorage — last-resort per-browser cache (also the write-through cache for the gist tier).
const STORE_URL = '/api/store';
const LOCAL_KEY = 'daily-dashboard:store';
const GIST_CONFIG_KEY = 'daily-dashboard:gist';
const GIST_FILENAME = 'daily-dashboard.json';

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeLocal(state) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch { /* quota / SecurityError */ }
}

function readGistConfig() {
  try {
    const raw = localStorage.getItem(GIST_CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : null;
    return cfg && cfg.id && cfg.token ? cfg : null;
  } catch { return null; }
}
function writeGistConfig(cfg) {
  try { localStorage.setItem(GIST_CONFIG_KEY, JSON.stringify(cfg)); } catch {}
}
function clearGistConfig() {
  try { localStorage.removeItem(GIST_CONFIG_KEY); } catch {}
}

async function gistFetch(cfg) {
  const res = await fetch(`https://api.github.com/gists/${cfg.id}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const file = body.files?.[GIST_FILENAME];
  if (!file) return {}; // gist exists but file not present yet — treat as empty
  // For large files the inline content is truncated; fetch raw_url instead.
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url).then((r) => r.text());
    return raw ? JSON.parse(raw) : {};
  }
  return file.content ? JSON.parse(file.content) : {};
}

async function gistWrite(cfg, state) {
  const res = await fetch(`https://api.github.com/gists/${cfg.id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function applyData(state, data) {
  // Mutate arrays in place so module-level references stay valid.
  state.todos.splice(0, state.todos.length, ...(data.todos || []));
  state.archivedTodos.splice(0, state.archivedTodos.length, ...(data.archivedTodos || []));
  // Legacy migration: a single `links` array folds into quickLinks if quickLinks is absent.
  const quick = data.quickLinks ?? data.links ?? [];
  state.quickLinks.splice(0, state.quickLinks.length, ...quick);
  state.savedLinks.splice(0, state.savedLinks.length, ...(data.savedLinks || []));
  state.theme = data.theme === 'light' ? 'light' : 'dark';
}

function isEmpty(data) {
  if (!data) return true;
  return (data.todos?.length || 0)
       + (data.archivedTodos?.length || 0)
       + (data.quickLinks?.length || 0)
       + (data.savedLinks?.length || 0)
       + (data.links?.length || 0) === 0;
}

const store = {
  state: { todos: [], archivedTodos: [], quickLinks: [], savedLinks: [], theme: 'dark' },
  _saveTimer: null,
  mode: 'local',          // 'file' | 'gist' | 'local'
  syncStatus: 'idle',     // 'idle' | 'syncing' | 'synced' | 'error'

  async load() {
    // 1) Dev file API
    try {
      const res = await fetch(STORE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyData(this.state, await res.json());
      this.mode = 'file';
      return;
    } catch { /* fall through */ }

    // 2) Gist if configured
    const cfg = readGistConfig();
    if (cfg) {
      this._setSync('syncing');
      try {
        applyData(this.state, await gistFetch(cfg));
        this.mode = 'gist';
        this._setSync('synced');
        return;
      } catch (err) {
        console.warn('[store] gist load failed; falling back to localStorage', err);
        this._setSync('error', err);
      }
    }

    // 3) localStorage
    const local = readLocal();
    if (local) applyData(this.state, local);
    this.mode = 'local';
    if (!cfg) this._setSync('local');
  },

  /** Debounced async write. Multiple rapid saves coalesce into one network call. */
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), 200);
  },

  async _flush() {
    this._saveTimer = null;
    // localStorage is always a synchronous write-through cache.
    writeLocal(this.state);

    if (this.mode === 'file') {
      try {
        const res = await fetch(STORE_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.state),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch { /* localStorage already has it */ }
      return;
    }
    if (this.mode === 'gist') {
      const cfg = readGistConfig();
      if (!cfg) { this.mode = 'local'; this._setSync('local'); return; }
      this._setSync('syncing');
      try {
        await gistWrite(cfg, this.state);
        this._setSync('synced');
      } catch (err) {
        this._setSync('error', err);
      }
    }
    // 'local' mode: localStorage write above is sufficient.
  },

  _setSync(status, err) {
    this.syncStatus = status;
    updateSyncPip(status);
    if (err && /\b401\b/.test(String(err.message))) {
      showToast('Cloud sync: auth failed — re-enter your token', { label: 'Open', fn: openSyncDialog });
    }
  },
};

// --- State (references to store.state arrays — mutated in place) ---
let todos = store.state.todos;
let archivedTodos = store.state.archivedTodos;
let quickLinks = store.state.quickLinks;
let savedLinks = store.state.savedLinks;
let quickQuery = '';
let editingLinkId = null;
let editingLinkKind = 'quick'; // 'quick' | 'saved' — which list the dialog is editing

// --- DOM ---
const $ = (s) => document.querySelector(s);
const dateEl        = $('#date');
const greetingEl    = $('#greeting');
const themeToggle   = $('#theme-toggle');

const todoList      = $('#todo-list');
const todoInput     = $('#todo-input');
const todoForm      = $('#todo-form');
const todoEmpty     = $('#todo-empty');
const tasksMeta     = $('#tasks-meta');
const progressEl    = $('#progress');
const progressFill  = $('#progress-fill');

const archiveEl     = $('#archive');
const archiveList   = $('#archive-list');
const archiveCount  = $('#archive-count');

const quickGrid     = $('#quick-grid');
const quickEmpty    = $('#quick-empty');
const quickSearch   = $('#quick-search');
const quickSearchClear = $('#quick-search-clear');
const quickMeta     = $('#quick-meta');
const quickAddBtn   = $('#quick-add-btn');

const savedArchive  = $('#saved-archive');
const savedCount    = $('#saved-count');
const savedGrid     = $('#saved-grid');

const editDialog    = $('#edit-dialog');
const editForm      = $('#edit-form');
const editTitle     = $('#edit-title');
const editUrl       = $('#edit-url');
const editCancel    = $('#edit-cancel');
const editClose     = $('#edit-dialog-close');
const editDialogTitle = $('#edit-dialog-title');
const editSaveBtn   = $('#edit-save');

const syncBtn       = $('#sync-btn');
const syncPip       = $('#sync-pip');
const syncDialog    = $('#sync-dialog');
const syncForm      = $('#sync-form');
const syncGistId    = $('#sync-gist-id');
const syncToken     = $('#sync-token');
const syncStatus    = $('#sync-status');
const syncClose     = $('#sync-dialog-close');
const syncClearBtn  = $('#sync-clear');
const syncRefreshBtn = $('#sync-refresh');

const toast         = $('#toast');

// --- Date + greeting ---
function updateHeader() {
  const now = new Date();
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  dateEl.textContent = now.toLocaleDateString(undefined, opts);
  const h = now.getHours();
  const period = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  greetingEl.innerHTML = `Good <em>${period}</em>.`;
}

// --- Theme ---
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  store.state.theme = theme;
  store.save();
}
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  setTheme(next);
});

// --- Toast ---
let toastTimer;
function showToast(msg, action) {
  clearTimeout(toastTimer);
  toast.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.onclick = () => { action.fn(); hideToast(); };
    toast.appendChild(btn);
  }
  toast.classList.add('show');
  toastTimer = setTimeout(hideToast, 4500);
}
function hideToast() { toast.classList.remove('show'); }

// =====================================================
// TODOS
// =====================================================
// All persisted state lives in store.state; the arrays here are references,
// so mutations are already visible to the save serializer.
const saveTodos = () => store.save();

function buildTodoItem(todo, { archived = false } = {}) {
  const li = document.createElement('li');
  li.className = `todo-item${todo.done ? ' completed' : ''}`;
  li.dataset.id = todo.id;
  li.draggable = true;

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.setAttribute('aria-hidden', 'true');
  handle.innerHTML = ICONS.grip;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = todo.done;
  cb.addEventListener('change', () => toggleTodo(todo.id, archived));

  const span = document.createElement('span');
  span.className = 'todo-text';
  span.textContent = todo.text;
  span.contentEditable = 'true';
  span.spellcheck = false;
  span.addEventListener('blur', () => editTodo(todo.id, span.textContent.trim(), archived));
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
    if (e.key === 'Escape') { span.textContent = todo.text; span.blur(); }
  });

  const actions = document.createElement('div');
  actions.className = 'todo-actions';

  if (archived) {
    actions.appendChild(makeBtn('restore', 'Restore', () => unarchiveTodo(todo.id)));
  } else {
    actions.appendChild(makeBtn('archive', 'Archive', () => archiveTodo(todo.id)));
  }
  actions.appendChild(makeBtn('trash', 'Delete', () => deleteTodo(todo.id, archived), 'danger'));

  li.append(handle, cb, span, actions);
  return li;
}

function makeBtn(kind, label, onClick, extra = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn-icon${extra ? ' ' + extra : ''}`;
  btn.ariaLabel = label;
  btn.title = label;
  btn.innerHTML = ICONS[kind];
  btn.addEventListener('click', onClick);
  return btn;
}

function renderTodos() {
  todoList.innerHTML = '';
  archiveList.innerHTML = '';

  const total = todos.length;
  const done = todos.filter(t => t.done).length;

  todoEmpty.classList.toggle('hidden', total > 0);
  tasksMeta.textContent = total ? `${done} of ${total} done` : '';

  if (total > 0) {
    progressEl.classList.add('show');
    progressFill.style.width = `${(done / total) * 100}%`;
  } else {
    progressEl.classList.remove('show');
    progressFill.style.width = '0%';
  }

  todos.forEach((todo) => todoList.appendChild(buildTodoItem(todo)));

  // Archive section
  if (archivedTodos.length > 0) {
    archiveEl.hidden = false;
    archiveCount.textContent = archivedTodos.length;
    archivedTodos.forEach((todo) => archiveList.appendChild(buildTodoItem(todo, { archived: true })));
  } else {
    archiveEl.hidden = true;
    archiveEl.open = false;
  }
}

function addTodo(text) {
  todos.unshift({ id: Date.now() + Math.random(), text, done: false });
  saveTodos(); renderTodos();
}
function toggleTodo(id, archived) {
  const arr = archived ? archivedTodos : todos;
  const t = arr.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  saveTodos(); renderTodos();
}
function editTodo(id, text, archived) {
  const arr = archived ? archivedTodos : todos;
  const t = arr.find(x => x.id === id);
  if (!t) return;
  if (!text) { deleteTodo(id, archived); return; }
  t.text = text;
  saveTodos();
}
function deleteTodo(id, archived) {
  const arr = archived ? archivedTodos : todos;
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return;
  const [removed] = arr.splice(idx, 1);
  saveTodos(); renderTodos();
  showToast('Task removed', { label: 'Undo', fn: () => { arr.splice(idx, 0, removed); saveTodos(); renderTodos(); } });
}
function archiveTodo(id) {
  const idx = todos.findIndex(x => x.id === id);
  if (idx < 0) return;
  const [item] = todos.splice(idx, 1);
  archivedTodos.unshift(item);
  saveTodos(); renderTodos();
  showToast('Task archived', { label: 'Undo', fn: () => {
    const ai = archivedTodos.findIndex(x => x.id === id);
    if (ai >= 0) archivedTodos.splice(ai, 1);
    todos.splice(idx, 0, item);
    saveTodos(); renderTodos();
  }});
}
function unarchiveTodo(id) {
  const idx = archivedTodos.findIndex(x => x.id === id);
  if (idx < 0) return;
  const [item] = archivedTodos.splice(idx, 1);
  todos.unshift(item);
  saveTodos(); renderTodos();
}

todoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = todoInput.value.trim();
  if (!text) return;
  addTodo(text);
  todoInput.value = '';
});

// =====================================================
// LINKS — two lists share the dialog & helpers, but render differently.
//   - quickLinks: tile grid for frequent access
//   - savedLinks: vertical list of "save for later" entries
// =====================================================
const saveLinks = () => store.save();

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}
function faviconUrl(url) {
  const host = hostname(url);
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : '';
}
function initialOf(s) {
  return (s || '?').trim().charAt(0).toUpperCase();
}

function listFor(kind) {
  return kind === 'saved' ? savedLinks : quickLinks;
}
function renderFor(kind) {
  if (kind === 'saved') renderSavedLinks();
  else renderQuickLinks();
}

function filteredQuickLinks() {
  if (!quickQuery) return quickLinks;
  const q = quickQuery.toLowerCase();
  return quickLinks.filter(l =>
    l.title.toLowerCase().includes(q) ||
    l.url.toLowerCase().includes(q)
  );
}

// --- Quick Links: tile grid ---
function renderQuickLinks() {
  quickGrid.innerHTML = '';
  const visible = filteredQuickLinks();

  quickMeta.textContent = quickLinks.length
    ? (quickQuery ? `${visible.length} of ${quickLinks.length}` : `${quickLinks.length} saved`)
    : '';

  quickEmpty.classList.toggle('hidden', quickLinks.length > 0);
  if (quickLinks.length === 0) return;

  visible.forEach((link) => quickGrid.appendChild(buildLinkTile(link, 'quick')));

  // Trailing "add" tile (only when not searching)
  if (!quickQuery) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'link-tile link-tile-add';
    add.innerHTML = `<span class="plus">+</span><span class="add-text">Add quick link</span>`;
    add.addEventListener('click', () => openAddLinkDialog());
    quickGrid.appendChild(add);
  }

  if (visible.length === 0 && quickQuery) {
    const note = document.createElement('p');
    note.className = 'empty-state';
    note.style.gridColumn = '1 / -1';
    note.innerHTML = `<span class="empty-icon">·</span><span class="empty-title">No quick links match "${escapeHtml(quickQuery)}"</span>`;
    quickGrid.appendChild(note);
  }
}

// --- Saved for Later: same tile grid, lives inside a collapsible <details> ---
function renderSavedLinks() {
  savedGrid.innerHTML = '';
  if (savedLinks.length === 0) {
    savedArchive.hidden = true;
    savedArchive.open = false;
    return;
  }
  savedArchive.hidden = false;
  savedCount.textContent = savedLinks.length;
  savedLinks.forEach((link) => savedGrid.appendChild(buildLinkTile(link, 'saved')));
}

// Single tile factory for both lists. Action set varies by kind:
//   quick → edit, save-for-later (bookmark), delete
//   saved → edit, restore to quick links, delete
function buildLinkTile(link, kind = 'quick') {
  const tile = document.createElement('a');
  tile.className = 'link-tile';
  tile.href = link.url;
  tile.target = '_blank';
  tile.rel = 'noopener noreferrer';
  tile.dataset.id = link.id;
  // Drag-to-reorder only makes sense in the unfiltered list — disable quick tiles while searching.
  tile.draggable = kind === 'quick' ? !quickQuery : true;

  // Favicon
  const faviconWrap = document.createElement('div');
  faviconWrap.className = 'link-favicon-wrap';
  const fav = faviconUrl(link.url);
  if (fav) {
    const img = document.createElement('img');
    img.className = 'link-favicon';
    img.src = fav;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => {
      faviconWrap.innerHTML = '';
      const fb = document.createElement('span');
      fb.className = 'link-favicon-fallback';
      fb.textContent = initialOf(link.title);
      faviconWrap.appendChild(fb);
    };
    faviconWrap.appendChild(img);
  } else {
    const fb = document.createElement('span');
    fb.className = 'link-favicon-fallback';
    fb.textContent = initialOf(link.title);
    faviconWrap.appendChild(fb);
  }

  // Info
  const info = document.createElement('div');
  info.className = 'link-info';

  const title = document.createElement('div');
  title.className = 'link-title';
  title.textContent = link.title;
  title.title = link.title;

  const domain = document.createElement('div');
  domain.className = 'link-domain';
  domain.textContent = hostname(link.url);
  domain.title = link.url;

  info.append(title, domain);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'link-actions';
  actions.appendChild(makeLinkAction('edit', 'Edit', (e) => {
    e.preventDefault(); e.stopPropagation();
    openEditLinkDialog(link.id, kind);
  }));
  if (kind === 'saved') {
    actions.appendChild(makeLinkAction('restore', 'Move to Quick Links', (e) => {
      e.preventDefault(); e.stopPropagation();
      restoreFromSaved(link.id);
    }));
  } else {
    actions.appendChild(makeLinkAction('bookmark', 'Save for later', (e) => {
      e.preventDefault(); e.stopPropagation();
      saveForLater(link.id);
    }));
  }
  actions.appendChild(makeLinkAction('trash', 'Delete', (e) => {
    e.preventDefault(); e.stopPropagation();
    deleteLink(link.id, kind);
  }, 'danger'));

  tile.append(actions, faviconWrap, info);
  return tile;
}

function makeLinkAction(kind, label, onClick, extra = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `link-action${extra ? ' ' + extra : ''}`;
  btn.ariaLabel = label;
  btn.title = label;
  btn.innerHTML = ICONS[kind];
  btn.addEventListener('click', onClick);
  return btn;
}

// --- Move between lists (mirrors archive/unarchive for todos) ---
function saveForLater(id) {
  const idx = quickLinks.findIndex(l => l.id === id);
  if (idx < 0) return;
  const [item] = quickLinks.splice(idx, 1);
  savedLinks.unshift(item);
  saveLinks(); renderQuickLinks(); renderSavedLinks();
  showToast('Saved for later', { label: 'Undo', fn: () => {
    const si = savedLinks.findIndex(l => l.id === id);
    if (si >= 0) savedLinks.splice(si, 1);
    quickLinks.splice(idx, 0, item);
    saveLinks(); renderQuickLinks(); renderSavedLinks();
  }});
}
function restoreFromSaved(id) {
  const idx = savedLinks.findIndex(l => l.id === id);
  if (idx < 0) return;
  const [item] = savedLinks.splice(idx, 1);
  quickLinks.unshift(item);
  saveLinks(); renderQuickLinks(); renderSavedLinks();
}

const ICONS = {
  edit:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  archive:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  restore:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>',
  grip:     '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
};

// --- Link dialog (shared for add to Quick + edit in either list) ---
// Add only targets Quick Links; saved entries are populated by saving an existing
// quick link, mirroring how archived todos can't be added directly.
const EDIT_LABEL = { quick: 'Edit quick link', saved: 'Edit saved link' };
const REMOVED_TOAST = { quick: 'Quick link removed', saved: 'Saved link removed' };

function openAddLinkDialog() {
  editingLinkId = null;
  editingLinkKind = 'quick';
  editDialogTitle.textContent = 'Add quick link';
  editSaveBtn.textContent = 'Add';
  editTitle.value = '';
  editUrl.value = '';
  showLinkDialog();
}
function openEditLinkDialog(id, kind) {
  const link = listFor(kind).find(l => l.id === id);
  if (!link) return;
  editingLinkId = id;
  editingLinkKind = kind;
  editDialogTitle.textContent = EDIT_LABEL[kind];
  editSaveBtn.textContent = 'Save';
  editTitle.value = link.title;
  editUrl.value = link.url;
  showLinkDialog();
  requestAnimationFrame(() => editTitle.select());
}
function showLinkDialog() {
  if (typeof editDialog.showModal === 'function') {
    editDialog.showModal();
  } else {
    editDialog.setAttribute('open', '');
  }
  requestAnimationFrame(() => editTitle.focus());
}
function closeLinkDialog() {
  editingLinkId = null;
  if (editDialog.open) editDialog.close();
}

editForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = editTitle.value.trim();
  let url = editUrl.value.trim();
  if (!title || !url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const arr = listFor(editingLinkKind);
  if (editingLinkId == null) {
    // Add mode — always quick (saved entries come from saveForLater)
    arr.push({ id: Date.now() + Math.random(), title, url });
  } else {
    const link = arr.find(l => l.id === editingLinkId);
    if (!link) { closeLinkDialog(); return; }
    link.title = title;
    link.url = url;
  }
  saveLinks();
  renderFor(editingLinkKind);
  closeLinkDialog();
});
editCancel.addEventListener('click', closeLinkDialog);
editClose.addEventListener('click', closeLinkDialog);
editDialog.addEventListener('click', (e) => {
  if (e.target === editDialog) closeLinkDialog();
});
quickAddBtn.addEventListener('click', () => openAddLinkDialog());

function deleteLink(id, kind) {
  const arr = listFor(kind);
  const idx = arr.findIndex(l => l.id === id);
  if (idx < 0) return;
  const [removed] = arr.splice(idx, 1);
  saveLinks();
  renderFor(kind);
  showToast(REMOVED_TOAST[kind], { label: 'Undo', fn: () => {
    arr.splice(idx, 0, removed);
    saveLinks();
    renderFor(kind);
  }});
}

// Quick Links search (saved-for-later isn't searched — it's a collapsible archive)
function applyQuickSearch(value) {
  quickQuery = value.trim();
  quickSearchClear.hidden = quickSearch.value.length === 0;
  renderQuickLinks();
}
quickSearch.addEventListener('input', (e) => applyQuickSearch(e.target.value));
quickSearchClear.addEventListener('click', () => {
  quickSearch.value = '';
  applyQuickSearch('');
  quickSearch.focus();
});

// =====================================================
// SYNC DIALOG (cloud sync via GitHub gist)
// =====================================================
const SYNC_PIP_TITLE = {
  local:   'Local only — click to enable cloud sync',
  syncing: 'Syncing…',
  synced:  'Synced',
  error:   'Sync error — click to review',
};

function updateSyncPip(state) {
  if (!syncPip) return;
  syncPip.dataset.state = state === 'idle' ? 'local' : state;
  syncBtn.title = SYNC_PIP_TITLE[syncPip.dataset.state] || 'Cloud sync';
}

function setSyncStatusText(msg, kind = '') {
  syncStatus.textContent = msg || '';
  syncStatus.dataset.kind = kind;
}

function openSyncDialog() {
  const cfg = readGistConfig();
  syncGistId.value = cfg?.id || '';
  syncToken.value = cfg?.token || '';
  syncClearBtn.disabled = !cfg;
  syncRefreshBtn.disabled = !cfg;
  if (cfg) {
    setSyncStatusText(
      store.syncStatus === 'error' ? 'Last sync failed. Check your token.' :
      store.syncStatus === 'synced' ? 'Connected.' :
      store.syncStatus === 'syncing' ? 'Syncing…' : 'Connected.'
    );
  } else {
    setSyncStatusText('Not configured. Paste a gist ID and PAT to enable sync.');
  }
  if (typeof syncDialog.showModal === 'function') syncDialog.showModal();
  else syncDialog.setAttribute('open', '');
  requestAnimationFrame(() => (cfg ? syncToken : syncGistId).focus());
}
function closeSyncDialog() {
  if (syncDialog.open) syncDialog.close();
}

syncBtn.addEventListener('click', openSyncDialog);
syncClose.addEventListener('click', closeSyncDialog);
syncDialog.addEventListener('click', (e) => { if (e.target === syncDialog) closeSyncDialog(); });

syncForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = syncGistId.value.trim();
  const token = syncToken.value.trim();
  if (!id || !token) { setSyncStatusText('Both fields required.', 'error'); return; }

  const cfg = { id, token };
  setSyncStatusText('Verifying…');
  let remote;
  try {
    remote = await gistFetch(cfg);
  } catch (err) {
    setSyncStatusText(`Error: ${err.message}`, 'error');
    return;
  }

  writeGistConfig(cfg);
  store.mode = 'gist';

  // First-sync migration: if the gist is empty but we have local data, push local up.
  // Otherwise the gist is authoritative — replace local state with remote.
  const localHasData = !isEmpty(store.state);
  if (isEmpty(remote) && localHasData) {
    store._setSync('syncing');
    try {
      await gistWrite(cfg, store.state);
      store._setSync('synced');
      closeSyncDialog();
      showToast('Cloud sync enabled — local data uploaded');
    } catch (err) {
      store._setSync('error', err);
      setSyncStatusText(`Error: ${err.message}`, 'error');
    }
    return;
  }

  applyData(store.state, remote);
  document.documentElement.setAttribute('data-theme', store.state.theme);
  renderTodos();
  renderQuickLinks();
  renderSavedLinks();
  store._setSync('synced');
  closeSyncDialog();
  showToast('Cloud sync enabled');
});

syncClearBtn.addEventListener('click', () => {
  clearGistConfig();
  store.mode = 'local';
  store._setSync('local');
  syncGistId.value = '';
  syncToken.value = '';
  syncClearBtn.disabled = true;
  syncRefreshBtn.disabled = true;
  setSyncStatusText('Sync disabled. Local data kept.');
  showToast('Cloud sync disabled');
});

syncRefreshBtn.addEventListener('click', async () => {
  const cfg = readGistConfig();
  if (!cfg) return;
  setSyncStatusText('Refreshing…');
  store._setSync('syncing');
  try {
    const remote = await gistFetch(cfg);
    applyData(store.state, remote);
    document.documentElement.setAttribute('data-theme', store.state.theme);
    renderTodos();
    renderQuickLinks();
    renderSavedLinks();
    store._setSync('synced');
    setSyncStatusText('Pulled latest from gist.');
  } catch (err) {
    store._setSync('error', err);
    setSyncStatusText(`Error: ${err.message}`, 'error');
  }
});

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const inField = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;

  if (e.key === 'Escape' && document.activeElement === quickSearch) {
    quickSearch.value = ''; applyQuickSearch(''); quickSearch.blur(); return;
  }

  if (inField) return;

  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); todoInput.focus(); }
  else if (k === 'l') { e.preventDefault(); openAddLinkDialog(); }
  else if (k === 'd') { e.preventDefault(); themeToggle.click(); }
  else if (k === '/') { e.preventDefault(); quickSearch.focus(); quickSearch.select(); }
});

// --- Helpers ---
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// =====================================================
// DRAG & DROP
// =====================================================
function reorderInList(list, fromId, toId, pos) {
  const fromIdx = list.findIndex((x) => String(x.id) === fromId);
  if (fromIdx < 0) return false;
  const [moved] = list.splice(fromIdx, 1);
  let toIdx = list.findIndex((x) => String(x.id) === toId);
  if (toIdx < 0) { list.splice(fromIdx, 0, moved); return false; }
  if (pos === 'after') toIdx++;
  list.splice(toIdx, 0, moved);
  return true;
}

/**
 * Wires native HTML5 drag-and-drop on a container.
 * @param {Object} opts
 * @param {HTMLElement} opts.container        - Element holding draggable children.
 * @param {string} opts.itemSelector          - Selector that matches draggable items.
 * @param {() => Array} opts.getList          - Returns the array backing the DOM (mutated in place on reorder).
 * @param {'y'|'x'} opts.axis                 - Direction used to decide before/after.
 * @param {() => void} opts.onChange          - Called after a successful reorder (persist + render).
 */
function setupDnd({ container, itemSelector, getList, axis, onChange }) {
  let draggingId = null;
  let currentTarget = null;
  let currentPos = null;

  function clearIndicators() {
    container.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
    currentTarget = null;
    currentPos = null;
  }

  function cleanup() {
    clearIndicators();
    container.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    draggingId = null;
  }

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item || !container.contains(item)) return;
    if (item.draggable === false) return;
    draggingId = item.dataset.id;
    // Defer adding the class so the browser captures the drag image first
    requestAnimationFrame(() => item.classList.add('dragging'));
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', draggingId); } catch { /* some browsers throw on links */ }
  });

  container.addEventListener('dragover', (e) => {
    if (!draggingId) return;
    const target = e.target.closest(itemSelector);
    if (!target || !container.contains(target)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (target.dataset.id === draggingId) { clearIndicators(); return; }
    const rect = target.getBoundingClientRect();
    const pos = axis === 'y'
      ? (e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
      : (e.clientX < rect.left + rect.width / 2  ? 'before' : 'after');
    if (target === currentTarget && pos === currentPos) return;
    clearIndicators();
    target.classList.add('drop-' + pos);
    currentTarget = target;
    currentPos = pos;
  });

  container.addEventListener('dragleave', (e) => {
    // Only clear if leaving the whole container, not moving between children
    if (!container.contains(e.relatedTarget)) clearIndicators();
  });

  container.addEventListener('drop', (e) => {
    if (!draggingId) return;
    e.preventDefault();
    const toId = currentTarget?.dataset.id;
    const pos = currentPos;
    const fromId = draggingId;
    cleanup();
    if (!toId || pos == null || fromId === toId) return;
    if (reorderInList(getList(), fromId, toId, pos)) onChange();
  });

  container.addEventListener('dragend', cleanup);
}

// Drag & drop — listeners live on the container, so they survive re-renders.
setupDnd({
  container: todoList,
  itemSelector: '.todo-item',
  getList: () => todos,
  axis: 'y',
  onChange: () => { saveTodos(); renderTodos(); },
});
setupDnd({
  container: archiveList,
  itemSelector: '.todo-item',
  getList: () => archivedTodos,
  axis: 'y',
  onChange: () => { saveTodos(); renderTodos(); },
});
setupDnd({
  container: quickGrid,
  itemSelector: '.link-tile:not(.link-tile-add)',
  getList: () => quickLinks,
  axis: 'x',
  onChange: () => { saveLinks(); renderQuickLinks(); },
});
setupDnd({
  container: savedGrid,
  itemSelector: '.link-tile',
  getList: () => savedLinks,
  axis: 'x',
  onChange: () => { saveLinks(); renderSavedLinks(); },
});

// --- Init ---
async function init() {
  await store.load();
  document.documentElement.setAttribute('data-theme', store.state.theme);
  updateHeader();
  renderTodos();
  renderQuickLinks();
  renderSavedLinks();
  guardPlaceholders();
}
init();

/**
 * Browser extensions (password managers, form autofillers, translators) sometimes
 * mis-identify our top-level inputs when a <dialog> opens and write garbage into
 * them — most commonly the literal string "null", which leaves the user with
 * useless placeholders and a stuck search filter. Pin the original placeholders
 * and scrub any "null"/"undefined" values that get injected.
 */
function guardPlaceholders() {
  const inputs = [todoInput, quickSearch].filter(Boolean);
  const original = new Map(inputs.map((el) => [el, el.getAttribute('placeholder') || '']));

  const isJunk = (v) => v === 'null' || v === 'undefined';

  const sanitize = (el) => {
    const want = original.get(el);
    if (el.getAttribute('placeholder') !== want) el.setAttribute('placeholder', want);
    if (isJunk(el.value)) {
      el.value = '';
      // Re-run downstream effects so dependent UI (clear-X, filter) updates.
      if (el === quickSearch) applyQuickSearch('');
    }
  };

  inputs.forEach(sanitize);

  // Watch for attribute changes — covers extensions that overwrite placeholder.
  const obs = new MutationObserver(() => inputs.forEach(sanitize));
  inputs.forEach((el) => obs.observe(el, { attributes: true, attributeFilter: ['placeholder', 'value'] }));

  // Also scrub right after dialogs open/close, which is when extensions
  // typically scan the DOM.
  [editDialog, syncDialog].filter(Boolean).forEach((dlg) => {
    dlg.addEventListener('close', () => inputs.forEach(sanitize));
    dlg.addEventListener('toggle', () => inputs.forEach(sanitize));
  });
}

// Keep greeting fresh when the tab regains focus across hour boundaries
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateHeader(); });

// Best-effort flush of any pending debounced save before the tab closes.
// Write localStorage synchronously (works on static hosts) and also fire a keepalive
// PUT so the dev server picks it up when available.
window.addEventListener('beforeunload', () => {
  if (store._saveTimer) {
    clearTimeout(store._saveTimer);
    writeLocal(store.state);
    try {
      fetch(STORE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(store.state),
        keepalive: true,
      });
    } catch { /* nothing more we can do */ }
  }
});
