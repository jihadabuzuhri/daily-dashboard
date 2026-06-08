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
  // Tag datasets — tasks and links each get their own list.
  // Legacy migration: when the new fields are empty but the old
  // `customCategories` has content, fold it into taskCategories. Tags
  // referenced by existing link items also mirror into linkCategories so
  // already-tagged links keep rendering. Empty arrays from DEFAULTS don't
  // count as "having new format" — that's why we check length, not presence.
  const hasNewTags  = (data.taskCategories?.length || 0) + (data.linkCategories?.length || 0) > 0;
  const hasLegacy   = (data.customCategories?.length || 0) > 0;
  if (hasNewTags || !hasLegacy) {
    state.taskCategories.splice(0, state.taskCategories.length, ...(data.taskCategories || []));
    state.linkCategories.splice(0, state.linkCategories.length, ...(data.linkCategories || []));
  } else {
    state.taskCategories.splice(0, state.taskCategories.length, ...data.customCategories);
    const usedByLinks = new Set();
    state.quickLinks.forEach((l) => { if (l.category) usedByLinks.add(l.category); });
    state.savedLinks.forEach((l) => { if (l.category) usedByLinks.add(l.category); });
    // Give each link-side mirror a fresh ID so the two datasets stay fully
    // independent — a future rename on the task side mustn't bleed into the
    // link side via a shared ID.
    const idMap = new Map();
    const mirrored = data.customCategories
      .filter((c) => usedByLinks.has(c.id))
      .map((c, i) => {
        const newId = `c-${Date.now().toString(36)}-${i}-${Math.floor(Math.random() * 100000)}`;
        idMap.set(c.id, newId);
        return { ...c, id: newId };
      });
    state.linkCategories.splice(0, state.linkCategories.length, ...mirrored);
    state.quickLinks.forEach((l) => { if (l.category && idMap.has(l.category)) l.category = idMap.get(l.category); });
    state.savedLinks.forEach((l) => { if (l.category && idMap.has(l.category)) l.category = idMap.get(l.category); });
  }
  state.theme = data.theme === 'light' ? 'light' : 'dark';
  state.groupByCategory = !!data.groupByCategory;
  state.groupLinksByCategory = !!data.groupLinksByCategory;

  // Journal — date-keyed map of work-log entries. Each value is an array of
  // { id, text } objects. Refill in place so module-level references to
  // `state.journal` stay valid.
  //
  // Legacy migration: an earlier shape stored a single string per date. If we
  // load that, wrap it in a single entry so nothing is lost.
  const incomingJournal = (data.journal && typeof data.journal === 'object' && !Array.isArray(data.journal))
    ? data.journal : {};
  Object.keys(state.journal).forEach((k) => { delete state.journal[k]; });
  Object.entries(incomingJournal).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      const safe = v
        .filter((e) => e && typeof e.text === 'string' && e.text)
        .map((e) => {
          const out = { id: e.id ?? (Date.now() + Math.random()), text: e.text };
          // Preserve the task-completion link if present so dedup keeps
          // working after a save/load round-trip.
          if (typeof e.fromTaskId === 'number') out.fromTaskId = e.fromTaskId;
          return out;
        });
      if (safe.length) state.journal[k] = safe;
    } else if (typeof v === 'string' && v.trim()) {
      state.journal[k] = [{ id: Date.now() + Math.random(), text: v.trim() }];
    }
  });

  // Team Lens — fully independent dataset (own teams list, own per-team
  // tasks). In-place refill so module-level references stay valid.
  const incomingLens = (data.teamLens && typeof data.teamLens === 'object' && !Array.isArray(data.teamLens)) ? data.teamLens : {};
  state.teamLens.activeTeamId = typeof incomingLens.activeTeamId === 'string' ? incomingLens.activeTeamId : null;
  state.teamLens.teams.splice(0, state.teamLens.teams.length, ...(Array.isArray(incomingLens.teams) ? incomingLens.teams : []));
  Object.keys(state.teamLens.perTeam).forEach((k) => { delete state.teamLens.perTeam[k]; });
  const incomingPerTeam = (incomingLens.perTeam && typeof incomingLens.perTeam === 'object' && !Array.isArray(incomingLens.perTeam)) ? incomingLens.perTeam : {};
  Object.entries(incomingPerTeam).forEach(([teamId, raw]) => {
    if (!raw || typeof raw !== 'object') return;
    state.teamLens.perTeam[teamId] = {
      status: ['idle', 'green', 'yellow', 'red'].includes(raw.status) ? raw.status : 'idle',
      statusNote: typeof raw.statusNote === 'string' ? raw.statusNote : '',
      waiting: Array.isArray(raw.waiting) ? raw.waiting.filter((w) => w && typeof w.text === 'string') : [],
      links: Array.isArray(raw.links) ? raw.links.filter((l) => l && typeof l.url === 'string') : [],
    };
  });
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
  state: { todos: [], archivedTodos: [], quickLinks: [], savedLinks: [], theme: 'dark', taskCategories: [], linkCategories: [], groupByCategory: false, groupLinksByCategory: false, journal: {}, teamLens: { activeTeamId: null, teams: [], perTeam: {} } },
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
let taskCategories = store.state.taskCategories;
let linkCategories = store.state.linkCategories;
let teams         = store.state.teamLens.teams;
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
const taskTagPill   = $('#task-tag-pill');
const linkTagPill   = $('#edit-tag-pill');

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

const installBtn       = $('#install-btn');
const installDialog    = $('#install-dialog');
const installDialogClose = $('#install-dialog-close');

// --- Date + greeting ---
// The greeting copy ("Good morning", weekday names) is authored in English, so
// pin the date formatter to en-US too — otherwise an Arabic / French / etc.
// browser locale would render a date in that script next to English text.
function updateHeader() {
  const now = new Date();
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  dateEl.textContent = now.toLocaleDateString('en-US', opts);
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
// CATEGORIES — color-coded tags
//   Two independent datasets: one for tasks, one for links. Each side has
//   its own chip row and its own "+" button. IDs are globally unique
//   (timestamp + random), so a single getCategory(id) lookup can resolve
//   either set without ambiguity.
// =====================================================

// Palette offered when creating a tag.
const CATEGORY_PALETTE = [
  '#5a9eff', '#6ec694', '#ec8a76', '#c193e0',
  '#f0c75e', '#65c8c4', '#e87ab5', '#9b9ed4',
];

function getCategories(kind) {
  if (kind === 'link') return linkCategories;
  if (kind === 'team') return teams;
  return taskCategories;
}
function getCategory(id) {
  if (!id) return null;
  return taskCategories.find((c) => c.id === id)
      || linkCategories.find((c) => c.id === id)
      || teams.find((c) => c.id === id)
      || null;
}
function hexToRgba(hex, alpha) {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Active chip per list: filters that list (flat view) + becomes default tag
// for newly-added items. Mirrors selectedCategoryId for tasks and the link
// equivalent for quick/saved links.
let selectedCategoryId = null;        // tasks
let selectedLinkCategoryId = null;    // quick + saved links (shared)
// Grouped-view toggles per list — synced via store. Updated from the loaded
// state in init() and whenever the user toggles via the chip row.
let groupByCategory = false;          // tasks
let groupLinksByCategory = false;     // quick links
// Ephemeral per-session memory of group open/closed state. Most lists default
// to COLLAPSED — the user opens individual sections as needed; `expandedGroups`
// holds the ones they popped open. Quick Links is the exception: it's the
// primary view, so its groups default to OPEN and `collapsedQuickGroups` holds
// the ones the user explicitly collapsed.
// Keys are prefixed by list ("task:" / "archive:" / "link-quick:" /
// "link-saved:") so the same tag in different lists doesn't share state.
const expandedGroups = new Set();
const collapsedQuickGroups = new Set();

const categoryRow     = $('#category-row');
const linkCategoryRow = $('#link-category-row');

function applyCategoryVars(el, catId) {
  const cat = getCategory(catId);
  if (cat) {
    el.style.setProperty('--cat-color', cat.color);
    el.style.setProperty('--cat-soft', cat.soft);
  } else {
    el.style.removeProperty('--cat-color');
    el.style.removeProperty('--cat-soft');
  }
}

function buildCategoryChip(cat, { selected, onClick }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'category-chip' + (selected ? ' is-selected' : '');
  chip.dataset.category = cat.id;
  applyCategoryVars(chip, cat.id);
  chip.setAttribute('aria-pressed', selected ? 'true' : 'false');
  chip.innerHTML = `<span class="chip-dot"></span><span class="chip-label">${escapeHtml(cat.label)}</span>`;
  chip.addEventListener('click', () => onClick(cat.id));
  return chip;
}

function renameCategory(id, kind, nextLabel) {
  const list = getCategories(kind);
  const cat = list.find((c) => c.id === id);
  if (!cat) return;
  const trimmed = (nextLabel || '').trim();
  if (!trimmed || trimmed === cat.label) return;
  cat.label = trimmed;
  store.save();
  renderAllCategoryRows();
  // Labels appear in group headers + popovers, so refresh dependent renders.
  if (kind === 'task') renderTodos();
  else if (kind === 'link') { renderQuickLinks(); renderSavedLinks(); }
}

// Generic chip-row renderer. Two callers (tasks + links) pass their own
// selection/grouping state, the dataset kind, and the click handlers.
function renderCategoryRow(container, opts) {
  if (!container) return;
  container.innerHTML = '';

  // Each chip is wrapped so it can carry tiny ✎ / × buttons for rename and
  // delete (a <button> inside another <button> would be invalid HTML).
  // Both buttons are gated behind ⌘/Ctrl+hover — see the .meta-down CSS.
  getCategories(opts.kind).forEach((cat) => {
    const chip = buildCategoryChip(cat, {
      selected: opts.selectedId === cat.id,
      onClick: opts.onSelectChip,
    });
    const labelSpan = chip.querySelector('.chip-label');
    const wrap = document.createElement('span');
    wrap.className = 'category-chip-wrap';
    // Make the wrap draggable so users can reorder tags in place. The setupDnd
    // helper reads dataset.id to identify items; reordering the backing array
    // also reorders the grouped view (renderGroupedTodos / renderGroupedQuickLinks
    // iterate taskCategories / linkCategories in array order).
    wrap.draggable = true;
    wrap.dataset.id = cat.id;

    // ✎ — rename (top-left)
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'teamlens-chip-rename';
    renameBtn.title = `Rename "${cat.label}"`;
    renameBtn.setAttribute('aria-label', `Rename ${cat.label} tag`);
    renameBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      enterChipRename(labelSpan, cat.label, (next) => renameCategory(cat.id, opts.kind, next));
    });

    // × — delete (top-right)
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'category-chip-delete';
    x.innerHTML = '&times;';
    x.title = `Delete "${cat.label}"`;
    x.setAttribute('aria-label', `Delete ${cat.label} tag`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCategory(cat.id, opts.kind);
    });
    wrap.append(renameBtn, chip, x);
    container.appendChild(wrap);
  });

  // Trailing "+" button — opens the create dialog for this dataset.
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'category-add-btn';
  addBtn.title = 'Add a custom tag';
  addBtn.setAttribute('aria-label', 'Add a custom tag');
  addBtn.innerHTML = '+';
  addBtn.addEventListener('click', () => openCreateCategoryDialog(opts.kind));
  container.appendChild(addBtn);

  // Group-by-tag toggle — sits next to the "+" button
  const groupBtn = document.createElement('button');
  groupBtn.type = 'button';
  groupBtn.className = 'category-group-btn' + (opts.isGrouped ? ' is-active' : '');
  const groupTitle = opts.isGrouped ? 'Switch to flat view' : 'Group by tag';
  groupBtn.title = groupTitle;
  groupBtn.setAttribute('aria-label', groupTitle);
  groupBtn.setAttribute('aria-pressed', opts.isGrouped ? 'true' : 'false');
  groupBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="6" r="1.2" fill="currentColor"/><line x1="9" y1="6" x2="20" y2="6"/><circle cx="4" cy="12" r="1.2" fill="currentColor"/><line x1="9" y1="12" x2="20" y2="12"/><circle cx="4" cy="18" r="1.2" fill="currentColor"/><line x1="9" y1="18" x2="20" y2="18"/></svg>';
  groupBtn.addEventListener('click', opts.onToggleGroup);
  container.appendChild(groupBtn);
}

