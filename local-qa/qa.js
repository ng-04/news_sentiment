// Local Q&A: everything runs in this browser tab. Files are read and indexed locally, and
// questions go straight to Anthropic with the visitor's own API key.
import * as engine from './engine.js';
import * as onedrive from './onedrive.js';
import * as charts from './qa-chart.js';
import * as store from './qa-store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
const icon = (name, cls = '') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `qa-i ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#qa-i-${name}`);
  svg.append(use);
  return svg;
};

const webStore = (kind) => ({
  get(key) { try { return window[kind].getItem(key); } catch (e) { return null; } },
  set(key, value) {
    try { if (value == null) window[kind].removeItem(key); else window[kind].setItem(key, value); } catch (e) { /* blocked */ }
  },
});
const session = webStore('sessionStorage');
const local = webStore('localStorage');

const state = {
  files: new Map(), // fileId -> {fileId, name, folder, pages, chunks, parsed, status}
  failed: [], // {name, folder, error}
  index: new engine.VectorIndex(),
  history: [], // plain-text turns sent to Claude for follow-ups
  records: [], // everything shown in the chat, saved so it survives a reload
  settings: {},
  indexedWith: null,
  busy: false,
  asking: false,
  messageCount: 0,
  nextId: 1,
  mode: 'mine', // 'mine' or 'sample': each has its own documents, chat and saved copy
};

// Storage keys per workspace, so the sample demo never mixes with the user's own documents.
const key = (name) => (state.mode === 'sample' ? `sample:${name}` : name);
const WS_FIELDS = ['files', 'failed', 'index', 'records', 'history', 'indexedWith', 'nextId', 'messageCount'];
const blankWorkspace = () => ({
  files: new Map(), failed: [], index: new engine.VectorIndex(), records: [], history: [], indexedWith: null, nextId: 1, messageCount: 0,
});

// ------------------------------------------------------------------ status banner

function showStatus(text, { error = false } = {}) {
  const box = $('qa-status');
  box.textContent = text;
  box.classList.toggle('qa-banner-error', error);
  box.hidden = false;
}
const hideStatus = () => { $('qa-status').hidden = true; };

// ------------------------------------------------------------------ key and model

const readKey = () => session.get('localqa.apiKey') || local.get('localqa.apiKey') || '';
const readWorkspace = () => session.get('localqa.workspace') || local.get('localqa.workspace') || '';
function storeKey(key) {
  const remember = $('qa-remember-key').checked;
  session.set('localqa.apiKey', remember ? null : key || null);
  local.set('localqa.apiKey', remember ? key || null : null);
  storeWorkspace(readWorkspace());
}
function storeWorkspace(id) {
  const remember = $('qa-remember-key').checked;
  session.set('localqa.workspace', remember ? null : id || null);
  local.set('localqa.workspace', remember ? id || null : null);
}
function showWorkspaceField(focus = false) {
  $('qa-ws-wrap').hidden = false;
  $('qa-ws-toggle').hidden = true;
  if (focus) $('qa-workspace').focus();
}
const model = () => $('qa-model').value;

function renderKey() {
  const select = $('qa-model');
  if (!select.options.length) {
    engine.MODELS.forEach((m) => select.append(el('option', { value: m, text: m })));
    const saved = local.get('localqa.model');
    if (engine.MODELS.includes(saved)) select.value = saved;
  }
  $('qa-api-key').value = readKey();
  $('qa-workspace').value = readWorkspace();
  if (readWorkspace()) showWorkspaceField();
  $('qa-remember-key').checked = !!local.get('localqa.apiKey');
  paintKeyBadge();
}

function paintKeyBadge(ok) {
  const badge = $('qa-key-badge');
  const has = !!readKey();
  badge.textContent = ok ? 'Working' : has ? 'Set' : 'Not set';
  badge.className = `qa-badge ${ok ? 'qa-badge-ok' : has ? 'qa-badge-busy' : ''}`;
}

// ------------------------------------------------------------------ wiring

function wire() {
  $('qa-api-key').addEventListener('input', () => {
    storeKey($('qa-api-key').value.trim());
    $('qa-key-status').textContent = '';
    paintKeyBadge();
    updateAskState();
  });
  $('qa-remember-key').addEventListener('change', () => storeKey(readKey()));
  $('qa-ws-toggle').addEventListener('click', () => showWorkspaceField(true));
  $('qa-workspace').addEventListener('input', () => {
    storeWorkspace($('qa-workspace').value.trim());
    $('qa-key-status').textContent = '';
  });
  $('qa-forget-key').addEventListener('click', () => {
    session.set('localqa.apiKey', null);
    local.set('localqa.apiKey', null);
    session.set('localqa.workspace', null);
    local.set('localqa.workspace', null);
    $('qa-api-key').value = '';
    $('qa-workspace').value = '';
    $('qa-remember-key').checked = false;
    $('qa-key-status').textContent = 'Key forgotten.';
    paintKeyBadge();
    updateAskState();
  });
  $('qa-test-key').addEventListener('click', async () => {
    const status = $('qa-key-status');
    if (!readKey()) { status.textContent = 'Enter a key first.'; return; }
    status.textContent = 'Testing…';
    try {
      await engine.testKey(readKey(), readWorkspace());
      status.textContent = '✓ Key works';
      paintKeyBadge(true);
    } catch (e) {
      status.textContent = e.message;
      if (e.code === 'needs_workspace' || e.code === 'bad_workspace') showWorkspaceField(true);
    }
  });
  $('qa-model').addEventListener('change', () => {
    local.set('localqa.model', model());
    updateTemperatureHint();
  });

  $('qa-file-input').addEventListener('change', (ev) => {
    addFiles([...ev.target.files].map((file) => fromFile(file, '')));
    ev.target.value = '';
  });
  $('qa-folder-input').addEventListener('change', (ev) => {
    addFiles([...ev.target.files].map((file) => fromFile(file, dirname(file.webkitRelativePath))));
    ev.target.value = '';
  });
  const drop = $('qa-drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('qa-dragover'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('qa-dragover')));
  drop.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    addFiles(await collectDropped(ev.dataTransfer));
  });

  $('qa-clear').addEventListener('click', () => {
    state.files.clear();
    state.failed = [];
    state.index.clear();
    state.indexedWith = null;
    renderFiles();
    updateReindexBanner();
    store.remove(key('documents'));
  });
  $('qa-clear-chat').addEventListener('click', () => {
    state.records = [];
    state.history = [];
    $('qa-transcript').replaceChildren();
    $('qa-transcript').hidden = true;
    $('qa-clear-chat').hidden = true;
    store.remove(key('conversation'));
  });

  $('qa-ask-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    askQuestion($('qa-question').value.trim());
  });
  $('qa-question').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $('qa-ask-form').requestSubmit();
    }
  });

  $('qa-adv-toggle').addEventListener('click', () => {
    const open = $('qa-adv-toggle').getAttribute('aria-expanded') !== 'true';
    $('qa-adv-toggle').setAttribute('aria-expanded', String(open));
    $('qa-adv-panel').hidden = !open;
  });
  $('qa-reset').addEventListener('click', () => {
    state.settings = defaultSettings();
    saveSettings();
    renderSettings();
  });
  $('qa-reindex-btn').addEventListener('click', reindex);
  $('qa-limits').textContent = `.pdf, .docx, .xlsx and .zip · up to ${engine.LIMITS.maxFileMb} MB per file `
    + `(${engine.LIMITS.maxZipMb} MB per zip)`;
  $('qa-privacy').textContent = 'Your files are read and searched inside this browser and are never uploaded. '
    + 'Only the passages relevant to a question are sent to Anthropic with your key. Your chat and indexed documents are '
    + 'saved in this browser so they’re here next time; “Clear chat” and “Clear all” delete them. '
    + 'Scanned PDFs without a text layer aren’t supported yet.';
}

