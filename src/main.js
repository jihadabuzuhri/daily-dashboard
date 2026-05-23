import './style.css';

// --- Storage (file-backed via Vite dev middleware: /api/store -> data/store.json) ---
const STORE_URL = '/api/store';

const store = {
  state: { todos: [], archivedTodos: [], links: [], theme: 'dark' },
  _saveTimer: null,

  async load() {
    try {
      const res = await fetch(STORE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Mutate arrays in place so module-level references stay valid.
      this.state.todos.splice(0, this.state.todos.length, ...(data.todos || []));
      this.state.archivedTodos.splice(0, this.state.archivedTodos.length, ...(data.archivedTodos || []));
      this.state.links.splice(0, this.state.links.length, ...(data.links || []));
      this.state.theme = data.theme === 'light' ? 'light' : 'dark';
    } catch (err) {
      console.warn('[store] load failed; running in-memory only', err);
    }
  },

  /** Debounced async write. Multiple rapid saves coalesce into one PUT. */
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), 200);
  },

  async _flush() {
    this._saveTimer = null;
    try {
      const res = await fetch(STORE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.state),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn('[store] save failed; changes only in memory', err);
    }
  },
};

// --- State (references to store.state arrays — mutated in place) ---
let todos = store.state.todos;
let archivedTodos = store.state.archivedTodos;
let links = store.state.links;
let linkQuery = '';
let editingLinkId = null;

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

const linkGrid      = $('#link-grid');
const linkEmpty     = $('#link-empty');
const linkSearch    = $('#link-search');
const linkSearchClear = $('#link-search-clear');
const linksMeta     = $('#links-meta');
const addLinkBtn    = $('#add-link-btn');

const editDialog    = $('#edit-dialog');
const editForm      = $('#edit-form');
const editTitle     = $('#edit-title');
const editUrl       = $('#edit-url');
const editCancel    = $('#edit-cancel');
const editClose     = $('#edit-dialog-close');
const editDialogTitle = $('#edit-dialog-title');
const editSaveBtn   = $('#edit-save');

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
// LINKS
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

function filteredLinks() {
  if (!linkQuery) return links;
  const q = linkQuery.toLowerCase();
  return links.filter(l =>
    l.title.toLowerCase().includes(q) ||
    l.url.toLowerCase().includes(q)
  );
}

function renderLinks() {
  linkGrid.innerHTML = '';
  const visible = filteredLinks();

  linksMeta.textContent = links.length
    ? (linkQuery ? `${visible.length} of ${links.length}` : `${links.length} saved`)
    : '';

  linkEmpty.classList.toggle('hidden', links.length > 0);
  if (links.length === 0) return;

  visible.forEach((link) => linkGrid.appendChild(buildLinkTile(link)));

  // Trailing "add" tile (only when not searching)
  if (!linkQuery) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'link-tile link-tile-add';
    add.innerHTML = `<span class="plus">+</span><span class="add-text">Add bookmark</span>`;
    add.addEventListener('click', openAddLinkDialog);
    linkGrid.appendChild(add);
  }

  // No results within search
  if (visible.length === 0 && linkQuery) {
    const note = document.createElement('p');
    note.className = 'empty-state';
    note.style.gridColumn = '1 / -1';
    note.innerHTML = `<span class="empty-icon">·</span><span class="empty-title">No bookmarks match "${escapeHtml(linkQuery)}"</span>`;
    linkGrid.appendChild(note);
  }
}

function buildLinkTile(link) {
  const tile = document.createElement('a');
  tile.className = 'link-tile';
  tile.href = link.url;
  tile.target = '_blank';
  tile.rel = 'noopener noreferrer';
  tile.dataset.id = link.id;
  // Drag-to-reorder only makes sense in the unfiltered list — disable while searching
  tile.draggable = !linkQuery;

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
    openEditLinkDialog(link.id);
  }));
  actions.appendChild(makeLinkAction('trash', 'Delete', (e) => {
    e.preventDefault(); e.stopPropagation();
    deleteLink(link.id);
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

const ICONS = {
  edit:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>',
  grip:    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
};

// --- Link dialog (shared for add + edit) ---
function openAddLinkDialog() {
  editingLinkId = null;
  editDialogTitle.textContent = 'Add bookmark';
  editSaveBtn.textContent = 'Add';
  editTitle.value = '';
  editUrl.value = '';
  showLinkDialog();
}
function openEditLinkDialog(id) {
  const link = links.find(l => l.id === id);
  if (!link) return;
  editingLinkId = id;
  editDialogTitle.textContent = 'Edit bookmark';
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

  if (editingLinkId == null) {
    // Add mode
    links.push({ id: Date.now() + Math.random(), title, url });
  } else {
    // Edit mode
    const link = links.find(l => l.id === editingLinkId);
    if (!link) { closeLinkDialog(); return; }
    link.title = title;
    link.url = url;
  }
  saveLinks(); renderLinks();
  closeLinkDialog();
});
editCancel.addEventListener('click', closeLinkDialog);
editClose.addEventListener('click', closeLinkDialog);
editDialog.addEventListener('click', (e) => {
  if (e.target === editDialog) closeLinkDialog();
});
addLinkBtn.addEventListener('click', openAddLinkDialog);

function deleteLink(id) {
  const idx = links.findIndex(l => l.id === id);
  if (idx < 0) return;
  const [removed] = links.splice(idx, 1);
  saveLinks(); renderLinks();
  showToast('Bookmark removed', { label: 'Undo', fn: () => { links.splice(idx, 0, removed); saveLinks(); renderLinks(); } });
}

// Search
function applySearch(value) {
  linkQuery = value.trim();
  linkSearchClear.hidden = linkSearch.value.length === 0;
  renderLinks();
}
linkSearch.addEventListener('input', (e) => applySearch(e.target.value));
linkSearchClear.addEventListener('click', () => {
  linkSearch.value = '';
  applySearch('');
  linkSearch.focus();
});

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const inField = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;

  if (e.key === 'Escape' && document.activeElement === linkSearch) {
    linkSearch.value = ''; applySearch(''); linkSearch.blur(); return;
  }

  if (inField) return;

  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); todoInput.focus(); }
  else if (k === 'l') { e.preventDefault(); openAddLinkDialog(); }
  else if (k === 'd') { e.preventDefault(); themeToggle.click(); }
  else if (k === '/') { e.preventDefault(); linkSearch.focus(); linkSearch.select(); }
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
  container: linkGrid,
  itemSelector: '.link-tile:not(.link-tile-add)',
  getList: () => links,
  axis: 'x',
  onChange: () => { saveLinks(); renderLinks(); },
});

// --- Init ---
async function init() {
  await store.load();
  document.documentElement.setAttribute('data-theme', store.state.theme);
  updateHeader();
  renderTodos();
  renderLinks();
}
init();

// Keep greeting fresh when the tab regains focus across hour boundaries
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateHeader(); });

// Best-effort flush of any pending debounced save before the tab closes
window.addEventListener('beforeunload', () => {
  if (store._saveTimer) {
    clearTimeout(store._saveTimer);
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