function renderTaskCategoryRow() {
  renderCategoryRow(categoryRow, {
    kind: 'task',
    selectedId: selectedCategoryId,
    isGrouped: groupByCategory,
    onSelectChip: (id) => {
      // Filter & group are mutually exclusive: clicking a chip while grouped
      // switches back to flat view so the filter semantics actually apply.
      if (groupByCategory) {
        groupByCategory = false;
        store.state.groupByCategory = false;
      }
      selectedCategoryId = selectedCategoryId === id ? null : id;
      pendingTaskCategoryId = selectedCategoryId;
      syncTaskTagPill();
      store.save();
      renderTaskCategoryRow();
      renderTodos();
    },
    onToggleGroup: () => {
      groupByCategory = !groupByCategory;
      if (groupByCategory) selectedCategoryId = null;
      store.state.groupByCategory = groupByCategory;
      store.save();
      renderTaskCategoryRow();
      renderTodos();
    },
  });
}

function renderLinkCategoryRow() {
  renderCategoryRow(linkCategoryRow, {
    kind: 'link',
    selectedId: selectedLinkCategoryId,
    isGrouped: groupLinksByCategory,
    onSelectChip: (id) => {
      if (groupLinksByCategory) {
        groupLinksByCategory = false;
        store.state.groupLinksByCategory = false;
      }
      selectedLinkCategoryId = selectedLinkCategoryId === id ? null : id;
      store.save();
      renderLinkCategoryRow();
      renderQuickLinks();
      renderSavedLinks();
    },
    onToggleGroup: () => {
      groupLinksByCategory = !groupLinksByCategory;
      if (groupLinksByCategory) selectedLinkCategoryId = null;
      store.state.groupLinksByCategory = groupLinksByCategory;
      store.save();
      renderLinkCategoryRow();
      renderQuickLinks();
      renderSavedLinks();
    },
  });
}

// Re-render both chip rows. Called when the shared tag list changes
// (create / delete) so both sides stay in sync.
function renderAllCategoryRows() {
  renderTaskCategoryRow();
  renderLinkCategoryRow();
  // Team Lens uses task categories as its team list — keep its chip row
  // and body header in sync. Guarded so it's safe to call before init.
  if (typeof renderTeamLens === 'function' && teamLensChipRow) renderTeamLens();
}

// Build a colored-dot pill for any item that has an optional .category field.
// The caller supplies the dataset `kind` (so the popover offers the right
// tag set) and `onChange(newCategoryId | null)` which actually mutates the
// item — keeps this helper agnostic to tasks vs. links.
function buildCategoryPill(currentCategoryId, kind, onChange) {
  const cat = getCategory(currentCategoryId);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'category-pill' + (cat ? ' is-set' : '');
  if (cat) {
    applyCategoryVars(btn, cat.id);
    btn.title = `${cat.label} (click to change)`;
    btn.setAttribute('aria-label', `Tag: ${cat.label}. Click to change.`);
  } else {
    btn.title = 'Add a tag';
    btn.setAttribute('aria-label', 'Add a tag');
  }
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCategoryPopover(btn, currentCategoryId, kind, onChange);
  });
  return btn;
}

// --- Create-tag dialog ---
const categoryDialog       = $('#category-dialog');
const categoryForm         = $('#category-form');
const categoryName         = $('#category-name');
const colorSwatches        = $('#color-swatches');
const categoryCancel       = $('#category-cancel');
const categoryDialogClose  = $('#category-dialog-close');
const categoryDialogTitle  = $('#category-dialog-title');
const pickerPanel          = $('#color-picker-panel');
const pickerSv             = $('#picker-sv');
const pickerSvThumb        = $('#picker-sv-thumb');
const pickerHue            = $('#picker-hue');
const pickerHueThumb       = $('#picker-hue-thumb');
const pickerPreview        = $('#picker-preview');
const pickerHex            = $('#picker-hex');
let pickedColor = CATEGORY_PALETTE[0];
let pickerOpen  = false;
// Picker keeps its own HSV state so hue is preserved across grayscale dips
// (when value or saturation hits 0, hue would otherwise reset to red).
const pickerHsv = { h: 215, s: 65, v: 100 };

// --- Color conversions ---
function _hexToRgb(hex) {
  const v = hex.replace('#', '');
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}
function _rgbToHex(r, g, b) {
  const to = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
function _rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return { h, s: s * 100, v: v * 100 };
}
function _hsvToRgb(h, s, v) {
  s /= 100; v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function hexToHsv(hex) { const { r, g, b } = _hexToRgb(hex); return _rgbToHsv(r, g, b); }
function hsvToHex(h, s, v) { const { r, g, b } = _hsvToRgb(h, s, v); return _rgbToHex(r, g, b); }
// Which dataset the dialog is currently creating into.
let creatingCategoryKind = 'task';

function renderColorSwatches() {
  colorSwatches.innerHTML = '';
  CATEGORY_PALETTE.forEach((color) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch' + (color === pickedColor ? ' is-selected' : '');
    sw.style.background = color;
    sw.setAttribute('role', 'radio');
    sw.setAttribute('aria-checked', color === pickedColor ? 'true' : 'false');
    sw.setAttribute('aria-label', `Color ${color}`);
    sw.addEventListener('click', () => {
      pickedColor = color;
      syncPickerFromHex(pickedColor);
      setPickerOpen(false);
      renderColorSwatches();
    });
    colorSwatches.appendChild(sw);
  });

  // Custom-color swatch: toggles the in-dialog color picker panel.
  // Shows a rainbow gradient when no custom color is in use, or the picked
  // color itself once the user has chosen one outside the preset palette.
  const isCustom = !CATEGORY_PALETTE.includes(pickedColor);
  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'color-swatch color-swatch-custom'
    + (isCustom ? ' is-selected' : '')
    + (pickerOpen ? ' is-open' : '');
  if (isCustom) custom.style.background = pickedColor;
  custom.setAttribute('role', 'radio');
  custom.setAttribute('aria-checked', isCustom ? 'true' : 'false');
  custom.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false');
  custom.setAttribute('aria-label', 'Pick a custom color');
  custom.title = pickerOpen ? 'Close color picker' : 'Pick a custom color';
  custom.addEventListener('click', () => {
    setPickerOpen(!pickerOpen);
    renderColorSwatches();
  });
  colorSwatches.appendChild(custom);
}

function setPickerOpen(open) {
  pickerOpen = open;
  pickerPanel.hidden = !open;
  pickerPanel.classList.toggle('is-open', open);
  if (open) {
    syncPickerFromHex(pickedColor);
    updatePickerVisuals();
  }
}

// Copy HSV from hex, but preserve the existing hue when the hex is grayscale
// (s === 0) — otherwise the hue thumb would snap to red when the user dips
// into a black or gray.
function syncPickerFromHex(hex) {
  const { h, s, v } = hexToHsv(hex);
  pickerHsv.s = s;
  pickerHsv.v = v;
  if (s > 0) pickerHsv.h = h;
}

function updatePickerVisuals() {
  if (!pickerPanel) return;
  const { h, s, v } = pickerHsv;
  pickerSv.style.setProperty('--picker-hue', `${h}deg`);
  pickerSvThumb.style.left = `${s}%`;
  pickerSvThumb.style.top  = `${100 - v}%`;
  pickerSvThumb.style.background = pickedColor;
  pickerHueThumb.style.left = `${(h / 360) * 100}%`;
  pickerHueThumb.style.background = `hsl(${h}, 100%, 50%)`;
  pickerPreview.style.background = pickedColor;
  pickerPreview.style.boxShadow = `0 0 0 4px ${hexToRgba(pickedColor, 0.22)}`;
  if (document.activeElement !== pickerHex) {
    pickerHex.value = pickedColor.toUpperCase();
  }
}

// --- Picker pointer wiring ---
function setHsv(partial) {
  Object.assign(pickerHsv, partial);
  pickedColor = hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v);
  updatePickerVisuals();
  // Re-render swatches so the custom rainbow swatch reflects the live color.
  renderColorSwatches();
}

function svFromPointer(e) {
  const rect = pickerSv.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width,  e.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  setHsv({ s: (x / rect.width) * 100, v: (1 - y / rect.height) * 100 });
}
function hueFromPointer(e) {
  const rect = pickerHue.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  setHsv({ h: (x / rect.width) * 360 });
}

function bindDrag(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    onMove(e);
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      try { el.releasePointerCapture(ev.pointerId); } catch {}
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
bindDrag(pickerSv, svFromPointer);
bindDrag(pickerHue, hueFromPointer);

// Arrow-key nudges for accessibility — works when the slider is focused.
pickerSv.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 2;
  let { s, v } = pickerHsv;
  if (e.key === 'ArrowLeft')  s = Math.max(0,   s - step);
  else if (e.key === 'ArrowRight') s = Math.min(100, s + step);
  else if (e.key === 'ArrowUp')    v = Math.min(100, v + step);
  else if (e.key === 'ArrowDown')  v = Math.max(0,   v - step);
  else return;
  e.preventDefault();
  setHsv({ s, v });
});
pickerHue.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 30 : 6;
  let { h } = pickerHsv;
  if (e.key === 'ArrowLeft')  h = (h - step + 360) % 360;
  else if (e.key === 'ArrowRight') h = (h + step) % 360;
  else return;
  e.preventDefault();
  setHsv({ h });
});

// Hex input — only applies when the typed value is a valid 6-digit hex.
pickerHex.addEventListener('input', (e) => {
  let v = e.target.value.trim();
  if (v.startsWith('#')) v = v.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return;
  pickedColor = `#${v.toLowerCase()}`;
  syncPickerFromHex(pickedColor);
  updatePickerVisuals();
  renderColorSwatches();
});
pickerHex.addEventListener('blur', () => {
  // Snap back to the canonical color string if the user left an invalid
  // partial value in the input.
  pickerHex.value = pickedColor.toUpperCase();
});

function openCreateCategoryDialog(kind = 'task') {
  creatingCategoryKind = kind === 'link' ? 'link' : (kind === 'team' ? 'team' : 'task');
  pickedColor = CATEGORY_PALETTE[0];
  categoryName.value = '';
  if (categoryDialogTitle) {
    categoryDialogTitle.textContent =
      creatingCategoryKind === 'link' ? 'New link tag' :
      creatingCategoryKind === 'team' ? 'New team' :
      'New task tag';
  }
  setPickerOpen(false);
  syncPickerFromHex(pickedColor);
  renderColorSwatches();
  if (typeof categoryDialog.showModal === 'function') categoryDialog.showModal();
  else categoryDialog.setAttribute('open', '');
  requestAnimationFrame(() => categoryName.focus());
}
function closeCreateCategoryDialog() {
  if (categoryDialog.open) categoryDialog.close();
  setPickerOpen(false);
}

categoryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const label = categoryName.value.trim();
  if (!label) return;
  const id = `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  getCategories(creatingCategoryKind).push({
    id, label,
    color: pickedColor,
    soft: hexToRgba(pickedColor, 0.16),
  });
  store.save();
  // Only the affected row needs to repaint, but both is cheap and keeps the
  // two sides obviously in sync after the dialog closes.
  renderAllCategoryRows();
  closeCreateCategoryDialog();
});
categoryCancel.addEventListener('click', closeCreateCategoryDialog);
categoryDialogClose.addEventListener('click', closeCreateCategoryDialog);
categoryDialog.addEventListener('click', (e) => {
  if (e.target === categoryDialog) closeCreateCategoryDialog();
});

function deleteCategory(id, kind) {
  const list = getCategories(kind);
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const cat = list[idx];

  // Capture for undo. Each dataset only touches its own item lists since
  // task tags and link tags are independent.
  const isTask = kind === 'task';
  const affectedA = isTask ? todos.filter((t) => t.category === id) : quickLinks.filter((l) => l.category === id);
  const affectedB = isTask ? archivedTodos.filter((t) => t.category === id) : savedLinks.filter((l) => l.category === id);
  const wasFiltering = isTask
    ? selectedCategoryId === id
    : selectedLinkCategoryId === id;

  list.splice(idx, 1);
  [...affectedA, ...affectedB].forEach((item) => { delete item.category; });
  if (wasFiltering) {
    if (isTask) selectedCategoryId = null;
    else selectedLinkCategoryId = null;
  }
  if (isTask && pendingTaskCategoryId === id) {
    pendingTaskCategoryId = null;
    syncTaskTagPill();
  } else if (!isTask && pendingLinkCategoryId === id) {
    pendingLinkCategoryId = null;
    syncLinkTagPill();
  }

  store.save();
  renderAllCategoryRows();
  if (isTask) renderTodos();
  else { renderQuickLinks(); renderSavedLinks(); }

  showToast(`Tag "${cat.label}" deleted`, { label: 'Undo', fn: () => {
    list.splice(idx, 0, cat);
    [...affectedA, ...affectedB].forEach((item) => { item.category = id; });
    if (wasFiltering) {
      if (isTask) selectedCategoryId = id;
      else selectedLinkCategoryId = id;
    }
    store.save();
    renderAllCategoryRows();
    if (isTask) renderTodos();
    else { renderQuickLinks(); renderSavedLinks(); }
  }});
}

// --- Tag-picker popover (used to change a tag on an existing task) ---
let activePopover = null;

function closeCategoryPopover() {
  if (!activePopover) return;
  activePopover.remove();
  activePopover = null;
  document.removeEventListener('mousedown', popoverOutsideMousedown, true);
  document.removeEventListener('keydown', popoverEscape, true);
  window.removeEventListener('resize', closeCategoryPopover);
  window.removeEventListener('scroll', closeCategoryPopover, true);
}
function popoverOutsideMousedown(e) {
  if (activePopover && !activePopover.contains(e.target)) closeCategoryPopover();
}
function popoverEscape(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeCategoryPopover(); }
}

function openCategoryPopover(triggerEl, currentCatId, kind, onChange) {
  closeCategoryPopover();

  const pop = document.createElement('div');
  pop.className = 'category-popover';
  pop.setAttribute('role', 'menu');

  const cats = getCategories(kind);
  cats.forEach((cat) => {
    pop.appendChild(buildCategoryChip(cat, {
      selected: currentCatId === cat.id,
      onClick: (id) => {
        const next = currentCatId === id ? null : id;
        onChange(next);
        closeCategoryPopover();
      },
    }));
  });

  if (currentCatId) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'category-chip category-clear';
    clearBtn.innerHTML = '<span>Clear</span>';
    clearBtn.addEventListener('click', () => {
      onChange(null);
      closeCategoryPopover();
    });
    pop.appendChild(clearBtn);
  }

  // No tags defined for this dataset yet — offer to create one so the
  // popover isn't a dead end.
  if (cats.length === 0) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'category-chip';
    create.innerHTML = '<span>+ New tag</span>';
    create.addEventListener('click', () => {
      closeCategoryPopover();
      openCreateCategoryDialog(kind);
    });
    pop.appendChild(create);
  }

  // Mount, measure, then position. Use fixed coords anchored to the trigger.
  // When the trigger lives inside a <dialog> that's open via showModal(), the
  // dialog is in the top layer — appending to <body> would render the popover
  // *below* the modal. Mount inside the dialog in that case so we share the
  // top-layer stacking context.
  pop.style.position = 'fixed';
  pop.style.visibility = 'hidden';
  pop.style.top = '0';
  pop.style.left = '0';
  const modalAncestor = triggerEl.closest('dialog[open]');
  (modalAncestor || document.body).appendChild(pop);
  activePopover = pop;

  const rect = triggerEl.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let top = rect.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 6);
  let left = rect.right - pw;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (left < 8) left = 8;
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  pop.style.visibility = '';

  // Defer the global listeners by one tick so the click that opened us
  // doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', popoverOutsideMousedown, true);
    document.addEventListener('keydown', popoverEscape, true);
    window.addEventListener('resize', closeCategoryPopover);
    window.addEventListener('scroll', closeCategoryPopover, true);
  }, 0);
}

// --- Form tag pills ---
// Pending tag for the next task / next link submission. Default-synced from
// the active filter chip so newly-added items stay visible under that filter;
// the user can override per-submission by clicking the pill.
let pendingTaskCategoryId = null;
let pendingLinkCategoryId = null;

// Compact dot pill, used inline in the task input. Dashed circle when empty,
// solid colored dot with a soft halo when set — same visual language as the
// per-task category pill on existing items.
function syncTaskTagPill() {
  const cat = getCategory(pendingTaskCategoryId);
  applyCategoryVars(taskTagPill, pendingTaskCategoryId);
  taskTagPill.classList.toggle('is-set', !!cat);
  taskTagPill.title = cat ? `Tag: ${cat.label} — click to change` : 'Add a tag';
  taskTagPill.setAttribute('aria-label', cat ? `Tag: ${cat.label}` : 'Add a tag for new task');
}
// Labeled chip, used inside the link dialog where there's space + a field label.
function syncLinkTagPill() {
  const cat = getCategory(pendingLinkCategoryId);
  applyCategoryVars(linkTagPill, pendingLinkCategoryId);
  linkTagPill.innerHTML = '';
  if (cat) {
    linkTagPill.classList.add('is-set');
    linkTagPill.title = `Tag: ${cat.label} — click to change`;
    linkTagPill.innerHTML = `<span class="form-tag-dot"></span><span class="form-tag-label">${escapeHtml(cat.label)}</span>`;
  } else {
    linkTagPill.classList.remove('is-set');
    linkTagPill.title = 'Add a tag';
    linkTagPill.innerHTML = '<span class="form-tag-label">+ Tag</span>';
  }
}

taskTagPill.addEventListener('click', (e) => {
  e.preventDefault();
  openCategoryPopover(taskTagPill, pendingTaskCategoryId, 'task', (next) => {
    pendingTaskCategoryId = next;
    syncTaskTagPill();
  });
});
linkTagPill.addEventListener('click', (e) => {
  e.preventDefault();
  openCategoryPopover(linkTagPill, pendingLinkCategoryId, 'link', (next) => {
    pendingLinkCategoryId = next;
    syncLinkTagPill();
  });
});

function getTodoCategory(id, archived) {
  const arr = archived ? archivedTodos : todos;
  return arr.find((x) => x.id === id)?.category || null;
}
function setTodoCategory(id, category, archived) {
  const arr = archived ? archivedTodos : todos;
  const t = arr.find((x) => x.id === id);
  if (!t) return;
  if (category) t.category = category;
  else delete t.category;
  saveTodos();
  renderTodos();
}

// =====================================================
// FOCUS / POMODORO (POC — in-memory only, not persisted)
// =====================================================
// Single-session model: at most one task is being focused on at any time.
// State carries the source task id, the timestamp it ends at, the total
// duration, and the live progress (0..1) used for the ring + bar.
let focusSession      = null;   // { taskId, endsAt, durationMs, progress }
let focusTicker       = null;   // setInterval handle
let pendingFocusTaskId = null;  // task selected for focus while the picker is open
let pickedDurationMin  = 25;    // currently-selected duration in the picker

const FOCUS_DURATION_MS = 25 * 60 * 1000;
const FOCUS_PRESETS_MIN = [15, 25, 50];
const FOCUS_MIN_MIN = 1;
const FOCUS_MAX_MIN = 180;

const focusPill       = $('#focus-pill');
const focusPillTask   = $('#focus-pill-task');
const focusPillTime   = $('#focus-pill-time');
const focusPillStop   = $('#focus-pill-stop');
const focusPillProg   = focusPill?.querySelector('.focus-pill-progress');

const focusDialog        = $('#focus-dialog');
const focusDialogTask    = $('#focus-dialog-task');
const focusDialogEyebrow = $('#focus-dialog-eyebrow');
const focusDialogTime    = $('#focus-dialog-time');
const focusDialogSub     = $('#focus-dialog-sub');
const focusDialogFill    = focusDialog?.querySelector('.focus-ring-fill');
const focusDialogClose   = $('#focus-dialog-close');
const focusDialogMin     = $('#focus-dialog-minimize');
const focusDialogStop    = $('#focus-dialog-stop');
const focusDialogStart   = $('#focus-dialog-start');
const focusPicker        = $('#focus-picker');
const focusPickerCustom  = $('#focus-picker-custom');

focusPillStop?.addEventListener('click', () => stopFocus('cancelled'));
focusPill?.addEventListener('click', (e) => {
  if (e.target.closest('.focus-pill-stop')) return; // stop has its own handler
  openFocusDialog();
});
focusDialogClose?.addEventListener('click', closeFocusDialog);
focusDialogMin?.addEventListener('click', closeFocusDialog);
focusDialogStop?.addEventListener('click', () => { closeFocusDialog(); stopFocus('cancelled'); });
// Click outside the inner card dismisses (minimize / cancel picker)
focusDialog?.addEventListener('click', (e) => { if (e.target === focusDialog) closeFocusDialog(); });

// Picker chip clicks → set picked duration and clear the custom field.
focusPicker?.querySelectorAll('.focus-picker-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    pickedDurationMin = Number(chip.dataset.min);
    if (focusPickerCustom) focusPickerCustom.value = '';
    syncFocusPickerUI();
  });
});
// Typing in the custom field overrides the preset selection (when valid).
focusPickerCustom?.addEventListener('input', () => {
  const n = Number(focusPickerCustom.value);
  if (Number.isFinite(n) && n >= FOCUS_MIN_MIN && n <= FOCUS_MAX_MIN) {
    pickedDurationMin = n;
    syncFocusPickerUI();
  }
});
focusPickerCustom?.addEventListener('blur', () => {
  // Clamp on blur — empty string just means "use preset"; out-of-range snaps in.
  const raw = focusPickerCustom.value.trim();
  if (raw === '') { syncFocusPickerUI(); return; }
  const n = Math.min(FOCUS_MAX_MIN, Math.max(FOCUS_MIN_MIN, Math.round(Number(raw) || pickedDurationMin)));
  focusPickerCustom.value = n;
  pickedDurationMin = n;
  syncFocusPickerUI();
});
focusDialogStart?.addEventListener('click', () => {
  if (pendingFocusTaskId == null) return;
  const id = pendingFocusTaskId;
  pendingFocusTaskId = null;
  startFocus(id, pickedDurationMin);
});

function syncFocusPickerUI() {
  // Highlight whichever preset matches the current pickedDurationMin (if any).
  // When the custom input holds a value matching no preset, none are selected.
  if (!focusPicker) return;
  const customRaw = focusPickerCustom?.value.trim();
  const usingCustom = customRaw !== '' && Number(customRaw) === pickedDurationMin && !FOCUS_PRESETS_MIN.includes(pickedDurationMin);
  focusPicker.querySelectorAll('.focus-picker-chip').forEach((chip) => {
    const isSel = !usingCustom && Number(chip.dataset.min) === pickedDurationMin;
    chip.classList.toggle('is-selected', isSel);
    chip.setAttribute('aria-checked', isSel ? 'true' : 'false');
  });
  // The custom-pill border lights up when the active value lives in it.
  const customWrap = focusPicker.querySelector('.focus-picker-custom');
  customWrap?.classList.toggle('is-selected', usingCustom);
}

// Opens the dialog with the duration picker (no timer started). Called from
// the play button on a task.
function openFocusPicker(taskId) {
  if (!focusDialog) return;
  pendingFocusTaskId = taskId;
  pickedDurationMin = 25;
  if (focusPickerCustom) focusPickerCustom.value = '';
  focusDialog.classList.remove('is-running');
  if (focusDialogEyebrow) focusDialogEyebrow.textContent = 'READY TO FOCUS';
  if (focusDialogTask) focusDialogTask.textContent = findTodoText(taskId) || 'Task';
  syncFocusPickerUI();
  if (!focusDialog.open) {
    if (typeof focusDialog.showModal === 'function') focusDialog.showModal();
    else focusDialog.setAttribute('open', '');
  }
  // Defer focus so the dialog has time to animate in.
  requestAnimationFrame(() => focusDialogStart?.focus());
}

// Opens the dialog in running state — used when minimizing then re-expanding.
function openFocusDialog() {
  if (!focusSession || !focusDialog) return;
  focusDialog.classList.add('is-running');
  if (focusDialogEyebrow) focusDialogEyebrow.textContent = 'FOCUSING ON';
  if (!focusDialog.open) {
    if (typeof focusDialog.showModal === 'function') focusDialog.showModal();
    else focusDialog.setAttribute('open', '');
  }
  tickFocus(); // paint immediately
}
function closeFocusDialog() {
  pendingFocusTaskId = null;
  if (focusDialog?.open) focusDialog.close();
}

function startFocus(taskId, durationMin = 25) {
  const safeMin = Math.min(FOCUS_MAX_MIN, Math.max(FOCUS_MIN_MIN, Math.round(Number(durationMin) || 25)));
  const durationMs = safeMin * 60 * 1000;
  // Switching mid-session: silently replace; no toast spam.
  const now = Date.now();
  focusSession = {
    taskId,
    endsAt: now + durationMs,
    durationMs,
    progress: 0,
  };
  if (focusTicker) clearInterval(focusTicker);
  focusTicker = setInterval(tickFocus, 1000);
  tickFocus();           // immediate paint so the UI doesn't lag a beat
  renderTodos();         // re-render so play→stop swap + progress fill appear
  openFocusDialog();     // switch the dialog from picker → running view
}

function stopFocus(reason) {
  if (!focusSession) return;
  if (focusTicker) { clearInterval(focusTicker); focusTicker = null; }
  const taskText = findTodoText(focusSession.taskId);
  focusSession = null;
  focusPill.hidden = true;
  closeFocusDialog();
  if (reason === 'done') {
    playFocusChime();
    showToast(`Focus done — ${taskText || 'task'}`, {
      label: 'Restart',
      fn: () => { const id = findTodoIdByText(taskText); if (id) startFocus(id); },
    });
  }
  renderTodos();
}

function tickFocus() {
  if (!focusSession) return;
  const remainingMs = focusSession.endsAt - Date.now();
  if (remainingMs <= 0) { stopFocus('done'); return; }
  focusSession.progress = 1 - (remainingMs / focusSession.durationMs);
  const taskText = findTodoText(focusSession.taskId) || 'Task';
  const mmss = formatMmSs(remainingMs);
  const remainingMin = Math.ceil(remainingMs / 60000);
  const pct = focusSession.progress * 100;

  // Header pill (compact view)
  focusPill.hidden = false;
  focusPillTask.textContent = taskText;
  focusPillTime.textContent = mmss;
  if (focusPillProg) focusPillProg.style.strokeDasharray = `${pct} 100`;

  // Expanded dialog (only paints if it's open / built)
  if (focusDialogTask) {
    focusDialogTask.textContent = taskText;
    focusDialogTime.textContent = mmss;
    focusDialogSub.textContent  = `${remainingMin} minute${remainingMin === 1 ? '' : 's'} left`;
    if (focusDialogFill) focusDialogFill.style.strokeDasharray = `${pct} 100`;
  }

  // Live progress fill under the active task — cheap inline style write.
  const li = document.querySelector(`.todo-item.is-focusing[data-id="${focusSession.taskId}"]`);
  if (li) {
    const fill = li.querySelector('.todo-focus-fill');
    if (fill) fill.style.setProperty('--focus-progress', `${pct}%`);
  }
}

function formatMmSs(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function findTodoText(id) { return todos.find((t) => t.id === id)?.text || ''; }
function findTodoIdByText(text) { return todos.find((t) => t.text === text)?.id; }

// Two-note completion chime via Web Audio. Lazy-instantiated so the AudioContext
// only spins up after a user gesture (browsers block autoplay otherwise).
let _audioCtx = null;
function playFocusChime() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    [880, 660].forEach((freq, i) => {
      const t = now + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch { /* audio is non-essential; silent failure is fine */ }
}

// =====================================================
// TODAY'S WORK — daily work-log list
// =====================================================
// State: store.state.journal is a map of ISO local date ("YYYY-MM-DD") →
// array of { id, text }. currentJournalDate tracks which entry the user is
// currently viewing. Add via Enter in the input; edit by clicking the row's
// text; remove via the × on hover. Same UI patterns as the Tasks panel for
// muscle-memory consistency.

const journalInput     = $('#journal-input');
const journalForm      = $('#journal-form');
const journalList      = $('#journal-list');
const journalEmpty     = $('#journal-empty');
const journalPrev      = $('#journal-prev');
const journalNext      = $('#journal-next');
const journalDateBtn   = $('#journal-date');

let currentJournalDate = isoLocalDate(new Date());

// ISO date in the user's local timezone — toISOString would give UTC, which
// would shift midnight for anyone west of GMT and corrupt the per-date map.
function isoLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function dateFromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function shiftIsoDate(iso, days) {
  const d = dateFromIso(iso);
  d.setDate(d.getDate() + days);
  return isoLocalDate(d);
}
function formatJournalDate(iso) {
  const d = dateFromIso(iso);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function getJournalEntries(iso) {
  const raw = store.state.journal[iso];
  return Array.isArray(raw) ? raw : [];
}
function commitJournalEntries(iso, entries) {
  if (entries.length) store.state.journal[iso] = entries;
  else                delete store.state.journal[iso];
  store.save();
}

function addJournalEntry(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const arr = getJournalEntries(currentJournalDate).slice();
  arr.push({ id: Date.now() + Math.random(), text: trimmed });
  commitJournalEntries(currentJournalDate, arr);
  renderJournalList();
}

// Auto-log a freshly-completed task into today's journal. The link to the
// source task is just a deduping key — editing/deleting the entry doesn't
// touch the task, and un-checking the task doesn't remove the entry.
function appendTaskCompletionToJournal(todo) {
  const today = isoLocalDate(new Date());
  const existing = getJournalEntries(today);
  if (existing.some((e) => e.fromTaskId === todo.id)) return; // already logged
  const arr = existing.slice();
  arr.push({
    id: Date.now() + Math.random(),
    text: todo.text,
    fromTaskId: todo.id,
  });
  commitJournalEntries(today, arr);
  // Re-render the panel if the user happens to be looking at today; if they're
  // viewing a past date, the new entry waits silently in today's bucket.
  if (currentJournalDate === today) renderJournalList();
}
function editJournalEntry(id, text) {
  const arr = getJournalEntries(currentJournalDate).slice();
  const e = arr.find((x) => x.id === id);
  if (!e) return;
  const trimmed = text.trim();
  if (!trimmed) { deleteJournalEntry(id); return; }
  e.text = trimmed;
  commitJournalEntries(currentJournalDate, arr);
}
function deleteJournalEntry(id) {
  const arr = getJournalEntries(currentJournalDate);
  const idx = arr.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [removed] = arr.splice(idx, 1);
  commitJournalEntries(currentJournalDate, arr);
  renderJournalList();
  showToast('Entry removed', { label: 'Undo', fn: () => {
    const cur = getJournalEntries(currentJournalDate).slice();
    cur.splice(idx, 0, removed);
    commitJournalEntries(currentJournalDate, cur);
    renderJournalList();
  }});
}

function renderJournalList() {
  journalList.innerHTML = '';
  const entries = getJournalEntries(currentJournalDate);
  journalEmpty.classList.toggle('hidden', entries.length > 0);
  entries.forEach((entry) => journalList.appendChild(buildJournalEntry(entry)));
}

function buildJournalEntry(entry) {
  const li = document.createElement('li');
  li.className = 'journal-entry';
  li.dataset.id = entry.id;
  li.draggable = true;

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.setAttribute('aria-hidden', 'true');
  handle.innerHTML = ICONS.grip;

  // Bullet vs. check — entries auto-logged from a completed task get a small
  // ✓ icon to visually distinguish them from manually-typed entries.
  const dot = document.createElement('span');
  if (entry.fromTaskId != null) {
    dot.className = 'journal-check';
    dot.title = 'Logged from a completed task';
    dot.setAttribute('aria-label', 'From a completed task');
    dot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  } else {
    dot.className = 'journal-bullet';
    dot.setAttribute('aria-hidden', 'true');
  }

  const text = document.createElement('span');
  text.className = 'journal-text';
  text.textContent = entry.text;
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.addEventListener('blur', () => editJournalEntry(entry.id, text.textContent));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
    if (e.key === 'Escape') { text.textContent = entry.text; text.blur(); }
  });

  const actions = document.createElement('div');
  actions.className = 'todo-actions';
  actions.appendChild(makeBtn('trash', 'Delete', () => deleteJournalEntry(entry.id), 'danger'));

  li.append(handle, dot, text, actions);
  return li;
}

function renderJournalHeader() {
  const today = isoLocalDate(new Date());
  const isToday = currentJournalDate === today;
  const isYesterday = currentJournalDate === shiftIsoDate(today, -1);

  let label;
  if (isToday)          label = 'Today';
  else if (isYesterday) label = 'Yesterday';
  else                  label = formatJournalDate(currentJournalDate);

  journalDateBtn.textContent = label;
  journalDateBtn.classList.toggle('is-today', isToday);
  journalDateBtn.title = `Pick a date — currently ${formatJournalDate(currentJournalDate)}`;

  // Future entries don't make sense for a work log — disable Next when we're
  // already on today. The input placeholder also adapts so it doesn't always
  // imply "today".
  journalNext.disabled = isToday;
  journalInput.placeholder = isToday
    ? 'What did you accomplish?'
    : `What was done on ${formatJournalDate(currentJournalDate)}?`;

}

function renderJournal() {
  renderJournalHeader();
  renderJournalList();
}

journalForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = journalInput.value;
  if (!text.trim()) return;
  addJournalEntry(text);
  journalInput.value = '';
  journalInput.focus();
});
journalPrev?.addEventListener('click', () => {
  currentJournalDate = shiftIsoDate(currentJournalDate, -1);
  renderJournal();
});
journalNext?.addEventListener('click', () => {
  if (journalNext.disabled) return;
  currentJournalDate = shiftIsoDate(currentJournalDate, 1);
  renderJournal();
});
journalDateBtn?.addEventListener('click', () => {
  if (activeCalendar) closeCalendar();
  else openCalendar();
});

// --- Custom calendar popover ---
// Renders a 7-column month grid anchored under the date button. Today is
// accent-tinted, the selected date is filled with the accent, future dates are
// disabled, and dates that already have entries show a small dot beneath them
// so users can find old days at a glance.

let activeCalendar = null;
let calendarViewYear  = 0;
let calendarViewMonth = 0;

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function openCalendar() {
  closeCalendar();
  const cur = dateFromIso(currentJournalDate);
  calendarViewYear  = cur.getFullYear();
  calendarViewMonth = cur.getMonth();

  const pop = document.createElement('div');
  pop.className = 'calendar-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Pick a date');

  // Header — month title + prev/next month buttons
  const head = document.createElement('div');
  head.className = 'calendar-head';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'calendar-nav-btn';
  prev.setAttribute('aria-label', 'Previous month');
  prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 6 9 12 15 18"/></svg>';
  prev.addEventListener('click', () => shiftCalendarMonth(-1));
  const title = document.createElement('div');
  title.className = 'calendar-title';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'calendar-nav-btn';
  next.setAttribute('aria-label', 'Next month');
  next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
  next.addEventListener('click', () => shiftCalendarMonth(1));
  head.append(prev, title, next);

  // Weekday strip — fixed 7 columns
  const weekdays = document.createElement('div');
  weekdays.className = 'calendar-weekdays';
  WEEKDAY_LABELS.forEach((d) => {
    const span = document.createElement('span');
    span.textContent = d;
    weekdays.appendChild(span);
  });

  // Day grid — rebuilt by renderCalendarBody on month change
  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  // Footer — quick "today" shortcut
  const foot = document.createElement('div');
  foot.className = 'calendar-foot';
  const todayBtn = document.createElement('button');
  todayBtn.type = 'button';
  todayBtn.className = 'calendar-today-btn';
  todayBtn.textContent = 'Jump to today';
  todayBtn.addEventListener('click', () => {
    currentJournalDate = isoLocalDate(new Date());
    closeCalendar();
    renderJournal();
  });
  foot.appendChild(todayBtn);

  pop.append(head, weekdays, grid, foot);

  // Mount hidden so we can render the body and measure the true final
  // height before placing the popover.
  pop.style.position = 'fixed';
  pop.style.visibility = 'hidden';
  document.body.appendChild(pop);
  activeCalendar = pop;

  // Populate the day grid FIRST so offsetHeight reflects the full popover —
  // otherwise the position fallback uses a tiny "empty grid" height and the
  // popover can end up clipped below the viewport.
  renderCalendarBody();

  // Generous viewport margin so the popover never hugs the screen edges,
  // especially the bottom where it would otherwise sit right against the
  // browser chrome / scrollbar.
  const VIEWPORT_MARGIN = 24;
  const rect = journalDateBtn.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let top = rect.bottom + 8;
  if (top + ph > window.innerHeight - VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, rect.top - ph - 8);
  }
  let left = rect.left + rect.width / 2 - pw / 2;
  if (left + pw > window.innerWidth - VIEWPORT_MARGIN) left = window.innerWidth - pw - VIEWPORT_MARGIN;
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
  pop.style.top  = `${top}px`;
  pop.style.left = `${left}px`;
  pop.style.visibility = '';

  setTimeout(() => {
    document.addEventListener('mousedown', calendarOutsideMousedown, true);
    document.addEventListener('keydown', calendarEscape, true);
    window.addEventListener('resize', closeCalendar);
    window.addEventListener('scroll', closeCalendar, true);
  }, 0);
}

function shiftCalendarMonth(delta) {
  calendarViewMonth += delta;
  while (calendarViewMonth < 0)  { calendarViewMonth += 12; calendarViewYear--; }
  while (calendarViewMonth > 11) { calendarViewMonth -= 12; calendarViewYear++; }
  renderCalendarBody();
}

function renderCalendarBody() {
  if (!activeCalendar) return;
  const title = activeCalendar.querySelector('.calendar-title');
  const grid  = activeCalendar.querySelector('.calendar-grid');
  const nextBtn = activeCalendar.querySelectorAll('.calendar-nav-btn')[1];

  const monthName = new Date(calendarViewYear, calendarViewMonth, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  title.textContent = monthName;

  const todayIso = isoLocalDate(new Date());
  const todayDate = dateFromIso(todayIso);
  // Disable the next-month arrow when it would point past today's month.
  nextBtn.disabled =
    calendarViewYear  > todayDate.getFullYear() ||
    (calendarViewYear === todayDate.getFullYear() && calendarViewMonth >= todayDate.getMonth());

  grid.innerHTML = '';
  const firstDay = new Date(calendarViewYear, calendarViewMonth, 1);
  const startDayOfWeek = firstDay.getDay();
  const daysInMonth = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();

  // Always render exactly 6 weeks (42 cells). Most months only need 5 weeks
  // but a 31-day month that starts on Friday/Saturday spills to 6. Padding
  // with empty cells keeps the popover height constant, so its original
  // anchored position stays valid as the user navigates months.
  const TOTAL_CELLS = 42;
  const trailingEmpty = TOTAL_CELLS - startDayOfWeek - daysInMonth;

  // Pad the start with empty cells so the first day lands in the right column.
  for (let i = 0; i < startDayOfWeek; i++) {
    const empty = document.createElement('span');
    empty.className = 'calendar-day calendar-day-empty';
    empty.setAttribute('aria-hidden', 'true');
    grid.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(calendarViewYear, calendarViewMonth, d);
    const iso = isoLocalDate(date);
    const isToday    = iso === todayIso;
    const isSelected = iso === currentJournalDate;
    const isFuture   = iso > todayIso;
    const hasEntries = Array.isArray(store.state.journal[iso]) && store.state.journal[iso].length > 0;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'calendar-day';
    if (isToday)    cell.classList.add('is-today');
    if (isSelected) cell.classList.add('is-selected');
    if (isFuture)   { cell.classList.add('is-future'); cell.disabled = true; }
    if (hasEntries && !isFuture) cell.classList.add('has-entries');
    cell.textContent = d;
    cell.setAttribute('aria-label',
      date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }));
    cell.addEventListener('click', () => {
      if (isFuture) return;
      currentJournalDate = iso;
      closeCalendar();
      renderJournal();
    });
    grid.appendChild(cell);
  }

  // Trailing empties — keep the grid at a fixed 6-row height.
  for (let i = 0; i < trailingEmpty; i++) {
    const empty = document.createElement('span');
    empty.className = 'calendar-day calendar-day-empty';
    empty.setAttribute('aria-hidden', 'true');
    grid.appendChild(empty);
  }
}

function closeCalendar() {
  if (!activeCalendar) return;
  activeCalendar.remove();
  activeCalendar = null;
  document.removeEventListener('mousedown', calendarOutsideMousedown, true);
  document.removeEventListener('keydown', calendarEscape, true);
  window.removeEventListener('resize', closeCalendar);
  window.removeEventListener('scroll', closeCalendar, true);
}

function calendarOutsideMousedown(e) {
  if (activeCalendar && !activeCalendar.contains(e.target) && !journalDateBtn.contains(e.target)) {
    closeCalendar();
  }
}
function calendarEscape(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeCalendar(); }
}

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

  const pill = buildCategoryPill(todo.category, 'task', (newCat) => {
    setTodoCategory(todo.id, newCat, archived);
  });

  // Focus button — its own slot between the tag pill and the destructive
  // actions. Click on the active task re-opens the focus dialog instead of
  // toggling stop, since stopping should be a deliberate gesture from inside
  // the dialog.
  let focusBtn = null;
  if (!archived) {
    const isActiveFocus = focusSession && focusSession.taskId === todo.id;
    focusBtn = document.createElement('button');
    focusBtn.type = 'button';
    focusBtn.className = 'task-focus-btn' + (isActiveFocus ? ' is-on' : '');
    focusBtn.title = isActiveFocus ? 'Open focus session' : 'Start 25-min focus';
    focusBtn.setAttribute('aria-label', focusBtn.title);
    focusBtn.innerHTML = isActiveFocus ? ICONS.stop : ICONS.play;
    focusBtn.addEventListener('click', () => {
      if (focusSession && focusSession.taskId === todo.id) openFocusDialog();
      else openFocusPicker(todo.id);
    });
  }

  // Tag pill is rendered as a colored stripe on the LEFT edge of the row via
  // CSS (.todo-item .category-pill is absolutely positioned). DOM order is
  // irrelevant for layout, but we keep the pill out of the flex flow by
  // attaching it last — when CSS toggles the stripe style, the row collapses
  // the gap cleanly.
  if (focusBtn) li.append(handle, cb, span, focusBtn, actions);
  else          li.append(handle, cb, span, actions);
  li.appendChild(pill);

  // Visual: when this is the active focus task, draw a progress fill underneath.
  if (!archived && focusSession && focusSession.taskId === todo.id) {
    li.classList.add('is-focusing');
    const fill = document.createElement('span');
    fill.className = 'todo-focus-fill';
    fill.style.setProperty('--focus-progress', `${focusSession.progress * 100}%`);
    li.appendChild(fill);
  }
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

  const filterId  = selectedCategoryId;
  const filterCat = getCategory(filterId);
  // Filtering only applies in the flat view; grouped view always shows all.
  const filtering = !groupByCategory && !!filterCat;

  const visibleTodos    = filtering ? todos.filter((t) => t.category === filterId) : todos;
  const visibleArchived = filtering ? archivedTodos.filter((t) => t.category === filterId) : archivedTodos;

  const total        = todos.length;
  const visibleTotal = visibleTodos.length;
  const visibleDone  = visibleTodos.filter((t) => t.done).length;

  todoEmpty.classList.toggle('hidden', visibleTotal > 0);

  // Empty-state messaging adapts to whichever mode is active.
  const emptyTitle = todoEmpty.querySelector('.empty-title');
  const emptyHint  = todoEmpty.querySelector('.empty-hint');
  if (filtering && total > 0) {
    emptyTitle.textContent = `No "${filterCat.label}" tasks`;
    emptyHint.innerHTML = `Click <strong>${escapeHtml(filterCat.label)}</strong> again to show all.`;
  } else {
    emptyTitle.textContent = 'Nothing on the list';
    emptyHint.innerHTML = 'Press <kbd>N</kbd> to add one';
  }

  if (filtering) {
    tasksMeta.textContent = `${visibleDone} of ${visibleTotal} · ${filterCat.label}`;
  } else if (groupByCategory && total > 0) {
    tasksMeta.textContent = `${visibleDone} of ${visibleTotal} done · grouped`;
  } else {
    tasksMeta.textContent = total ? `${visibleDone} of ${total} done` : '';
  }

  if (visibleTotal > 0) {
    progressEl.classList.add('show');
    progressFill.style.width = `${(visibleDone / visibleTotal) * 100}%`;
  } else {
    progressEl.classList.remove('show');
    progressFill.style.width = '0%';
  }

  if (groupByCategory) {
    renderGroupedTodos();
  } else {
    visibleTodos.forEach((todo) => todoList.appendChild(buildTodoItem(todo)));
  }

  // Archive — follows the same mode as the active list. Grouped mode here uses
  // the full archive (filter is implicit in the bucketing), so the count reflects
  // archivedTodos.length when grouped instead of the filtered subset.
  const groupedArchive = groupByCategory && archivedTodos.length > 0;
  const archivedVisibleCount = groupedArchive
    ? archivedTodos.length
    : (filtering ? visibleArchived.length : archivedTodos.length);
  if (archivedVisibleCount > 0) {
    archiveEl.hidden = false;
    archiveCount.textContent = archivedVisibleCount;
    if (groupedArchive) {
      renderGroupedArchive();
    } else {
      visibleArchived.forEach((todo) => archiveList.appendChild(buildTodoItem(todo, { archived: true })));
    }
  } else {
    archiveEl.hidden = true;
    archiveEl.open = false;
  }
}

// Grouped view: one collapsible section per tag (that has tasks), with an
// "Untagged" section last for tasks that have no category. Order within each
// section follows the underlying todos array, so manual reorders are preserved.
function renderGroupedTodos() {
  const buckets = new Map();
  todos.forEach((t) => {
    const key = getCategory(t.category) ? t.category : '__untagged__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  });

  taskCategories.forEach((cat) => {
    const items = buckets.get(cat.id);
    if (items && items.length) todoList.appendChild(buildTaskGroup(cat, items));
  });
  const untagged = buckets.get('__untagged__');
  if (untagged && untagged.length) todoList.appendChild(buildTaskGroup(null, untagged));
}

// Grouped archive: same layout as active todos, but feeds archivedTodos and
// passes { archived: true } to buildTodoItem so the action buttons differ.
function renderGroupedArchive() {
  const buckets = new Map();
  archivedTodos.forEach((t) => {
    const key = getCategory(t.category) ? t.category : '__untagged__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  });

  taskCategories.forEach((cat) => {
    const items = buckets.get(cat.id);
    if (items && items.length) archiveList.appendChild(buildTaskGroup(cat, items, { archived: true }));
  });
  const untagged = buckets.get('__untagged__');
  if (untagged && untagged.length) archiveList.appendChild(buildTaskGroup(null, untagged, { archived: true }));
}

function buildTaskGroup(cat, items, { archived = false } = {}) {
  const details = document.createElement('details');
  details.className = 'task-group';
  // Prefix the collapse key so the same tag's section in active vs. archive
  // doesn't share open/closed state.
  const prefix = archived ? 'archive' : 'task';
  const key = `${prefix}:${cat ? cat.id : '__untagged__'}`;
  details.open = expandedGroups.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) expandedGroups.add(key);
    else expandedGroups.delete(key);
  });

  const summary = document.createElement('summary');
  summary.className = 'task-group-summary';
  if (cat) summary.style.setProperty('--cat-color', cat.color);
  summary.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="archive-caret" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
    <span class="task-group-dot"></span>
    <span class="task-group-label">${escapeHtml(cat ? cat.label : 'Untagged')}</span>
    <span class="task-group-count">${items.length}</span>
  `;

  const ul = document.createElement('ul');
  ul.className = 'todo-list task-group-list';
  items.forEach((todo) => ul.appendChild(buildTodoItem(todo, { archived })));

  details.append(summary, ul);
  return details;
}