// ------------------------------------------------------------------ OneDrive (Microsoft Graph, in the browser)

function showOdError(message) {
  $('qa-od-error').textContent = message || '';
  $('qa-od-error').hidden = !message;
}

async function renderOneDrive() {
  if (!onedrive.isConfigured()) {
    $('qa-od-signin').disabled = true;
    $('qa-od-note').textContent = 'Direct OneDrive sign-in isn’t set up on this site yet. Use a synced folder or a .zip for now.';
    return;
  }
  let account = null;
  try { account = await onedrive.currentAccount(); } catch (e) { showOdError(e.message); }
  $('qa-od-signed-out').hidden = !!account;
  $('qa-od-signed-in').hidden = !account;
  $('qa-od-badge').hidden = !account;
  $('qa-od-account').textContent = account ? `Signed in as ${account.username}` : '';
}

function wireOneDrive() {
  $('qa-od-signin').addEventListener('click', async () => {
    showOdError('');
    $('qa-od-signin').disabled = true;
    try {
      await onedrive.signIn();
    } catch (e) {
      showOdError(e.message);
    } finally {
      $('qa-od-signin').disabled = false;
      renderOneDrive();
    }
  });
  $('qa-od-signout').addEventListener('click', async () => {
    await onedrive.signOut();
    renderOneDrive();
  });
  $('qa-od-signed-in').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (state.busy) return;
    showOdError('');
    const input = $('qa-od-folder').value.trim();
    local.set('localqa.odFolder', input);
    $('qa-od-load').disabled = true;
    try {
      setProgress('Listing OneDrive folders…', 0.05);
      const { files, skipped, truncated } = await onedrive.listFolder(input, {
        isSupported: (n) => engine.isSupported(n) || n.toLowerCase().endsWith('.zip'),
        maxFiles: Math.max(0, engine.LIMITS.maxFiles - state.files.size),
        maxFileBytes: engine.LIMITS.maxFileMb * 1024 * 1024,
        onProgress: ({ folder, found }) => setProgress(`Listing ${folder}/ …`, 0.05, `${found} found`),
      });
      for (const s of skipped) state.failed.push({ name: s.name, folder: s.folder, error: s.reason });
      if (truncated) showStatus(`Only the first ${engine.LIMITS.maxFiles} files were loaded.`, { error: true });
      if (!files.length) {
        $('qa-progress').hidden = true;
        renderFiles();
        showOdError('No PDF, Word or Excel files were found in that folder.');
        return;
      }
      await addFiles(files);
    } catch (e) {
      $('qa-progress').hidden = true;
      showOdError(e.message);
    } finally {
      $('qa-od-load').disabled = false;
    }
  });
  $('qa-od-folder').value = local.get('localqa.odFolder') || '';
}

// ------------------------------------------------------------------ settings

const GROUPS = [
  ['answer', 'Answer', 'Applies to your next question'],
  ['retrieval', 'Retrieval', 'Applies to your next question'],
  ['indexing', 'Indexing', 'Needs a re-index to apply'],
];
const LABELS = {
  temperature: 'Temperature', reasoning_effort: 'Reasoning effort', max_answer_tokens: 'Max answer length',
  answer_style: 'Answer style', history_turns: 'Follow-up memory', strict_grounding: 'Only answer from my documents',
  top_k: 'Passages per answer (top-k)', min_similarity: 'Minimum similarity', diversify: 'Avoid near-duplicate passages',
  mmr_lambda: 'Relevance vs diversity', chunk_strategy: 'Chunking method', chunk_size: 'Chunk size',
  chunk_overlap: 'Chunk overlap', context_mode: 'Answer from',
};
const SUFFIX = { max_answer_tokens: ' tokens', history_turns: ' turns', chunk_size: ' characters', chunk_overlap: ' characters' };
const ENUM_LABELS = {
  concise: 'Concise', detailed: 'Detailed', bullet_points: 'Bullet points', low: 'Low', medium: 'Medium', high: 'High',
  recursive: 'Smart (paragraphs, then sentences)', fixed: 'Fixed size', by_paragraph: 'By paragraph', by_page: 'By page',
  auto: 'Auto (whole documents when they’re small)', passages: 'Best-matching passages', full: 'Whole documents',
};

function defaultSettings() {
  return Object.fromEntries(Object.entries(engine.PARAMS).map(([k, p]) => [k, p.default]));
}
function clamp(key, value) {
  const p = engine.PARAMS[key];
  if (p.type === 'int' || p.type === 'float') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default;
  }
  if (p.type === 'enum') return p.values.includes(value) ? value : p.default;
  return typeof value === 'boolean' ? value : p.default;
}
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(local.get('localqa.settings') || '{}'); } catch (e) { /* ignore */ }
  state.settings = defaultSettings();
  for (const k of Object.keys(state.settings)) if (k in saved) state.settings[k] = clamp(k, saved[k]);
  state.settings.chunk_overlap = Math.min(state.settings.chunk_overlap, Math.floor(state.settings.chunk_size / 2));
}
const saveSettings = () => local.set('localqa.settings', JSON.stringify(state.settings));
const indexingParams = () => ({
  chunk_strategy: state.settings.chunk_strategy, chunk_size: state.settings.chunk_size, chunk_overlap: state.settings.chunk_overlap,
});

function renderSettings() {
  const root = $('qa-settings');
  root.replaceChildren();
  for (const [group, title, note] of GROUPS) {
    const controls = el('div', { class: 'qa-controls' });
    for (const [key, p] of Object.entries(engine.PARAMS)) if (p.group === group) controls.append(renderControl(key, p));
    root.append(el('div', { class: 'qa-group' },
      el('div', { class: 'qa-group-head' }, el('h4', { text: title }), el('span', { class: 'qa-help', text: note })),
      controls));
  }
  updateTemperatureHint();
  updateReindexBanner();
}

