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
};

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
    store.remove('documents');
  });
  $('qa-clear-chat').addEventListener('click', () => {
    state.records = [];
    state.history = [];
    $('qa-transcript').replaceChildren();
    $('qa-transcript').hidden = true;
    $('qa-clear-chat').hidden = true;
    store.remove('conversation');
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
  chunk_overlap: 'Chunk overlap',
};
const SUFFIX = { max_answer_tokens: ' tokens', history_turns: ' turns', chunk_size: ' characters', chunk_overlap: ' characters' };
const ENUM_LABELS = {
  concise: 'Concise', detailed: 'Detailed', bullet_points: 'Bullet points', low: 'Low', medium: 'Medium', high: 'High',
  recursive: 'Smart (paragraphs, then sentences)', fixed: 'Fixed size', by_paragraph: 'By paragraph', by_page: 'By page',
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
  store.saveSoon('documents', () => ({
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
  store.set('conversation', {
    version: 1, records: state.records, history: state.history, messageCount: state.messageCount,
  });
}

async function restore() {
  const docs = await store.get('documents');
  if (docs && docs.version === 1 && docs.files && docs.files.length) {
    for (const f of docs.files) state.files.set(f.fileId, f);
    state.failed = docs.failed || [];
    state.indexedWith = docs.indexedWith || null;
    state.nextId = docs.nextId || state.files.size + 1;
    state.index.add(docs.chunks || [], (docs.vectors || []).map((v) => (v instanceof Float32Array ? v : Float32Array.from(v))));
    renderFiles();
    updateReindexBanner();
  }
  const convo = await store.get('conversation');
  if (convo && convo.version === 1 && convo.records && convo.records.length) {
    state.records = convo.records;
    state.history = convo.history || [];
    state.messageCount = convo.messageCount || state.records.length;
    const transcript = $('qa-transcript');
    transcript.hidden = false;
    for (const rec of state.records) transcript.append(renderRecord(rec));
    $('qa-clear-chat').hidden = false;
  }
  updateAskState();
}

// ------------------------------------------------------------------ asking

function updateAskState() {
  const needsKey = !readKey();
  const needsReindex = !$('qa-reindex').hidden;
  const ready = state.files.size > 0 && !needsKey && !needsReindex && !state.busy;
  $('qa-question').disabled = !ready;
  $('qa-ask').disabled = !ready || state.asking;
  $('qa-ask-hint').textContent = state.busy ? 'Reading your documents…'
    : !state.files.size ? 'Add at least one document to start asking.'
      : needsKey ? 'Enter your Claude API key above to start asking.'
        : needsReindex ? 'Re-index your documents to apply the new indexing settings.'
          : 'Enter to send · Shift+Enter for a new line · Ask for a chart, e.g. “bar chart of revenue by region”';
}

function pushRecord(rec) {
  state.records.push(rec);
  $('qa-clear-chat').hidden = false;
  saveConversation();
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

  const id = ++state.messageCount;
  const answerEl = el('div', { class: 'qa-answer qa-streaming' }, el('span', { class: 'qa-typing', text: 'Searching your documents…' }));
  const live = el('div', { class: 'qa-msg-bot' }, answerEl);
  transcript.append(live);
  live.scrollIntoView({ block: 'nearest' });

  const s = state.settings;
  const history = s.history_turns ? state.history.slice(-2 * s.history_turns) : [];
  const files = [...state.files.values()];
  let text = '';
  try {
    const q = await engine.queryVector(question, history);
    const hits = state.index.search(q, s);
    // Chart requests may need a spreadsheet even when no passage matches the wording.
    // Chart requests always go to Claude: a chart can come from a spreadsheet or from the documents
    // themselves (e.g. words per page) even when no passage matches the wording.
    const wantsChart = engine.CHART_WORDS.test(question);
    const catalog = wantsChart ? engine.chartCatalog(files) : '';
    let rec;
    if (!hits.length && !wantsChart) {
      rec = { role: 'bot', kind: 'notfound', id };
    } else {
      answerEl.firstChild.textContent = 'Thinking…';
      const { system, messages } = engine.buildPrompt(question, hits, history, s, catalog);
      const { notes, chart } = await engine.streamAnswer({
        apiKey: readKey(), workspaceId: readWorkspace(), model: model(), system, messages, settings: s,
        tools: [engine.CHART_TOOL],
      }, (delta) => {
        if (!text) answerEl.replaceChildren();
        text += delta;
        answerEl.textContent = text;
      });
      const sources = (n) => ({ n, chunk: hits[n - 1].chunk, score: hits[n - 1].score });
      const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
        .filter((n) => n >= 1 && n <= hits.length).sort((a, b) => a - b);
      if (chart) {
        const prepared = charts.prepareChart(chart, files, hits, engine.sourceLabel);
        if (prepared.ok) {
          const refs = [...new Set(prepared.chart.series.flatMap((sr) => sr.refs || []))];
          const shown = [...new Set([...cited, ...refs])].sort((a, b) => a - b).map(sources);
          rec = { role: 'bot', kind: 'chart', id, text, notes, sources: shown, chart: prepared.chart, status: 'proposed' };
        } else {
          rec = { role: 'bot', kind: 'answer', id, text, sources: cited.map(sources),
            notes: [...notes, `I couldn’t prepare that chart: ${prepared.error}. Try rephrasing, e.g. name the sheet and columns.`] };
        }
      } else if (engine.isNotFound(text)) {
        rec = { role: 'bot', kind: 'notfound', id };
      } else {
        rec = { role: 'bot', kind: 'answer', id, text, notes, sources: (cited.length ? cited : hits.map((_, i) => i + 1)).map(sources) };
      }
    }
    live.replaceWith(renderRecord(rec));
    pushRecord(rec);
    const summary = rec.kind === 'chart'
      ? `${text.trim()}\n[Proposed a ${rec.chart.type} chart “${rec.chart.title}” (${rec.chart.sourceLine}); waiting for the user to confirm.]`
      : rec.kind === 'notfound' ? engine.NOT_FOUND : text;
    state.history.push({ role: 'user', content: question }, { role: 'assistant', content: summary.trim() || '(chart proposal)' });
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
      el('span', { class: 'qa-help', text: 'Try rephrasing, lowering “Minimum similarity” in Advanced settings, or adding the file that covers it.' }))));
    return bubble;
  }
  const count = rec.sources ? Math.max(0, ...rec.sources.map((x) => x.n)) : 0;
  if (rec.text && rec.text.trim()) bubble.append(el('div', { class: 'qa-answer' }, formatAnswer(rec.text, rec.id, count)));
  for (const note of rec.notes || []) bubble.append(el('p', { class: 'qa-note' }, icon('info'), note));
  if (rec.kind === 'chart') bubble.append(renderChartBlock(rec));
  if (rec.sources && rec.sources.length) bubble.append(renderSources(rec.sources, rec.id));
  return bubble;
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

// ------------------------------------------------------------------ start (last, so every helper above is defined)

wire();
wireOneDrive();
renderOneDrive();
loadSettings();
renderKey();
renderSettings();
renderFiles();
updateAskState();
restore();