function addTodo(text) {
  const todo = { id: Date.now() + Math.random(), text, done: false };
  if (pendingTaskCategoryId) todo.category = pendingTaskCategoryId;
  todos.unshift(todo);
  saveTodos(); renderTodos();
}
function toggleTodo(id, archived) {
  const arr = archived ? archivedTodos : todos;
  const t = arr.find(x => x.id === id);
  if (!t) return;
  const wasDone = t.done;
  t.done = !t.done;
  // Completing an active task auto-logs it into today's work — the most
  // common case ("what did I get done?") fills the journal without manual
  // duplication. Archived items + un-checking don't trigger this.
  if (!archived && !wasDone && t.done) appendTaskCompletionToJournal(t);
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
  // Reset the pill back to the active filter so the next task defaults sensibly.
  pendingTaskCategoryId = selectedCategoryId;
  syncTaskTagPill();
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

function setLinkCategory(id, category, kind) {
  const arr = listFor(kind);
  const link = arr.find((l) => l.id === id);
  if (!link) return;
  if (category) link.category = category;
  else delete link.category;
  saveLinks();
  renderFor(kind);
}

// Compose search and category filter. The category-filter half is skipped
// in grouped view since grouped mode shows the full list bucketed by tag.
function filteredQuickLinks() {
  let arr = quickLinks;
  if (!groupLinksByCategory && selectedLinkCategoryId) {
    arr = arr.filter((l) => l.category === selectedLinkCategoryId);
  }
  if (quickQuery) {
    const q = quickQuery.toLowerCase();
    arr = arr.filter((l) =>
      l.title.toLowerCase().includes(q) ||
      l.url.toLowerCase().includes(q)
    );
  }
  return arr;
}
function filteredSavedLinks() {
  if (!selectedLinkCategoryId || groupLinksByCategory) return savedLinks;
  return savedLinks.filter((l) => l.category === selectedLinkCategoryId);
}

// --- Quick Links: tile grid ---
function renderQuickLinks() {
  quickGrid.innerHTML = '';
  const filterCat = getCategory(selectedLinkCategoryId);
  // Filter only applies in flat view; grouped view ignores it.
  const filtering = !groupLinksByCategory && !!filterCat;

  const visible = filteredQuickLinks();
  const totalQuick = quickLinks.length;

  // Meta string — mirrors the task panel's three modes (group / filter / plain).
  if (groupLinksByCategory && totalQuick > 0) {
    quickMeta.textContent = `${totalQuick} saved · grouped`;
  } else if (filtering || quickQuery) {
    const parts = [`${visible.length} of ${totalQuick}`];
    if (filtering) parts.push(filterCat.label);
    quickMeta.textContent = parts.join(' · ');
  } else {
    quickMeta.textContent = totalQuick ? `${totalQuick} saved` : '';
  }

  quickEmpty.classList.toggle('hidden', totalQuick > 0);
  if (totalQuick === 0) return;

  if (groupLinksByCategory) {
    renderGroupedQuickLinks();
    return;
  }

  visible.forEach((link) => quickGrid.appendChild(buildLinkTile(link, 'quick')));

  // Trailing "add" tile — only when we're browsing the unfiltered, unsearched list.
  if (!quickQuery && !filtering) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'link-tile link-tile-add';
    add.innerHTML = `<span class="plus">+</span><span class="add-text">Add quick link</span>`;
    add.addEventListener('click', () => openAddLinkDialog());
    quickGrid.appendChild(add);
  }

  if (visible.length === 0 && (quickQuery || filtering)) {
    const note = document.createElement('p');
    note.className = 'empty-state';
    note.style.gridColumn = '1 / -1';
    let title;
    if (quickQuery && filtering) {
      title = `No quick links match "${escapeHtml(quickQuery)}" in ${escapeHtml(filterCat.label)}`;
    } else if (quickQuery) {
      title = `No quick links match "${escapeHtml(quickQuery)}"`;
    } else {
      title = `No "${escapeHtml(filterCat.label)}" quick links`;
    }
    note.innerHTML = `<span class="empty-icon">·</span><span class="empty-title">${title}</span>`;
    quickGrid.appendChild(note);
  }
}