function renderControl(key, p) {
  const id = `qa-set-${key}`;
  const help = el('p', { class: 'qa-help', text: p.help });
  const onChange = (v) => {
    state.settings[key] = v;
    if (key === 'chunk_size' && state.settings.chunk_overlap > v / 2) {
      state.settings.chunk_overlap = Math.floor(v / 2 / 10) * 10;
      const ov = $('qa-set-chunk_overlap');
      if (ov) { ov.value = state.settings.chunk_overlap; ov.dispatchEvent(new Event('input')); }
    }
    saveSettings();
    if (p.group === 'indexing') updateReindexBanner();
  };
  if (p.type === 'int' || p.type === 'float') {
    const fmt = (v) => (p.type === 'float' ? Number(v).toFixed(2) : String(v)) + (SUFFIX[key] || '');
    const out = el('output', { for: id, text: fmt(state.settings[key]) });
    const input = el('input', { id, type: 'range', min: p.min, max: p.max, step: p.step });
    input.value = state.settings[key];
    input.addEventListener('input', () => {
      let v = p.type === 'float' ? parseFloat(input.value) : parseInt(input.value, 10);
      if (key === 'chunk_overlap') v = Math.min(v, Math.floor(state.settings.chunk_size / 2));
      input.value = v;
      out.textContent = fmt(v);
      onChange(v);
    });
    const warn = key === 'temperature'
      ? el('p', { class: 'qa-warn', id: 'qa-temp-warn', hidden: true }, icon('info'), el('span')) : null;
    return el('div', { class: 'qa-control' },
      el('div', { class: 'qa-control-top' }, el('label', { class: 'qa-label', for: id, text: LABELS[key] }), out),
      input, help, warn);
  }
  if (p.type === 'enum') {
    const select = el('select', { id, class: 'qa-field' }, p.values.map((v) => el('option', { value: v, text: ENUM_LABELS[v] || v })));
    select.value = state.settings[key];
    select.addEventListener('change', () => onChange(select.value));
    return el('div', { class: 'qa-control' },
      el('div', { class: 'qa-control-top' }, el('label', { class: 'qa-label', for: id, text: LABELS[key] })), select, help);
  }
  const box = el('input', { id, type: 'checkbox' });
  box.checked = !!state.settings[key];
  box.addEventListener('change', () => onChange(box.checked));
  return el('div', { class: 'qa-control' }, el('label', { class: 'qa-check', for: id }, box, LABELS[key]), help);
}

function updateTemperatureHint() {
  const warn = $('qa-temp-warn');
  if (!warn) return;
  const m = model();
  warn.hidden = engine.TEMPERATURE_OK.some((x) => m.startsWith(x));
  warn.querySelector('span').textContent =
    `${m} ignores temperature. Pick claude-haiku-4-5 to use it, or adjust Reasoning effort instead.`;
}

function updateReindexBanner() {
  const changed = state.files.size > 0 && state.indexedWith
    && JSON.stringify(state.indexedWith) !== JSON.stringify(indexingParams());
  $('qa-reindex').hidden = !changed;
  updateAskState();
}

async function reindex() {
  state.busy = true;
  updateAskState();
  const params = indexingParams();
  const files = [...state.files.values()];
  const all = [];
  for (const f of files) {
    const chunks = engine.chunkFile(f.fileId, f, f.parsed, params);
    f.chunks = chunks.length;
    all.push(...chunks);
  }
  try {
    setProgress('Re-indexing…', 0);
    const vectors = await engine.embedPassages(all.map((c) => c.text), (x) => setProgress('Re-indexing…', x));
    state.index.clear();
    state.index.add(all, vectors);
    state.indexedWith = params;
    saveDocuments();
  } catch (e) {
    showStatus(`Re-indexing failed: ${e.message}`, { error: true });
  } finally {
    state.busy = false;
    $('qa-progress').hidden = true;
    renderFiles();
    updateReindexBanner();
  }
}

// ------------------------------------------------------------------ adding files

/** Every source (file picker, folder, drop, OneDrive) becomes {name, folder, size, read}. */
const fromFile = (file, folder) => ({ name: file.name, folder, size: file.size, read: () => file.arrayBuffer() });

function dirname(path) {
  const parts = (path || '').replace(/^\/+/, '').split('/');
  parts.pop();
  return parts.join('/');
}