// Grouped Quick Links: collapsible section per tag, plus "Untagged" last.
// Search still applies (composes inside each bucket).
function renderGroupedQuickLinks() {
  const baseList = quickQuery
    ? quickLinks.filter((l) => {
        const q = quickQuery.toLowerCase();
        return l.title.toLowerCase().includes(q) || l.url.toLowerCase().includes(q);
      })
    : quickLinks;

  const buckets = new Map();
  baseList.forEach((l) => {
    const key = getCategory(l.category) ? l.category : '__untagged__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(l);
  });

  linkCategories.forEach((cat) => {
    const items = buckets.get(cat.id);
    if (items && items.length) quickGrid.appendChild(buildLinkGroup(cat, items, 'quick'));
  });
  const untagged = buckets.get('__untagged__');
  if (untagged && untagged.length) {
    quickGrid.appendChild(buildLinkGroup(null, untagged, 'quick'));
  }

  if (quickGrid.childElementCount === 0 && quickQuery) {
    const note = document.createElement('p');
    note.className = 'empty-state';
    note.style.gridColumn = '1 / -1';
    note.innerHTML = `<span class="empty-icon">·</span><span class="empty-title">No quick links match "${escapeHtml(quickQuery)}"</span>`;
    quickGrid.appendChild(note);
  }
}

function buildLinkGroup(cat, items, kind) {
  const details = document.createElement('details');
  details.className = 'link-group';
  const key = `link-${kind}:${cat ? cat.id : '__untagged__'}`;
  if (kind === 'quick') {
    // Quick Links is the primary view — groups default OPEN; only collapses
    // the user explicitly performed are remembered.
    details.open = !collapsedQuickGroups.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) collapsedQuickGroups.delete(key);
      else collapsedQuickGroups.add(key);
    });
  } else {
    // Saved-for-later — same default-collapsed semantics as task groups.
    details.open = expandedGroups.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) expandedGroups.add(key);
      else expandedGroups.delete(key);
    });
  }

  const summary = document.createElement('summary');
  summary.className = 'task-group-summary';
  if (cat) summary.style.setProperty('--cat-color', cat.color);
  summary.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="archive-caret" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
    <span class="task-group-dot"></span>
    <span class="task-group-label">${escapeHtml(cat ? cat.label : 'Untagged')}</span>
    <span class="task-group-count">${items.length}</span>
  `;

  const grid = document.createElement('div');
  grid.className = kind === 'saved' ? 'link-grid link-grid-saved' : 'link-grid';
  items.forEach((link) => grid.appendChild(buildLinkTile(link, kind)));

  details.append(summary, grid);
  return details;
}

// --- Saved for Later: same tile grid, lives inside a collapsible <details> ---
function renderSavedLinks() {
  savedGrid.innerHTML = '';

  // Grouped mode mirrors quickLinks: bucket per tag, ignore the filter chip.
  if (groupLinksByCategory && savedLinks.length > 0) {
    savedArchive.hidden = false;
    savedCount.textContent = savedLinks.length;
    renderGroupedSavedLinks();
    return;
  }

  const visible = filteredSavedLinks();
  // Hide the saved-archive entirely when there's nothing to show under the
  // current filter — keeps the panel quiet when filtering by a tag with no
  // saved entries.
  if (visible.length === 0) {
    savedArchive.hidden = true;
    savedArchive.open = false;
    return;
  }
  savedArchive.hidden = false;
  savedCount.textContent = visible.length;
  visible.forEach((link) => savedGrid.appendChild(buildLinkTile(link, 'saved')));
}

function renderGroupedSavedLinks() {
  const buckets = new Map();
  savedLinks.forEach((l) => {
    const key = getCategory(l.category) ? l.category : '__untagged__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(l);
  });
  linkCategories.forEach((cat) => {
    const items = buckets.get(cat.id);
    if (items && items.length) savedGrid.appendChild(buildLinkGroup(cat, items, 'saved'));
  });
  const untagged = buckets.get('__untagged__');
  if (untagged && untagged.length) savedGrid.appendChild(buildLinkGroup(null, untagged, 'saved'));
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
  // Drag-to-reorder is allowed in flat, filtered, and grouped views.
  // Search still disables it for quick tiles, since the user is in a
  // transient lookup mode and reorder semantics get confusing.
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

  // Colored-dot pill in the top-left corner — clicking opens the tag popover.
  const pill = buildCategoryPill(link.category, 'link', (newCat) => {
    setLinkCategory(link.id, newCat, kind);
  });
  pill.classList.add('link-category-pill');

  tile.append(actions, pill, faviconWrap, info);
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
  play:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M10.2 8.2l5.8 3.8-5.8 3.8z" fill="currentColor" stroke="none"/></svg>',
  stop:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>',
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
  // Default to the active link filter so new links stay visible under it.
  pendingLinkCategoryId = selectedLinkCategoryId;
  syncLinkTagPill();
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
  pendingLinkCategoryId = link.category || null;
  syncLinkTagPill();
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
    const link = { id: Date.now() + Math.random(), title, url };
    if (pendingLinkCategoryId) link.category = pendingLinkCategoryId;
    arr.push(link);
  } else {
    const link = arr.find(l => l.id === editingLinkId);
    if (!link) { closeLinkDialog(); return; }
    link.title = title;
    link.url = url;
    if (pendingLinkCategoryId) link.category = pendingLinkCategoryId;
    else delete link.category;
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

// =====================================================
// PWA INSTALL
//   - Chrome/Edge/Android: catch `beforeinstallprompt`, show our button,
//     call .prompt() on click, hide once installed.
//   - iOS Safari: no install event exists; detect the platform and show
//     the same button but route it to an instructions dialog. A dismiss
//     persists in localStorage so the user isn't nagged.
//   - Already installed (display-mode: standalone): hide entirely.
// =====================================================
const IOS_DISMISS_KEY = 'daily-dashboard:install-dismissed';

let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true; // iOS Safari quirk
}

function isIosSafari() {
  const ua = window.navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
  // Safari (not Chrome/Firefox/Edge on iOS, which all wrap WebKit but expose their own UA tokens).
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return ios && safari;
}

function updateInstallButton() {
  if (!installBtn) return;
  if (isStandalone()) { installBtn.hidden = true; return; }
  if (deferredInstallPrompt) { installBtn.hidden = false; return; }
  if (isIosSafari() && localStorage.getItem(IOS_DISMISS_KEY) !== '1') {
    installBtn.hidden = false;
    return;
  }
  installBtn.hidden = true;
}

window.addEventListener('beforeinstallprompt', (e) => {
  // Stash the event; we'll trigger it from our button instead of the browser's
  // default mini-infobar (which doesn't fire on all platforms anyway).
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButton();
  showToast('Installed — find Daily on your home screen');
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      // Android / desktop Chrome path: trigger native prompt.
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch {}
      deferredInstallPrompt = null;
      updateInstallButton();
      return;
    }
    if (isIosSafari()) {
      // iOS path: show how-to dialog.
      if (typeof installDialog.showModal === 'function') installDialog.showModal();
      else installDialog.setAttribute('open', '');
    }
  });
}
if (installDialogClose) {
  installDialogClose.addEventListener('click', () => {
    if (installDialog.open) installDialog.close();
  });
}
if (installDialog) {
  installDialog.addEventListener('click', (e) => {
    if (e.target === installDialog) installDialog.close();
  });
  // "Got it" submits the form (method=dialog) → mark dismissed so we don't
  // nag the same user on every visit.
  installDialog.addEventListener('close', () => {
    if (isIosSafari()) {
      localStorage.setItem(IOS_DISMISS_KEY, '1');
      updateInstallButton();
    }
  });
}

// First paint after init runs.
updateInstallButton();

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
function setupDnd({ container, itemSelector, groupSelector, getList, axis, onChange }) {
  let draggingId = null;
  let draggingGroup = null; // the .task-group / .link-group the source belongs to (if grouped)
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
    draggingGroup = null;
  }

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item || !container.contains(item)) return;
    if (item.draggable === false) return;
    draggingId = item.dataset.id;
    // Capture the source group (if any) so dragover can constrain drops
    // to within the same group. Skipped when no groupSelector is provided.
    draggingGroup = groupSelector ? item.closest(groupSelector) : null;
    // Defer adding the class so the browser captures the drag image first
    requestAnimationFrame(() => item.classList.add('dragging'));
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', draggingId); } catch { /* some browsers throw on links */ }
  });

  container.addEventListener('dragover', (e) => {
    if (!draggingId) return;
    const target = e.target.closest(itemSelector);
    if (!target || !container.contains(target)) return;
    // Same-group constraint: in grouped mode, ignore targets in a different
    // group so cross-group drops are silently rejected (no indicator, no drop).
    if (draggingGroup) {
      const targetGroup = target.closest(groupSelector);
      if (targetGroup !== draggingGroup) { clearIndicators(); return; }
    }
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
  groupSelector: '.task-group', // same-group constraint kicks in only when grouped
  getList: () => todos,
  axis: 'y',
  onChange: () => { saveTodos(); renderTodos(); },
});
setupDnd({
  container: archiveList,
  itemSelector: '.todo-item',
  groupSelector: '.task-group', // constrains reorders to within the same group when grouped
  getList: () => archivedTodos,
  axis: 'y',
  onChange: () => { saveTodos(); renderTodos(); },
});
setupDnd({
  container: quickGrid,
  itemSelector: '.link-tile:not(.link-tile-add)',
  groupSelector: '.link-group',
  getList: () => quickLinks,
  axis: 'x',
  onChange: () => { saveLinks(); renderQuickLinks(); },
});
setupDnd({
  container: savedGrid,
  itemSelector: '.link-tile',
  groupSelector: '.link-group', // grouped mode constrains drops to the same tag's section
  getList: () => savedLinks,
  axis: 'x',
  onChange: () => { saveLinks(); renderSavedLinks(); },
});

// Today's Work — same vertical reorder pattern as the task list. getList
// returns the current date's entry array; setupDnd mutates it in place via
// splice, which also mutates store.state.journal[currentJournalDate]. On
// dates with no entries, getList returns a fresh [] which DnD just no-ops on.
setupDnd({
  container: journalList,
  itemSelector: '.journal-entry',
  getList: () => getJournalEntries(currentJournalDate),
  axis: 'y',
  onChange: () => { store.save(); renderJournalList(); },
});

// Chip rows — drag a tag to reorder. The backing arrays (taskCategories /
// linkCategories) drive both the chip-row order AND the order of sections in
// the grouped-by-tag view, so reordering here reflects in both places.
setupDnd({
  container: categoryRow,
  itemSelector: '.category-chip-wrap',
  getList: () => taskCategories,
  axis: 'x',
  onChange: () => { store.save(); renderTaskCategoryRow(); renderTodos(); },
});
setupDnd({
  container: linkCategoryRow,
  itemSelector: '.category-chip-wrap',
  getList: () => linkCategories,
  axis: 'x',
  onChange: () => { store.save(); renderLinkCategoryRow(); renderQuickLinks(); renderSavedLinks(); },
});

// =====================================================
// TEAM LENS — at-a-glance per-team status card
// =====================================================
// For each team: a colored status pill with a one-line note, a "waiting
// on" list (blockers / people who owe you), and a small grid of links
// (runbooks / dashboards / repos). All independent of the Tasks panel.
// Per-team data lives in store.state.teamLens.perTeam — see getTeamData.

const STATUS_ORDER = ['idle', 'green', 'yellow', 'red'];
const STATUS_LABELS = { idle: 'Idle', green: 'On track', yellow: 'At risk', red: 'Blocked' };

const teamLensChipRow      = $('#teamlens-chip-row');
const teamLensMeta         = $('#teamlens-meta');
const teamLensEmpty        = $('#teamlens-empty');
const teamLensOverview     = $('#teamlens-overview');
const teamLensBody         = $('#teamlens-body');
const lensStatusPill       = $('#lens-status-pill');
const lensStatusText       = $('#lens-status-text');
const lensStatusNote       = $('#lens-status-note');
const lensWaitingEl        = $('#lens-waiting');
const lensWaitingEmpty     = $('#lens-waiting-empty');
const lensWaitingCount     = $('#lens-waiting-count');
const lensWaitingForm      = $('#lens-waiting-form');
const lensWaitingInput     = $('#lens-waiting-input');
const lensLinksEl          = $('#lens-links');
const lensLinksEmpty       = $('#lens-links-empty');
const lensLinksCount       = $('#lens-links-count');
const lensLinksForm        = $('#lens-links-form');
const lensLinkLabel        = $('#lens-link-label');
const lensLinkUrl          = $('#lens-link-url');

function getActiveTeamId() {
  const id = store.state.teamLens.activeTeamId;
  if (!id) return null;
  return teams.some((t) => t.id === id) ? id : null;
}

function getTeamData(teamId) {
  let d = store.state.teamLens.perTeam[teamId];
  if (!d) {
    d = { status: 'idle', statusNote: '', waiting: [], links: [] };
    store.state.teamLens.perTeam[teamId] = d;
  }
  if (!STATUS_ORDER.includes(d.status)) d.status = 'idle';
  if (typeof d.statusNote !== 'string') d.statusNote = '';
  if (!Array.isArray(d.waiting)) d.waiting = [];
  if (!Array.isArray(d.links))   d.links   = [];
  return d;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m`;
  if (h < 24) return `${h}h`;
  if (d < 7)  return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function setActiveTeam(teamId) {
  store.state.teamLens.activeTeamId = teamId;
  store.save();
  renderTeamLens();
}