async function collectDropped(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => fromFile(file, ''));
  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      out.push(fromFile(await new Promise((res, rej) => entry.file(res, rej)), dirname(entry.fullPath)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return out;
}

function setProgress(label, fraction, count = '') {
  $('qa-progress').hidden = false;
  $('qa-progress-label').textContent = label;
  $('qa-progress-count').textContent = count;
  const pct = Math.round(fraction * 100);
  $('qa-progress-bar').setAttribute('aria-valuenow', pct);
  $('qa-progress-bar').firstElementChild.style.width = `${Math.max(pct, 3)}%`;
}

async function addFiles(items) {
  if (!items.length || state.busy) return;
  if (state.files.size && state.indexedWith && JSON.stringify(state.indexedWith) !== JSON.stringify(indexingParams())) {
    showStatus('Re-index your documents (Advanced settings) before adding more, or reset the indexing settings.', { error: true });
    return;
  }
  hideStatus();
  state.busy = true;
  updateAskState();
  try {
    // Expand zips, then drop hidden/lock files and anything unsupported or oversized.
    const queue = [];
    for (const { name, folder, size, read } of items) {
      if (name.startsWith('.') || name.startsWith('~$')) continue;
      if (name.toLowerCase().endsWith('.zip')) {
        if (size > engine.LIMITS.maxZipMb * 1024 * 1024) {
          state.failed.push({ name, folder, error: `zip larger than ${engine.LIMITS.maxZipMb} MB` });
          continue;
        }
        setProgress(`Unpacking ${name}…`, 0);
        try {
          const { entries, skipped } = await engine.expandZip(name, await read());
          for (const e of entries) queue.push({ name: e.name, folder: engine.normalizeFolder([folder, e.folder].filter(Boolean).join('/')), read: async () => e.buffer });
          for (const s of skipped) {
            const parts = s.path.split('/');
            const base = parts.pop();
            state.failed.push({ name: base, folder: engine.normalizeFolder([folder, ...parts].filter(Boolean).join('/')), error: s.reason });
          }
        } catch (e) {
          state.failed.push({ name, folder, error: e.message });
        }
      } else if (!engine.isSupported(name)) {
        state.failed.push({ name, folder, error: 'unsupported file type' });
      } else if (size > engine.LIMITS.maxFileMb * 1024 * 1024) {
        state.failed.push({ name, folder, error: `larger than ${engine.LIMITS.maxFileMb} MB` });
      } else {
        queue.push({ name, folder: engine.normalizeFolder(folder), read });
      }
    }
    const room = engine.LIMITS.maxFiles - state.files.size;
    for (const extra of queue.splice(Math.max(0, room))) {
      state.failed.push({ name: extra.name, folder: extra.folder, error: `file limit reached (${engine.LIMITS.maxFiles})` });
    }
    renderFiles();
    if (!queue.length) return;

    // Load the search model first (a one-time ~34 MB download, cached by the browser after).
    setProgress('Loading the search model (first time only, about 34 MB)…', 0);
    await engine.loadEmbedder((x) => setProgress('Loading the search model (first time only, about 34 MB)…', x));

    const params = indexingParams();
    let done = 0;
    for (const item of queue) {
      const count = `${done + 1} of ${queue.length}`;
      setProgress(`Reading ${item.name}…`, done / queue.length, count);
      try {
        const parsed = await engine.parseFile(item.name, await item.read());
        const fileId = `f${state.nextId++}`;
        const record = { fileId, name: item.name, folder: item.folder, pages: parsed.pages, parsed, status: 'ready' };
        const chunks = engine.chunkFile(fileId, record, parsed, params);
        const vectors = await engine.embedPassages(chunks.map((c) => c.text),
          (x) => setProgress(`Indexing ${item.name}…`, (done + x) / queue.length, count));
        record.chunks = chunks.length;
        state.index.add(chunks, vectors);
        state.files.set(fileId, record);
        state.indexedWith = params;
      } catch (e) {
        state.failed.push({ name: item.name, folder: item.folder, error: e.message || 'could not read file' });
      }
      done += 1;
      renderFiles();
      saveDocuments();
    }
  } catch (e) {
    showStatus(`Couldn’t add those files: ${e.message}. Check your connection (the readers load from a CDN) and try again.`, { error: true });
  } finally {
    state.busy = false;
    $('qa-progress').hidden = true;
    renderFiles();
    updateAskState();
    store.flush();
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describe(f) {
  const sheets = f.parsed.units[0] && f.parsed.units[0].sheet != null
    ? new Set(f.parsed.units.map((u) => u.sheet)).size : 0;
  if (sheets) return `${plural(sheets, 'sheet')} · ${plural(f.parsed.units.length, 'row')} · ${plural(f.chunks, 'chunk')}`;
  if (f.pages) return `${plural(f.pages, 'page')} · ${plural(f.chunks, 'chunk')}`;
  return plural(f.chunks, 'chunk');
}

function renderFiles() {
  const list = $('qa-files');
  const all = [...state.files.values(), ...state.failed.map((f) => ({ ...f, status: 'failed' }))];
  list.replaceChildren();
  const groups = new Map();
  for (const f of all) {
    if (!groups.has(f.folder || '')) groups.set(f.folder || '', []);
    groups.get(f.folder || '').push(f);
  }
  const folders = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const showFolders = folders.length > 1 || folders[0] !== '';
  for (const folder of folders) {
    if (showFolders) list.append(el('li', { class: 'qa-folder-row' }, icon('folder'), folder ? `${folder}/` : 'Top level'));
    for (const f of groups.get(folder).sort((a, b) => a.name.localeCompare(b.name))) {
      const ok = f.status === 'ready';
      const sheet = /\.xls[xm]$/i.test(f.name);
      const errIcon = icon('alert');
      errIcon.style.color = 'var(--red)';
      list.append(el('li', {},
        ok ? icon(sheet ? 'sheet' : 'file') : errIcon,
        el('span', { class: 'qa-name' }, el('strong', { text: f.name }), ok ? null : el('span', { class: 'qa-err', text: f.error })),
        el('span', { class: 'qa-help qa-meta', text: ok ? describe(f) : '—' }),
        el('span', { class: 'qa-file-status' },
          el('span', { class: `qa-badge ${ok ? 'qa-badge-ok' : 'qa-badge-fail'}`, text: ok ? 'Ready' : 'Failed' })),
        el('button', { type: 'button', class: 'qa-icon-btn', 'aria-label': `Remove ${f.name}`, onclick: () => removeFile(f) }, icon('x'))));
    }
  }
  list.hidden = !all.length;
  $('qa-empty').hidden = !!all.length;
  $('qa-clear').hidden = !all.length;
}

function removeFile(f) {
  if (f.status === 'ready') {
    state.files.delete(f.fileId);
    state.index.removeFile(f.fileId);
    if (!state.files.size) state.indexedWith = null;
  } else {
    state.failed = state.failed.filter((x) => !(x.name === f.name && x.folder === f.folder && x.error === f.error));
  }
  renderFiles();
  updateReindexBanner();
  saveDocuments();
}

// ------------------------------------------------------------------ memory (saved in this browser)

function saveDocuments() {
  store.saveSoon(key('documents'), () => ({
    version: 1,
    files: [...state.files.values()],
    failed: state.failed,
    indexedWith: state.indexedWith,
    nextId: state.nextId,
    chunks: state.index.chunks,
    vectors: state.index.vectors,
  }));
}

// The chat is small, so it's written at once on every change (no batching to lose on a reload).
function saveConversation() {
  store.set(key('conversation'), {
    version: 1, records: state.records, history: state.history, messageCount: state.messageCount,
  });
}

function renderTranscript() {
  const transcript = $('qa-transcript');
  transcript.replaceChildren(...state.records.map(renderRecord));
  transcript.hidden = !state.records.length;
  $('qa-clear-chat').hidden = !state.records.length;
}

async function restore() {
  const docs = await store.get(key('documents'));
  if (docs && docs.version === 1 && docs.files && docs.files.length) {
    for (const f of docs.files) state.files.set(f.fileId, f);
    state.failed = docs.failed || [];
    state.indexedWith = docs.indexedWith || null;
    state.nextId = docs.nextId || state.files.size + 1;
    state.index.add(docs.chunks || [], (docs.vectors || []).map((v) => (v instanceof Float32Array ? v : Float32Array.from(v))));
    renderFiles();
    updateReindexBanner();
  }
  const convo = await store.get(key('conversation'));
  if (convo && convo.version === 1 && convo.records && convo.records.length) {
    state.records = convo.records;
    state.history = convo.history || [];
    state.messageCount = convo.messageCount || state.records.length;
  }
  renderFiles();
  renderTranscript();
  updateReindexBanner();
  updateAskState();
}

/** Swaps between the sample workspace and the user's own documents; each keeps its own state. */
const stashed = {};
async function switchMode(mode) {
  if (mode === state.mode || state.busy || state.asking) return;
  store.flush(); // pending saves belong to the workspace being left
  stashed[state.mode] = Object.fromEntries(WS_FIELDS.map((k) => [k, state[k]]));
  const next = stashed[mode];
  Object.assign(state, next || blankWorkspace());
  state.mode = mode;
  local.set('localqa.mode', mode);
  paintMode();
  if (next) {
    renderFiles();
    renderTranscript();
    updateReindexBanner();
    updateAskState();
  } else {
    await restore();
  }
}

function paintMode() {
  const sample = state.mode === 'sample';
  document.querySelectorAll('#qa-sample [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('qa-sample-body').hidden = !sample;
  $('qa-mine-note').hidden = sample;
  $('qa-add-controls').hidden = sample;
  $('qa-empty').textContent = sample ? 'Sample data isn’t loaded yet. Click “Load sample data” above, or just pick a question.' : 'No documents yet.';
  $('qa-transcript').classList.toggle('qa-show-ref', sample && $('qa-show-reference').checked);
}

// ------------------------------------------------------------------ asking

function updateAskState() {
  const needsKey = !readKey();
  const needsReindex = !$('qa-reindex').hidden;
  const ready = state.files.size > 0 && !needsKey && !needsReindex && !state.busy;
  $('qa-question').disabled = !ready;
  $('qa-ask').disabled = !ready || state.asking;
  $('qa-ask-hint').textContent = state.busy ? 'Reading your documents…'
    : !state.files.size ? (state.mode === 'sample' ? 'Pick a suggested question above, or load the sample data to ask your own.' : 'Add at least one document to start asking.')
      : needsKey ? (state.mode === 'sample' ? 'Pick a suggested question above to see a recorded answer, or enter your Claude API key to ask anything.' : 'Enter your Claude API key above to start asking.')
        : needsReindex ? 'Re-index your documents to apply the new indexing settings.'
          : 'Enter to send · Shift+Enter for a new line · Ask for a chart, e.g. “bar chart of revenue by region”';
}

function pushRecord(rec) {
  state.records.push(rec);
  $('qa-clear-chat').hidden = false;
  saveConversation();
}

/** Answers one question against the current documents and returns a chat record, without
 *  touching the page (used by the chat and by the sample-answer recorder). */
async function answerQuestion(question, history, { onText = () => {}, onStage = () => {} } = {}) {
  const s = state.settings;
  const files = [...state.files.values()];
  const id = ++state.messageCount;
  const totalChars = state.index.chunks.reduce((n, c) => n + c.text.length, 0);
  // Whole documents when asked for, or automatically when they're small enough to send in full.
  const full = s.context_mode === 'full' || (s.context_mode === 'auto' && totalChars <= engine.FULL_CONTEXT_CHARS);
  const hits = full ? state.index.chunks.map((chunk) => ({ chunk, score: 1 }))
    : state.index.search(await engine.queryVector(question, history), s);
  // The document list always goes along, so Claude can check every document before saying no.
  const catalog = engine.chartCatalog(files);
  // Every question reaches Claude (with the document list) so a "no" always comes from checking the documents.

  onStage(full ? 'Reading all your documents…' : 'Thinking…');
  let text = '';
  const { system, messages } = engine.buildPrompt(question, hits, history, s, catalog, full);
  const { notes, chart, calcs, usage, stopReason, notFound } = await engine.streamAnswer({
    apiKey: readKey(), workspaceId: readWorkspace(), model: model(), system, messages, settings: s,
    tools: [engine.CHART_TOOL, engine.CALC_TOOL, engine.NOT_FOUND_TOOL],
    onCalculate: (input) => charts.computeTable(input, files),
  }, (delta) => { text += delta; onText(text); });
  if (full) notes.unshift(`Answered from all ${files.length} document${files.length === 1 ? '' : 's'} (whole-documents mode).`);
  // What went into this answer, shown under "About this answer" for checking and diagnosis.
  const meta = {
    model: model(), effort: s.reasoning_effort, mode: full ? 'Whole documents' : 'Best-matching passages',
    documents: files.length, excerpts: hits.length, calculations: calcs.length,
    tokensIn: usage.input, tokensOut: usage.output, stopReason, reply: text,
  };
  const tables = calcs.filter((c) => c.ok).map((c) => c.table);
  const sources = (n) => ({ n, chunk: hits[n - 1].chunk, score: hits[n - 1].score });
  const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
    .filter((n) => n >= 1 && n <= hits.length).sort((a, b) => a - b);
  let rec;
  if (chart) {
    const prepared = charts.prepareChart(chart, files, hits, engine.sourceLabel);
    if (prepared.ok) {
      const refs = [...new Set(prepared.chart.series.flatMap((sr) => sr.refs || []))];
      const shown = [...new Set([...cited, ...refs])].sort((a, b) => a - b).map(sources);
      rec = { role: 'bot', kind: 'chart', id, text, notes, sources: shown, chart: prepared.chart, status: 'proposed', tables, meta };
    } else {
      rec = { role: 'bot', kind: 'answer', id, text, sources: cited.map(sources), tables, meta,
        notes: [...notes, `I couldn’t prepare that chart: ${prepared.error}. Try rephrasing, e.g. name the sheet and columns.`] };
    }
  } else if (notFound || (engine.isNotFound(text) && !tables.length)) {
    const checks = notFound && Array.isArray(notFound.checks)
      ? notFound.checks.filter((c) => c && c.document).map((c) => ({ document: String(c.document), reason: String(c.reason || '') })) : [];
    rec = { role: 'bot', kind: 'notfound', id, checked: full ? files.length : null, passages: !full, meta,
      checks, missing: notFound && notFound.missing ? String(notFound.missing) : '' };
  } else {
    // In whole-documents mode only the passages actually cited are worth listing.
    const shown = cited.length || full ? cited : hits.map((_, i) => i + 1);
    rec = { role: 'bot', kind: 'answer', id, text, notes, sources: shown.map(sources), tables, meta };
  }
  return { rec, text };
}

function historyEntry(rec, text) {
  if (rec.kind === 'chart') {
    return `${text.trim()}\n[Proposed a ${rec.chart.type} chart “${rec.chart.title}” (${rec.chart.sourceLine}); waiting for the user to confirm.]`;
  }
  return rec.kind === 'notfound' ? engine.NOT_FOUND : text.trim() || '(answer)';
}

async function askQuestion(question, { retry = false } = {}) {
  if (!question || state.asking) return;
  state.asking = true;
  updateAskState();
  const transcript = $('qa-transcript');
  transcript.hidden = false;
  if (!retry) {
    const rec = { role: 'user', text: question };
    transcript.append(renderRecord(rec));
    pushRecord(rec);
  }
  $('qa-question').value = '';

  const answerEl = el('div', { class: 'qa-answer qa-streaming' }, el('span', { class: 'qa-typing', text: 'Searching your documents…' }));
  const live = el('div', { class: 'qa-msg-bot' }, answerEl);
  transcript.append(live);
  live.scrollIntoView({ block: 'nearest' });

  const s = state.settings;
  const history = s.history_turns ? state.history.slice(-2 * s.history_turns) : [];
  try {
    const { rec, text } = await answerQuestion(question, history, {
      onStage: (label) => { if (answerEl.firstChild && answerEl.firstChild.className === 'qa-typing') answerEl.firstChild.textContent = label; },
      onText: (soFar) => { answerEl.textContent = soFar; },
    });
    const sample = currentSampleQuestion(question);
    if (sample) rec.sampleId = sample.id;
    live.replaceWith(renderRecord(rec));
    pushRecord(rec);
    state.history.push({ role: 'user', content: question }, { role: 'assistant', content: historyEntry(rec, text) });
    state.history = state.history.slice(-20);
    saveConversation();
    state.asking = false;
    updateAskState();
    $('qa-question').focus();
  } catch (e) {
    live.classList.add('qa-failed');
    answerEl.classList.remove('qa-streaming');
    answerEl.replaceChildren(
      el('p', { class: 'qa-error', text: e.message || 'Something went wrong.' }),
      el('button', { type: 'button', class: 'btn-link', text: 'Try again',
        onclick: () => { live.remove(); askQuestion(question, { retry: true }); } }));
    if (e.code === 'invalid_api_key') $('qa-api-key').focus();
    if (e.code === 'needs_workspace' || e.code === 'bad_workspace') showWorkspaceField(true);
    state.asking = false;
    updateAskState();
  }
}

// ------------------------------------------------------------------ rendering chat records

function renderRecord(rec) {
  if (rec.role === 'user') return el('div', { class: 'qa-msg-user', text: rec.text });
  const bubble = el('div', { class: 'qa-msg-bot' });
  if (rec.kind === 'notfound') {
    bubble.classList.add('qa-notfound');
    bubble.append(el('div', { class: 'qa-answer' }, el('p', {},
      el('strong', { text: engine.NOT_FOUND }), el('br'),
      el('span', { class: 'qa-help', text: rec.checked
        ? `Claude read all ${rec.checked} document${rec.checked === 1 ? '' : 's'} and checked each one.${rec.missing ? ` ${rec.missing}` : ''}`
        : rec.passages ? 'Only the best-matching passages were read. Set “Answer from” to Whole documents (Advanced settings) for a full check.'
          : 'Try rephrasing, lowering “Minimum similarity” in Advanced settings, or adding the file that covers it.' }))));
    if (rec.checks && rec.checks.length) {
      bubble.append(el('div', { class: 'qa-checks' }, el('p', { class: 'qa-label', text: 'How I checked' }),
        el('div', { class: 'qa-table-wrap' }, el('table', { class: 'qa-table' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Document' }), el('th', { scope: 'col', text: 'Why it can’t answer this' }))),
          el('tbody', {}, rec.checks.map((c) => el('tr', {}, el('th', { scope: 'row', text: c.document }), el('td', { text: c.reason }))))))));
    }
    if (rec.recorded) bubble.prepend(el('p', { class: 'qa-recorded', text: `Recorded answer · ${rec.recorded.model} · ${rec.recorded.date}` }));
    appendMeta(bubble, rec);
    appendReference(bubble, rec);
    return bubble;
  }
  const count = rec.sources ? Math.max(0, ...rec.sources.map((x) => x.n)) : 0;
  if (rec.text && rec.text.trim()) bubble.append(el('div', { class: 'qa-answer' }, formatAnswer(rec.text, rec.id, count)));
  for (const note of rec.notes || []) bubble.append(el('p', { class: 'qa-note' }, icon('info'), note));
  if (rec.kind === 'chart') bubble.append(renderChartBlock(rec));
  if (rec.tables && rec.tables.length) bubble.append(renderCalcTables(rec.tables));
  if (rec.sources && rec.sources.length) bubble.append(renderSources(rec.sources, rec.id));
  if (rec.recorded) bubble.prepend(el('p', { class: 'qa-recorded', text: `Recorded answer · ${rec.recorded.model} · ${rec.recorded.date}` }));
  appendMeta(bubble, rec);
  appendReference(bubble, rec);
  return bubble;
}

const fmtInt = (n) => (n || 0).toLocaleString();

function appendMeta(bubble, rec) {
  const m = rec.meta;
  if (!m) return;
  const rows = [
    ['Model', `${m.model} · reasoning effort ${m.effort}`],
    ['Read', `${m.mode}: ${m.excerpts} excerpt${m.excerpts === 1 ? '' : 's'} from ${m.documents} document${m.documents === 1 ? '' : 's'}`],
    ['Calculations', m.calculations ? `${m.calculations} run by the page` : 'None'],
    ['Tokens', `${fmtInt(m.tokensIn)} in · ${fmtInt(m.tokensOut)} out`],
    ['Finished because', m.stopReason || '—'],
  ];
  bubble.append(el('details', { class: 'qa-meta' }, el('summary', { text: 'About this answer' }),
    el('table', { class: 'qa-table qa-table-settings' }, el('tbody', {},
      rows.map(([k, v]) => el('tr', {}, el('th', { scope: 'row', text: k }), el('td', { text: v }))))),
    el('p', { class: 'qa-help', text: 'Claude’s reply, exactly as received:' }),
    el('pre', { class: 'qa-raw', text: m.reply || '(no text)' })));
}

function renderCalcTables(tables) {
  const details = el('details', { class: 'qa-calc' },
    el('summary', { text: `Exact figures calculated by the page (${tables.length} table${tables.length === 1 ? '' : 's'})` }));
  for (const t of tables) {
    const { settings, data } = charts.renderTables(t, { limit: 100 });
    details.append(settings, data);
  }
  return details;
}

function renderChartBlock(rec) {
  const box = el('div', { class: 'qa-chart-block' });
  const { settings, data } = charts.renderTables(rec.chart);
  const replace = () => { box.replaceWith(renderChartBlock(rec)); saveConversation(); };
  if (rec.status === 'proposed') {
    box.append(
      el('p', { class: 'qa-chart-ask' }, el('strong', { text: 'Here’s what I’d plot. ' }),
        'Check the settings and data, then confirm. To change anything, reply in the chat.'),
      settings,
      el('p', { class: 'qa-label qa-table-label', text: `Data to plot (${rec.chart.categories.length} row${rec.chart.categories.length === 1 ? '' : 's'})` }),
      data,
      el('div', { class: 'qa-row qa-row-center qa-chart-confirm' },
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => { rec.status = 'plotted'; replace(); } }, 'Plot chart'),
        el('button', { type: 'button', class: 'btn qa-btn-secondary', onclick: () => { rec.status = 'cancelled'; replace(); } }, 'Cancel')));
  } else if (rec.status === 'plotted') {
    const details = el('details', { class: 'qa-chart-data' }, el('summary', { text: 'Show data table' }), settings, data);
    box.append(charts.renderChart(rec.chart), details);
  } else {
    box.append(el('p', { class: 'qa-help', text: `Chart “${rec.chart.title}” cancelled.` }));
  }
  return box;
}

/** Safe minimal formatting: paragraphs, bullets, **bold**, and [n] citation chips. */
function formatAnswer(text, msgId, sourceCount) {
  const inline = (line) => {
    const out = [];
    const re = /\*\*(.+?)\*\*|\[(\d+)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      if (m[1]) out.push(el('strong', { text: m[1] }));
      else if (Number(m[2]) >= 1 && Number(m[2]) <= sourceCount) {
        out.push(el('a', { class: 'qa-cite', href: `#qa-src-${msgId}-${m[2]}`, text: m[2], 'aria-label': `Source ${m[2]}` }));
      } else out.push(m[0]);
      last = re.lastIndex;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
  return text.trim().split(/\n\s*\n/).flatMap((para) => {
    const lines = para.split('\n');
    // A Markdown table (header row, |---| rule, rows), possibly with a sentence before it.
    const ruleAt = lines.findIndex((l, i) => i > 0 && isRule(l) && lines[i - 1].includes('|'));
    if (ruleAt > 0) {
      const head = cells(lines[ruleAt - 1]);
      const rows = lines.slice(ruleAt + 1).filter((l) => l.includes('|')).map(cells);
      const before = lines.slice(0, ruleAt - 1).join('\n').trim();
      const table = el('div', { class: 'qa-table-wrap qa-answer-table' }, el('table', { class: 'qa-table' },
        el('thead', {}, el('tr', {}, head.map((c) => el('th', { scope: 'col' }, inline(c))))),
        el('tbody', {}, rows.map((r) => el('tr', {}, head.map((_, i) => el('td', {}, inline(r[i] || ''))))))));
      return before ? [el('p', {}, ...inline(before)), table] : [table];
    }
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      return el('ul', {}, lines.map((l) => el('li', {}, inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, '')))));
    }
    const p = el('p');
    lines.forEach((l, i) => { if (i) p.append(el('br')); p.append(...inline(l)); });
    return p;
  });
}

function where(c) {
  if (c.sheet != null) return `sheet “${c.sheet}” · ${c.rowStart === c.rowEnd ? `row ${c.rowStart}` : `rows ${c.rowStart}–${c.rowEnd}`}`;
  if (c.page) return `page ${c.page}`;
  if (c.section) return `“${c.section}”`;
  return '';
}

function renderSources(sources, msgId) {
  const listId = `qa-src-list-${msgId}`;
  const list = el('ol', { id: listId }, sources.map(({ n, chunk, score }) => el('li', { id: `qa-src-${msgId}-${n}` },
    el('span', { class: 'qa-cite', text: String(n) }),
    el('div', {},
      el('div', { class: 'qa-where' },
        chunk.folder ? el('span', { class: 'qa-path', text: `${chunk.folder}/` }) : null,
        chunk.fileName, where(chunk) ? ` · ${where(chunk)}` : '',
        el('span', { class: 'qa-score', text: ` · match ${score.toFixed(2)}` })),
      el('blockquote', { text: chunk.text })))));
  const toggle = el('button', {
    type: 'button', class: 'btn-link', 'aria-expanded': 'true', 'aria-controls': listId,
    onclick: () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      list.hidden = !open;
    },
  }, `Sources (${sources.length})`, icon('down', 'qa-chevron'));
  return el('div', { class: 'qa-sources' }, toggle, list);
}

// ------------------------------------------------------------------ sample data

const SAMPLE_BASE = new URL('samples/', import.meta.url).href;
const sample = { manifest: null, recorded: null, buffers: new Map() };
const sampleUrl = (path) => SAMPLE_BASE + path.split('/').map(encodeURIComponent).join('/');

async function loadManifest() {
  try {
    sample.manifest = await (await fetch(SAMPLE_BASE + 'manifest.json')).json();
  } catch (e) {
    $('qa-sample').hidden = true; // no sample pack published: hide the section
    return;
  }
  try {
    const res = await fetch(SAMPLE_BASE + 'recorded.json', { cache: 'no-cache' });
    if (res.ok) sample.recorded = await res.json();
  } catch (e) { /* no recordings yet */ }
  renderSampleFiles();
  renderSampleQuestions();
}

function renderSampleFiles() {
  const m = sample.manifest;
  $('qa-sample-intro').textContent = `No files needed: explore the tool with documents from ${m.company}. ${m.note} Preview what’s inside, then click a question.`;
  $('qa-sample-files').replaceChildren(...m.files.map((f) => el('li', {},
    icon(f.kind === 'xlsx' ? 'sheet' : 'file'),
    el('div', { class: 'qa-grow' },
      el('strong', { text: f.title }),
      el('span', { class: 'qa-help', text: `${f.folder}/${f.name}` }),
      el('span', { class: 'qa-help', text: f.description }),
      el('div', { class: 'qa-file-actions' },
        el('button', { type: 'button', class: 'btn-link', onclick: () => previewSample(f) }, 'Preview'),
        el('a', { href: sampleUrl(f.path), download: f.name }, 'Download'))))));
}

function renderSampleQuestions() {
  const groups = new Map();
  for (const q of sample.manifest.questions) {
    if (!groups.has(q.group)) groups.set(q.group, []);
    groups.get(q.group).push(q);
  }
  const recorded = (q) => sample.recorded && sample.recorded.answers && sample.recorded.answers[q.id];
  $('qa-sample-questions').replaceChildren(
    el('p', { class: 'qa-label', text: 'Try asking' }),
    ...[...groups].map(([group, qs]) => el('div', { class: 'qa-q-group' }, el('span', { text: group }),
      qs.map((q) => el('button', { type: 'button', class: 'qa-chip-q', title: recorded(q) ? 'A recorded answer is available' : '',
        onclick: () => askSample(q) }, recorded(q) ? el('span', { class: 'qa-rec-dot', 'aria-hidden': 'true' }) : null, q.text)))),
    sample.recorded ? el('p', { class: 'qa-help' }, el('span', { class: 'qa-rec-dot', 'aria-hidden': 'true' }),
      `Green dot: a recorded answer (${sample.recorded.model}, ${sample.recorded.date}) shows instantly without an API key. With a key, questions are answered live.`) : null);
}

async function sampleBuffer(f) {
  if (!sample.buffers.has(f.path)) {
    const res = await fetch(sampleUrl(f.path));
    if (!res.ok) throw new Error(`couldn’t download ${f.name}`);
    sample.buffers.set(f.path, await res.arrayBuffer());
  }
  return sample.buffers.get(f.path).slice(0); // parsers may detach the buffer
}

async function previewSample(f) {
  const dlg = $('qa-preview');
  $('qa-preview-title').textContent = `${f.title} · ${f.name}`;
  const body = $('qa-preview-body');
  body.replaceChildren(el('p', { class: 'qa-help', text: 'Loading…' }));
  if (!dlg.open) dlg.showModal();
  try {
    const parsed = await engine.parseFile(f.name, await sampleBuffer(f));
    const blocks = [];
    if (parsed.tables && parsed.tables.length) {
      for (const t of parsed.tables) {
        const show = t.rows.slice(0, 15);
        blocks.push(el('h4', { text: `Sheet “${t.sheet}” · ${t.rows.length} rows` }), el('div', { class: 'qa-table-wrap' }, el('table', { class: 'qa-table' },
          el('thead', {}, el('tr', {}, t.headers.map((hd) => el('th', { scope: 'col', text: hd })))),
          el('tbody', {}, show.map((r) => el('tr', {}, t.headers.map((hd) => el('td', { text: r.values[hd] == null ? '' : String(r.values[hd]) }))))))));
        if (t.rows.length > show.length) blocks.push(el('p', { class: 'qa-help', text: `…and ${t.rows.length - show.length} more rows.` }));
      }
    } else if (parsed.pages) {
      for (const u of parsed.units) blocks.push(el('div', { class: 'qa-preview-page' }, el('h4', { text: `Page ${u.page}` }), el('p', { text: u.text })));
    } else {
      for (const u of parsed.units) blocks.push(el('h4', { text: u.section || 'Introduction' }), el('p', { text: u.text }));
    }
    body.replaceChildren(...blocks);
  } catch (e) {
    body.replaceChildren(el('p', { class: 'qa-error', text: `Couldn’t preview this file: ${e.message}` }));
  }
}

async function loadSamples() {
  if (state.mode !== 'sample') await switchMode('sample');
  const have = new Set([...state.files.values()].map((f) => `${f.folder}/${f.name}`));
  const missing = sample.manifest.files.filter((f) => !have.has(`${f.folder}/${f.name}`));
  if (!missing.length) { $('qa-sample-status').textContent = 'Sample data is loaded.'; return; }
  $('qa-sample-status').textContent = 'Loading sample data…';
  await addFiles(missing.map((f) => ({ name: f.name, folder: f.folder, size: 0, read: () => sampleBuffer(f) })));
  $('qa-sample-status').textContent = state.files.size ? 'Sample data is loaded. Ask anything below.' : 'Couldn’t load the sample data.';
}

function currentSampleQuestion(text) {
  if (state.mode !== 'sample' || !sample.manifest) return null;
  return sample.manifest.questions.find((q) => q.text.trim().toLowerCase() === text.trim().toLowerCase()) || null;
}

async function askSample(q) {
  if (state.mode !== 'sample') await switchMode('sample');
  if (state.asking || state.busy) return;
  const rec = sample.recorded && sample.recorded.answers && sample.recorded.answers[q.id];
  if (readKey()) {
    if (!state.files.size) await loadSamples();
    if (state.files.size) return askQuestion(q.text);
  }
  if (rec) return showRecorded(q, rec);
  showStatus('Enter your Claude API key above to ask this question live; recorded answers aren’t available yet.', { error: true });
  $('qa-api-key').focus();
}

function showRecorded(q, saved) {
  const user = { role: 'user', text: q.text };
  const bot = { ...JSON.parse(JSON.stringify(saved)), id: ++state.messageCount, sampleId: q.id,
    recorded: { model: sample.recorded.model, date: sample.recorded.date } };
  const transcript = $('qa-transcript');
  transcript.hidden = false;
  transcript.append(renderRecord(user), renderRecord(bot));
  pushRecord(user);
  pushRecord(bot);
  state.history.push({ role: 'user', content: q.text }, { role: 'assistant', content: historyEntry(bot, bot.text || '') });
  state.history = state.history.slice(-20);
  saveConversation();
  transcript.lastElementChild.scrollIntoView({ block: 'nearest' });
}

function appendReference(bubble, rec) {
  const q = rec.sampleId && sample.manifest && sample.manifest.questions.find((x) => x.id === rec.sampleId);
  if (q) bubble.append(el('div', { class: 'qa-reference' }, el('strong', { text: 'Reference answer (answer key)' }), q.reference));
}

/** Runs every sample question live and downloads the answers as recorded.json (owner tool, ?record=1). */
async function recordSamples() {
  const status = $('qa-record-status');
  if (!readKey()) { status.textContent = 'Enter your API key first.'; return; }
  if (state.mode !== 'sample') await switchMode('sample');
  if (!state.files.size) await loadSamples();
  if (!state.files.size) { status.textContent = 'Couldn’t load the sample data.'; return; }
  const answers = {};
  const qs = sample.manifest.questions;
  $('qa-record').disabled = true;
  try {
    for (const [i, q] of qs.entries()) {
      status.textContent = `Recording ${i + 1} of ${qs.length}: ${q.text}`;
      const { rec } = await answerQuestion(q.text, []);
      answers[q.id] = { ...rec, sampleId: q.id };
    }
    const out = { model: model(), date: new Date().toISOString().slice(0, 10), settings: state.settings, answers };
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' })), download: 'recorded.json' });
    document.body.append(a);
    a.click();
    a.remove();
    status.textContent = `Done: ${qs.length} answers recorded. Put recorded.json in local-qa/samples/ and publish.`;
  } catch (e) {
    status.textContent = `Recording stopped: ${e.message}`;
  } finally {
    $('qa-record').disabled = false;
  }
}

function wireSamples() {
  document.querySelectorAll('#qa-sample [data-mode]').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  $('qa-sample-load').addEventListener('click', loadSamples);
  $('qa-preview-close').addEventListener('click', () => $('qa-preview').close());
  $('qa-preview').addEventListener('click', (e) => { if (e.target === $('qa-preview')) $('qa-preview').close(); });
  $('qa-show-reference').checked = local.get('localqa.showReference') === '1';
  $('qa-show-reference').addEventListener('change', (e) => {
    local.set('localqa.showReference', e.target.checked ? '1' : null);
    paintMode();
  });
  $('qa-recorder').hidden = new URLSearchParams(location.search).get('record') !== '1';
  $('qa-record').addEventListener('click', recordSamples);
}

// ------------------------------------------------------------------ start (last, so every helper above is defined)

wire();
wireOneDrive();
renderOneDrive();
loadSettings();
renderKey();
renderSettings();
wireSamples();
(async () => {
  // First visit (no saved documents of their own): open on the sample data.
  const saved = local.get('localqa.mode');
  state.mode = saved === 'sample' || saved === 'mine' ? saved : ((await store.get('documents')) ? 'mine' : 'sample');
  paintMode();
  await restore();
  await loadManifest();
})();