function deleteTeam(id) {
  const idx = teams.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [team] = teams.splice(idx, 1);
  const data = store.state.teamLens.perTeam[id];
  delete store.state.teamLens.perTeam[id];
  if (store.state.teamLens.activeTeamId === id) store.state.teamLens.activeTeamId = null;
  store.save();
  renderTeamLens();
  showToast(`Team "${team.label}" deleted`, { label: 'Undo', fn: () => {
    teams.splice(idx, 0, team);
    if (data) store.state.teamLens.perTeam[id] = data;
    store.save();
    renderTeamLens();
  }});
}

function renameTeam(id, nextLabel) {
  const team = teams.find((t) => t.id === id);
  if (!team) return;
  const trimmed = (nextLabel || '').trim();
  if (!trimmed || trimmed === team.label) return;
  team.label = trimmed;
  store.save();
  renderTeamLens();
}

// Put a chip's label into inline-edit mode. Enter saves, Escape reverts,
// blur saves (or reverts if the value is empty / unchanged). The caller
// supplies onCommit so this helper is agnostic to teams vs. categories.
function enterChipRename(labelSpan, original, onCommit) {
  if (labelSpan.isContentEditable) return;
  labelSpan.contentEditable = 'true';
  labelSpan.spellcheck = false;
  labelSpan.focus();
  const range = document.createRange();
  range.selectNodeContents(labelSpan);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    labelSpan.contentEditable = 'false';
    if (commit) {
      const next = labelSpan.textContent.trim();
      if (next && next !== original) onCommit(next);
      else labelSpan.textContent = original;
    } else {
      labelSpan.textContent = original;
    }
  };
  labelSpan.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); finish(true);  labelSpan.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); labelSpan.blur(); }
  });
  labelSpan.addEventListener('blur', () => finish(true), { once: true });
}

function renderTeamLensChipRow() {
  if (!teamLensChipRow) return;
  teamLensChipRow.innerHTML = '';
  const activeId = getActiveTeamId();
  teams.forEach((team) => {
    const wrap = document.createElement('span');
    wrap.className = 'teamlens-chip-wrap';
    // Drag handle for setupDnd: reads dataset.id and requires draggable=true.
    wrap.draggable = true;
    wrap.dataset.id = team.id;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'teamlens-chip' + (activeId === team.id ? ' is-selected' : '');
    chip.style.setProperty('--cat-color', team.color);
    chip.style.setProperty('--cat-soft', team.soft);
    chip.setAttribute('aria-pressed', activeId === team.id ? 'true' : 'false');
    chip.innerHTML = `<span class="chip-dot"></span><span class="chip-label">${escapeHtml(team.label)}</span>`;
    const labelSpan = chip.querySelector('.chip-label');
    chip.addEventListener('click', () => {
      // Ignore the synthetic click that fires when finishing a rename edit.
      if (labelSpan.isContentEditable) return;
      setActiveTeam(activeId === team.id ? null : team.id);
    });

    // Pencil — renames. Sits at the top-left corner of the chip (mirrors ×).
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'teamlens-chip-rename';
    renameBtn.title = `Rename "${team.label}"`;
    renameBtn.setAttribute('aria-label', `Rename ${team.label}`);
    renameBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      enterChipRename(labelSpan, team.label, (next) => renameTeam(team.id, next));
    });

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'category-chip-delete';
    x.innerHTML = '&times;';
    x.title = `Delete team "${team.label}"`;
    x.setAttribute('aria-label', `Delete team ${team.label}`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTeam(team.id);
    });
    wrap.append(renameBtn, chip, x);
    teamLensChipRow.appendChild(wrap);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'category-add-btn';
  addBtn.title = 'Add a team';
  addBtn.setAttribute('aria-label', 'Add a team');
  addBtn.innerHTML = '+';
  addBtn.addEventListener('click', () => openCreateCategoryDialog('team'));
  teamLensChipRow.appendChild(addBtn);
}

// --- Status pill ---
function renderStatus(data) {
  lensStatusPill.dataset.status = data.status;
  lensStatusText.textContent = STATUS_LABELS[data.status] || 'Idle';
  if (document.activeElement !== lensStatusNote) lensStatusNote.value = data.statusNote || '';
}

function cycleStatus() {
  const teamId = getActiveTeamId();
  if (!teamId) return;
  const data = getTeamData(teamId);
  const i = STATUS_ORDER.indexOf(data.status);
  data.status = STATUS_ORDER[(i + 1) % STATUS_ORDER.length];
  store.save();
  renderStatus(data);
}

// --- Waiting-on list ---
function renderWaiting(data) {
  lensWaitingEl.innerHTML = '';
  lensWaitingEmpty.hidden = data.waiting.length > 0;
  lensWaitingCount.textContent = data.waiting.length ? String(data.waiting.length) : '';
  data.waiting.forEach((w) => {
    const li = document.createElement('li');
    li.className = 'lens-waiting-item';
    const dot = document.createElement('span');
    dot.className = 'lens-waiting-dot';
    const text = document.createElement('span');
    text.className = 'lens-waiting-text';
    text.textContent = w.text;
    const age = document.createElement('span');
    age.className = 'lens-waiting-age';
    age.textContent = relativeTime(w.ts || Date.now());
    age.title = new Date(w.ts || Date.now()).toLocaleString();
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lens-item-del';
    del.innerHTML = '&times;';
    del.setAttribute('aria-label', 'Remove');
    del.addEventListener('click', () => removeWaiting(w.id));
    li.append(dot, text, age, del);
    lensWaitingEl.appendChild(li);
  });
}

function addWaiting(text) {
  const teamId = getActiveTeamId();
  if (!teamId) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const data = getTeamData(teamId);
  data.waiting.unshift({ id: Date.now() + Math.random(), text: trimmed, ts: Date.now() });
  store.save();
  renderWaiting(data);
}

function removeWaiting(id) {
  const teamId = getActiveTeamId();
  if (!teamId) return;
  const data = getTeamData(teamId);
  const idx = data.waiting.findIndex((x) => x.id === id);
  if (idx < 0) return;
  data.waiting.splice(idx, 1);
  store.save();
  renderWaiting(data);
}

// --- Links ---
function renderLensLinks(data) {
  lensLinksEl.innerHTML = '';
  lensLinksEmpty.hidden = data.links.length > 0;
  lensLinksCount.textContent = data.links.length ? String(data.links.length) : '';
  data.links.forEach((l) => {
    const a = document.createElement('a');
    a.className = 'lens-link-chip';
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = l.url;
    const label = document.createElement('span');
    label.className = 'lens-link-chip-label';
    label.textContent = l.label || l.url;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lens-link-chip-del';
    del.innerHTML = '&times;';
    del.setAttribute('aria-label', 'Remove link');
    del.addEventListener('click', (e) => { e.preventDefault(); removeLensLink(l.id); });
    a.append(label, del);
    lensLinksEl.appendChild(a);
  });
}

function addLensLink(label, url) {
  const teamId = getActiveTeamId();
  if (!teamId) return;
  const cleanedUrl = url.trim();
  if (!cleanedUrl) return;
  const safeUrl = /^https?:\/\//i.test(cleanedUrl) ? cleanedUrl : `https://${cleanedUrl}`;
  const cleanedLabel = label.trim() || safeUrl.replace(/^https?:\/\//i, '').split('/')[0];
  const data = getTeamData(teamId);
  data.links.push({ id: Date.now() + Math.random(), label: cleanedLabel, url: safeUrl });
  store.save();
  renderLensLinks(data);
}

function removeLensLink(id) {
  const teamId = getActiveTeamId();
  if (!teamId) return;
  const data = getTeamData(teamId);
  const idx = data.links.findIndex((x) => x.id === id);
  if (idx < 0) return;
  data.links.splice(idx, 1);
  store.save();
  renderLensLinks(data);
}

function renderTeamLensOverview() {
  teamLensOverview.innerHTML = '';
  teams.forEach((team) => {
    const data = getTeamData(team.id);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'teamlens-overview-row';
    row.style.setProperty('--cat-color', team.color);
    row.style.setProperty('--cat-soft',  team.soft);
    row.setAttribute('data-status', data.status);
    row.addEventListener('click', () => setActiveTeam(team.id));

    // Color dot + team name
    const head = document.createElement('div');
    head.className = 'teamlens-overview-head';
    head.innerHTML = `
      <span class="teamlens-overview-dot"></span>
      <span class="teamlens-overview-name">${escapeHtml(team.label)}</span>
    `;

    // Status pill (read-only, matches the in-team pill style)
    const status = document.createElement('span');
    status.className = 'teamlens-overview-status';
    status.dataset.status = data.status;
    status.innerHTML = `
      <span class="lens-status-dot"></span>
      <span>${STATUS_LABELS[data.status] || 'Idle'}</span>
    `;

    // Optional one-line note (truncated by CSS)
    const note = document.createElement('span');
    note.className = 'teamlens-overview-note';
    note.textContent = data.statusNote || '—';

    // Counts on the right
    const counts = document.createElement('div');
    counts.className = 'teamlens-overview-counts';
    if (data.waiting.length) {
      const c = document.createElement('span');
      c.className = 'teamlens-overview-count';
      c.title = `${data.waiting.length} waiting`;
      c.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg><span>${data.waiting.length}</span>`;
      counts.appendChild(c);
    }
    if (data.links.length) {
      const c = document.createElement('span');
      c.className = 'teamlens-overview-count';
      c.title = `${data.links.length} link${data.links.length === 1 ? '' : 's'}`;
      c.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg><span>${data.links.length}</span>`;
      counts.appendChild(c);
    }

    row.append(head, status, note, counts);
    teamLensOverview.appendChild(row);
  });
}

function renderTeamLensBody() {
  const teamId = getActiveTeamId();
  // --- No team active: choose empty hint vs. overview based on whether
  //     any teams exist at all. ---
  if (!teamId) {
    teamLensBody.hidden = true;
    teamLensBody.style.removeProperty('--cat-color');
    teamLensBody.style.removeProperty('--cat-soft');
    if (teams.length === 0) {
      teamLensEmpty.classList.remove('hidden');
      teamLensOverview.hidden = true;
      teamLensMeta.textContent = 'No teams yet';
    } else {
      teamLensEmpty.classList.add('hidden');
      teamLensOverview.hidden = false;
      teamLensMeta.textContent = `${teams.length} team${teams.length === 1 ? '' : 's'} · overview`;
      renderTeamLensOverview();
    }
    return;
  }
  // --- Team active: drill into the focus card. ---
  const team = teams.find((t) => t.id === teamId);
  teamLensEmpty.classList.add('hidden');
  teamLensOverview.hidden = true;
  teamLensBody.hidden = false;
  teamLensMeta.textContent = team ? team.label : '';
  if (team) {
    teamLensBody.style.setProperty('--cat-color', team.color);
    teamLensBody.style.setProperty('--cat-soft', team.soft);
  }
  const data = getTeamData(teamId);
  renderStatus(data);
  renderWaiting(data);
  renderLensLinks(data);
}

function renderTeamLens() {
  renderTeamLensChipRow();
  renderTeamLensBody();
}

// --- Event bindings ---
lensStatusPill?.addEventListener('click', cycleStatus);

lensStatusNote?.addEventListener('input', () => {
  const teamId = getActiveTeamId();
  if (!teamId) return;
  getTeamData(teamId).statusNote = lensStatusNote.value;
  store.save();
});

lensWaitingForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  addWaiting(lensWaitingInput.value);
  lensWaitingInput.value = '';
  lensWaitingInput.focus();
});

lensLinksForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  addLensLink(lensLinkLabel.value, lensLinkUrl.value);
  lensLinkLabel.value = '';
  lensLinkUrl.value = '';
  lensLinkLabel.focus();
});

// Team chip row — same horizontal reorder as the category rows. The `teams`
// array drives both chip order and overview-row order, so a reorder is
// visible in both states. Declared here (not next to the other setupDnd
// calls) so `teamLensChipRow` is past its TDZ when this runs.
setupDnd({
  container: teamLensChipRow,
  itemSelector: '.teamlens-chip-wrap',
  getList: () => teams,
  axis: 'x',
  onChange: () => { store.save(); renderTeamLens(); },
});

// --- Init ---
async function init() {
  await store.load();
  document.documentElement.setAttribute('data-theme', store.state.theme);
  groupByCategory      = !!store.state.groupByCategory;
  groupLinksByCategory = !!store.state.groupLinksByCategory;
  updateHeader();
  renderAllCategoryRows();
  syncTaskTagPill();
  syncLinkTagPill();
  renderTodos();
  renderQuickLinks();
  renderSavedLinks();
  renderJournal();
  renderTeamLens();
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
  // Top-level inputs that are always in the DOM, plus the inputs inside
  // every dialog — extensions like to mangle these whenever a <dialog>
  // opens/closes.
  const inputs = [
    todoInput, quickSearch,
    editTitle, editUrl,
    syncGistId, syncToken,
    categoryName, pickerHex,
  ].filter(Boolean);
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
  // typically scan the DOM. The scrub is deferred a tick so it runs after
  // whatever the extension does in the same event loop.
  const scrub = () => requestAnimationFrame(() => inputs.forEach(sanitize));
  [editDialog, syncDialog, categoryDialog, installDialog].filter(Boolean).forEach((dlg) => {
    dlg.addEventListener('close', scrub);
    dlg.addEventListener('toggle', scrub);
  });
}

// Keep greeting fresh when the tab regains focus across hour boundaries
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateHeader(); });

// Track ⌘/Ctrl state so the Team Lens chips only reveal their edit /
// delete affordances while the modifier is held. Clears on tab blur so
// the class doesn't stick after a window switch.
function syncMetaClass(e) {
  document.body.classList.toggle('meta-down', !!(e.metaKey || e.ctrlKey));
}
document.addEventListener('keydown', syncMetaClass);
document.addEventListener('keyup', syncMetaClass);
window.addEventListener('blur', () => document.body.classList.remove('meta-down'));

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
