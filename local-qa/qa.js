// Local Q&A: passcode gate, document upload, cited chat answers, and the settings panel.
import * as api from './qa-api.js';

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

// Claude models that still honour temperature (mirrors the backend's Anthropic adapter).
const TEMPERATURE_OK = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5',
  'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-sonnet-4-0'];
const KEY_LINKS = {
  anthropic: 'sk-ant-…', openai: 'sk-…', gemini: 'AIza…', openai_compatible: 'Your provider’s API key',
};
const UPLOAD_BATCH_FILES = 4;
const UPLOAD_BATCH_BYTES = 15 * 1024 * 1024;

const state = {
  config: null,
  sessionId: null,
  files: new Map(), // file_id -> result from /ingest
  failed: [], // failed results, kept for display
  history: [], // [{role, content}]
  settings: {}, // user-facing params (answer, retrieval, indexing)
  indexedWith: null, // indexing params the current documents were indexed with
  useOwnKey: false, // "both" mode: the user switched to their own key
  busy: false,
  messageCount: 0,
};

// ------------------------------------------------------------------ boot

api.onSlowRequest((slow) => {
  if (slow) showStatus('Waking the server up. The first request after a quiet spell can take up to a minute…');
  else if ($('qa-status').dataset.kind === 'info') hideStatus();
});

boot();

async function boot() {
  wireStaticHandlers();
  if (!api.session.get('localqa.token')) return showLock();
  try {
    await start();
  } catch (e) {
    handleError(e, boot);
  }
}

async function start() {
  state.config = await api.getConfig();
  loadSettings();
  await ensureSession();
  renderKeys();
  renderSettings();
  renderFiles();
  updateAskState();
  $('qa-lock').hidden = true;
  $('qa-app').hidden = false;
  const limits = state.config.limits;
  $('qa-limits').textContent = `.pdf, .docx, .xlsx and .zip · up to ${limits.max_file_mb} MB per file `
    + `(${limits.max_zip_mb} MB per zip) · ${limits.max_files} files per session`;
}

async function ensureSession(forceNew = false) {
  let id = forceNew ? null : api.session.get('localqa.session');
  if (!id) {
    id = (await api.newSession()).session_id;
    api.session.set('localqa.session', id);
  }
  state.sessionId = id;
}

function showLock(message) {
  $('qa-app').hidden = true;
  $('qa-lock').hidden = false;
  const err = $('qa-lock-error');
  err.hidden = !message;
  err.textContent = message || '';
}

function showStatus(text, { error = false, retry = null } = {}) {
  const box = $('qa-status');
  box.replaceChildren(text);
  box.dataset.kind = error ? 'error' : 'info';
  box.classList.toggle('qa-banner-error', error);
  if (retry) box.append(el('button', { type: 'button', class: 'btn-link', text: 'Try again', onclick: () => { hideStatus(); retry(); } }));
  box.hidden = false;
}

function hideStatus() {
  $('qa-status').hidden = true;
  $('qa-status').dataset.kind = '';
}

/** Central handling for errors every call can hit; returns true if handled. */
function handleError(e, retry) {
  if (!(e instanceof api.ApiError)) {
    showStatus(`Something went wrong: ${e.message}`, { error: true, retry });
    return true;
  }
  if (e.code === 'locked') {
    api.session.set('localqa.token', null);
    showLock(state.config ? 'Your unlock expired. Enter the passcode again.' : null);
    return true;
  }
  if (e.code === 'session_expired') {
    state.files.clear();
    state.failed = [];
    state.indexedWith = null;
    renderFiles();
    updateAskState();
    ensureSession(true).catch((err) => handleError(err));
    showStatus('The server restarted and your documents were cleared. Please add them again.', { error: true });
    return true;
  }
  if (e.code === 'unreachable') {
    showStatus(e.message, { error: true, retry });
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ static wiring

function wireStaticHandlers() {
  $('qa-lock').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('qa-unlock');
    btn.disabled = true;
    try {
      await api.unlock($('qa-passcode').value);
      $('qa-passcode').value = '';
      await start();
    } catch (e) {
      if (e instanceof api.ApiError && ['wrong_passcode', 'rate_limited', 'not_configured'].includes(e.code)) showLock(e.message);
      else if (!handleError(e)) showLock(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Uploads: file picker, folder picker, drag and drop.
  $('qa-file-input').addEventListener('change', (ev) => {
    upload([...ev.target.files].map((file) => ({ file, folder: '' })));
    ev.target.value = '';
  });
  $('qa-folder-input').addEventListener('change', (ev) => {
    upload([...ev.target.files].map((file) => ({ file, folder: dirname(file.webkitRelativePath) })));
    ev.target.value = '';
  });
  const drop = $('qa-drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => {
    ev.preventDefault();
    drop.classList.add('qa-dragover');
  }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('qa-dragover')));
  drop.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    upload(await collectDropped(ev.dataTransfer));
  });

  $('qa-clear').addEventListener('click', async () => {
    try {
      await api.clearDocuments(state.sessionId);
      state.files.clear();
      state.failed = [];
      state.indexedWith = null;
      renderFiles();
      updateAskState();
    } catch (e) {
      if (!handleError(e)) showStatus(e.message, { error: true });
    }
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
  $('qa-reindex-btn').addEventListener('click', doReindex);

  // Own-key panel ("user" and "both" modes).
  $('qa-own-key-toggle').addEventListener('click', () => {
    state.useOwnKey = !state.useOwnKey;
    renderKeys();
  });
  $('qa-provider').addEventListener('change', () => {
    const llm = loadLlm();
    llm.provider = $('qa-provider').value;
    llm.model = (state.config.params.model.suggestions[llm.provider] || [''])[0] || '';
    saveLlm(llm);
    renderKeys();
  });
  ['qa-model', 'qa-base-url'].forEach((id) => $(id).addEventListener('input', () => {
    saveLlm({ ...loadLlm(), model: $('qa-model').value.trim(), base_url: $('qa-base-url').value.trim() });
    updateTemperatureHint();
    updateAskState();
  }));
  $('qa-api-key').addEventListener('input', () => { storeKey($('qa-api-key').value.trim()); updateAskState(); });
  $('qa-remember-key').addEventListener('change', () => storeKey(readKey()));
  $('qa-forget-key').addEventListener('click', () => {
    api.session.set('localqa.apiKey', null);
    api.local.set('localqa.apiKey', null);
    $('qa-api-key').value = '';
    $('qa-key-status').textContent = 'Key forgotten.';
    updateAskState();
  });
  $('qa-test-key').addEventListener('click', async () => {
    const status = $('qa-key-status');
    status.textContent = 'Testing…';
    try {
      await api.testKey(llmBody(), readKey());
      status.textContent = '✓ Key works';
    } catch (e) {
      if (!handleError(e)) status.textContent = e.message;
      else status.textContent = '';
    }
  });
  $('qa-server-model').addEventListener('change', () => {
    api.local.set('localqa.serverModel', $('qa-server-model').value);
    updateTemperatureHint();
  });
}

// ------------------------------------------------------------------ keys and models

function usingServerKey() {
  const keys = state.config.keys;
  if (keys.mode === 'server') return true;
  if (keys.mode === 'user') return false;
  return !state.useOwnKey;
}

function loadLlm() {
  let saved = {};
  try { saved = JSON.parse(api.local.get('localqa.llm') || '{}'); } catch (e) { /* ignore */ }
  const provider = saved.provider || state.config.params.provider.default;
  return { provider, model: saved.model ?? state.config.params.model.default, base_url: saved.base_url || '' };
}
function saveLlm(llm) { api.local.set('localqa.llm', JSON.stringify(llm)); }
function readKey() { return api.session.get('localqa.apiKey') || api.local.get('localqa.apiKey') || ''; }
function storeKey(key) {
  const remember = $('qa-remember-key').checked;
  api.session.set('localqa.apiKey', remember ? null : key || null);
  api.local.set('localqa.apiKey', remember ? key || null : null);
}

function llmBody() {
  if (usingServerKey()) return { provider: 'anthropic', model: $('qa-server-model').value, base_url: '' };
  const llm = loadLlm();
  return { provider: llm.provider, model: llm.model, base_url: llm.provider === 'openai_compatible' ? llm.base_url : '' };
}

function renderKeys() {
  const keys = state.config.keys;
  const server = usingServerKey();
  const select = $('qa-server-model');
  if (!select.options.length) {
    keys.server_models.forEach((m) => select.append(el('option', { value: m, text: m })));
    const saved = api.local.get('localqa.serverModel');
    if (saved && keys.server_models.includes(saved)) select.value = saved;
  }

  $('qa-own-key-toggle').hidden = keys.mode !== 'both';
  $('qa-own-key-toggle').textContent = state.useOwnKey ? 'Use this site’s key' : 'Use my own key';
  $('qa-server-model-wrap').hidden = !server;
  $('qa-key-panel').hidden = server;

  if (server) {
    $('qa-model-title').textContent = keys.server_key ? 'Claude, on this site’s API key'
      : 'This site’s API key isn’t configured yet';
    renderQuota(keys.daily_remaining);
  } else {
    const llm = loadLlm();
    $('qa-model-title').textContent = 'Your own API key';
    $('qa-model-sub').textContent = 'Set the provider, model and key below.';
    $('qa-provider').value = llm.provider;
    [...$('qa-provider').options].forEach((o) => { o.hidden = !state.config.params.provider.values.includes(o.value); });
    $('qa-model').value = llm.model;
    $('qa-model').placeholder = `Model name, as ${$('qa-provider').selectedOptions[0].text} spells it`;
    $('qa-model-suggestions').replaceChildren(
      ...(state.config.params.model.suggestions[llm.provider] || []).map((m) => el('option', { value: m })));
    $('qa-base-url-wrap').hidden = llm.provider !== 'openai_compatible';
    $('qa-base-url').value = llm.base_url;
    $('qa-api-key').placeholder = KEY_LINKS[llm.provider];
    $('qa-api-key').value = readKey();
    $('qa-remember-key').checked = !!api.local.get('localqa.apiKey');
  }
  $('qa-privacy').textContent = server
    ? 'Answers use this site’s Claude API key, so you don’t need one. Only the passages relevant to a question are sent to Anthropic. Documents stay in memory for this session and are deleted after an hour of inactivity. Scanned PDFs without a text layer aren’t supported yet.'
    : 'Only the passages relevant to a question are sent to the provider you picked. Documents stay in memory for this session and are deleted after an hour of inactivity. Scanned PDFs without a text layer aren’t supported yet.';
  updateTemperatureHint();
  updateAskState();
}

function renderQuota(remaining) {
  if (!usingServerKey()) return;
  const keys = state.config.keys;
  $('qa-model-sub').textContent = remaining == null ? 'No key needed'
    : `No key needed · ${remaining} question${remaining === 1 ? '' : 's'} left today`;
  keys.daily_remaining = remaining;
}

// ------------------------------------------------------------------ settings

const SETTING_GROUPS = [
  ['answer', 'Answer', 'Applies to your next question'],
  ['retrieval', 'Retrieval', 'Applies to your next question'],
  ['indexing', 'Indexing', 'Needs a re-index to apply'],
];
const HIDDEN_PARAMS = ['provider', 'model', 'base_url'];
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

function params() { return state.config.params; }
function defaultSettings() {
  const out = {};
  for (const [k, p] of Object.entries(params())) if (!HIDDEN_PARAMS.includes(k)) out[k] = p.default;
  return out;
}
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(api.local.get('localqa.settings') || '{}'); } catch (e) { /* ignore */ }
  state.settings = { ...defaultSettings() };
  for (const k of Object.keys(state.settings)) if (k in saved) state.settings[k] = saved[k];
}
function saveSettings() { api.local.set('localqa.settings', JSON.stringify(state.settings)); }
function indexingParams() {
  const out = {};
  for (const [k, p] of Object.entries(params())) if (p.group === 'indexing') out[k] = state.settings[k];
  return out;
}

function renderSettings() {
  const root = $('qa-settings');
  root.replaceChildren();
  for (const [group, title, note] of SETTING_GROUPS) {
    const controls = el('div', { class: 'qa-controls' });
    for (const [key, p] of Object.entries(params())) {
      if (p.group !== group || HIDDEN_PARAMS.includes(key)) continue;
      controls.append(renderControl(key, p));
    }
    root.append(el('div', { class: 'qa-group' },
      el('div', { class: 'qa-group-head' }, el('h4', { text: title }), el('span', { class: 'qa-help', text: note })),
      controls));
  }
  updateTemperatureHint();
  updateReindexBanner();
}

function renderControl(key, p) {
  const id = `qa-set-${key}`;
  const value = state.settings[key];
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
    const out = el('output', { for: id, text: fmt(value) });
    const input = el('input', { id, type: 'range', min: p.min, max: key === 'chunk_overlap' ? 1000 : p.max, step: p.step });
    input.value = value;
    input.addEventListener('input', () => {
      let v = p.type === 'float' ? parseFloat(input.value) : parseInt(input.value, 10);
      if (key === 'chunk_overlap') v = Math.min(v, Math.floor(state.settings.chunk_size / 2));
      input.value = v;
      out.textContent = fmt(v);
      onChange(v);
    });
    const extra = key === 'temperature'
      ? el('p', { class: 'qa-warn', id: 'qa-temp-warn', hidden: true }, icon('info'), el('span')) : null;
    return el('div', { class: 'qa-control' },
      el('div', { class: 'qa-control-top' }, el('label', { class: 'qa-label', for: id, text: LABELS[key] || key }), out),
      input, help, extra);
  }
  if (p.type === 'enum') {
    const select = el('select', { id, class: 'qa-field' },
      p.values.map((v) => el('option', { value: v, text: ENUM_LABELS[v] || v })));
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return el('div', { class: 'qa-control' },
      el('div', { class: 'qa-control-top' }, el('label', { class: 'qa-label', for: id, text: LABELS[key] || key })),
      select, help);
  }
  const box = el('input', { id, type: 'checkbox' });
  box.checked = !!value;
  box.addEventListener('change', () => onChange(box.checked));
  return el('div', { class: 'qa-control' },
    el('label', { class: 'qa-check', for: id }, box, LABELS[key] || key), help);
}

function updateTemperatureHint() {
  const warn = $('qa-temp-warn');
  if (!warn || !state.config) return;
  const { provider, model } = llmBody();
  const ignored = provider === 'anthropic' && model && !TEMPERATURE_OK.some((m) => model.startsWith(m));
  warn.hidden = !ignored;
  warn.querySelector('span').textContent =
    `${model} ignores temperature. Pick claude-haiku-4-5 to use it, or adjust Reasoning effort instead.`;
}

function updateReindexBanner() {
  const changed = state.files.size > 0 && state.indexedWith
    && JSON.stringify(state.indexedWith) !== JSON.stringify(indexingParams());
  $('qa-reindex').hidden = !changed;
  updateAskState();
}

async function doReindex() {
  const btn = $('qa-reindex-btn');
  btn.disabled = true;
  btn.textContent = 'Re-indexing…';
  try {
    const res = await api.reindex(state.sessionId, indexingParams());
    res.files.forEach((f) => state.files.set(f.file_id, f));
    state.indexedWith = indexingParams();
    renderFiles();
    updateReindexBanner();
  } catch (e) {
    if (!handleError(e, doReindex)) showStatus(e.message, { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-index now';
  }
}

// ------------------------------------------------------------------ uploads

function dirname(path) {
  const parts = (path || '').replace(/^\/+/, '').split('/');
  parts.pop();
  return parts.join('/');
}

async function collectDropped(dataTransfer) {
  const entries = [...dataTransfer.items]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, folder: '' }));
  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, folder: dirname(entry.fullPath) });
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

async function upload(items) {
  if (!items.length || !state.config) return;
  const { limits } = state.config;
  const accepted = [];
  for (const item of items) {
    const name = item.file.name;
    const lower = name.toLowerCase();
    if (name.startsWith('.') || name.startsWith('~$')) continue; // hidden and Office lock files
    const isZip = lower.endsWith('.zip');
    if (!limits.allowed_extensions.some((ext) => lower.endsWith(ext))) {
      state.failed.push({ name, folder: item.folder, status: 'failed', error: 'unsupported file type' });
    } else if (item.file.size > (isZip ? limits.max_zip_mb : limits.max_file_mb) * 1024 * 1024) {
      state.failed.push({ name, folder: item.folder, status: 'failed',
        error: `larger than ${isZip ? limits.max_zip_mb : limits.max_file_mb} MB` });
    } else {
      accepted.push(item);
    }
  }
  renderFiles();
  if (!accepted.length) return;
  if (state.files.size && state.indexedWith
      && JSON.stringify(state.indexedWith) !== JSON.stringify(indexingParams())) {
    showStatus('Re-index your documents (Advanced settings) before adding more, or reset the indexing settings.', { error: true });
    return;
  }

  const batches = [];
  let current = [];
  let bytes = 0;
  for (const item of accepted) {
    const big = item.file.name.toLowerCase().endsWith('.zip');
    if (current.length && (big || current.length >= UPLOAD_BATCH_FILES || bytes + item.file.size > UPLOAD_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.file.size;
  }
  if (current.length) batches.push(current);

  state.busy = true;
  updateAskState();
  let done = 0;
  setProgress(0, accepted.length);
  try {
    for (const batch of batches) {
      const res = await api.ingest(state.sessionId, batch, indexingParams());
      state.indexedWith = indexingParams();
      for (const f of res.files) {
        if (f.status === 'ready') state.files.set(f.file_id, f);
        else state.failed.push(f);
      }
      done += batch.length;
      setProgress(done, accepted.length);
      renderFiles();
    }
    hideStatus();
  } catch (e) {
    if (!handleError(e)) showStatus(e.message, { error: true });
  } finally {
    state.busy = false;
    $('qa-progress').hidden = true;
    renderFiles();
    updateAskState();
  }
}

function setProgress(done, total) {
  $('qa-progress').hidden = false;
  $('qa-progress-label').textContent = done < total ? 'Reading and indexing…' : 'Done';
  $('qa-progress-count').textContent = `${done} of ${total} file${total === 1 ? '' : 's'}`;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('qa-progress-bar').setAttribute('aria-valuenow', pct);
  $('qa-progress-bar').firstElementChild.style.width = `${Math.max(pct, 4)}%`;
}

function describeFile(f) {
  const name = f.name.toLowerCase();
  if (f.status !== 'ready') return '—';
  if (name.endsWith('.pdf')) return `${f.pages} page${f.pages === 1 ? '' : 's'} · ${f.chunks} chunks`;
  return `${f.chunks} chunk${f.chunks === 1 ? '' : 's'}`;
}

function renderFiles() {
  const list = $('qa-files');
  const all = [...state.files.values(), ...state.failed];
  list.replaceChildren();
  const groups = new Map();
  for (const f of all) {
    const key = f.folder || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const folders = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const showFolders = folders.length > 1 || folders[0] !== '';
  for (const folder of folders) {
    if (showFolders) {
      list.append(el('li', { class: 'qa-folder-row' }, icon('folder'), folder ? `${folder}/` : 'Top level'));
    }
    for (const f of groups.get(folder).sort((a, b) => a.name.localeCompare(b.name))) {
      const ok = f.status === 'ready';
      const sheet = /\.xls[xm]$/i.test(f.name);
      const remove = el('button', {
        type: 'button', class: 'qa-icon-btn', 'aria-label': `Remove ${f.name}`,
        onclick: () => removeFile(f),
      }, icon('x'));
      list.append(el('li', {},
        icon(ok ? (sheet ? 'sheet' : 'file') : 'alert', ok ? '' : 'qa-err-icon'),
        el('span', { class: 'qa-name' }, el('strong', { text: f.name }),
          ok ? null : el('span', { class: 'qa-err', text: f.error || 'failed' })),
        el('span', { class: 'qa-help qa-meta', text: describeFile(f) }),
        el('span', { class: 'qa-file-status' },
          el('span', { class: `qa-badge ${ok ? 'qa-badge-ok' : 'qa-badge-fail'}`, text: ok ? 'Ready' : 'Failed' })),
        remove));
    }
  }
  list.querySelectorAll('.qa-err-icon').forEach((s) => { s.style.color = 'var(--red)'; });
  list.hidden = !all.length;
  $('qa-empty').hidden = !!all.length;
  $('qa-clear').hidden = !all.length;
}

async function removeFile(f) {
  if (f.status !== 'ready') {
    state.failed = state.failed.filter((x) => x !== f);
    renderFiles();
    return;
  }
  try {
    await api.removeDocument(state.sessionId, f.file_id);
    state.files.delete(f.file_id);
    if (!state.files.size) state.indexedWith = null;
    renderFiles();
    updateReindexBanner();
  } catch (e) {
    if (!handleError(e)) showStatus(e.message, { error: true });
  }
}

// ------------------------------------------------------------------ asking

function updateAskState() {
  if (!state.config) return;
  const needsKey = !usingServerKey() && !readKey();
  const needsReindex = !$('qa-reindex').hidden;
  const ready = state.files.size > 0 && !needsKey && !needsReindex && !state.busy;
  $('qa-question').disabled = !ready;
  $('qa-ask').disabled = !ready || state.asking;
  $('qa-ask-hint').textContent =
    state.busy ? 'Indexing your documents…'
      : !state.files.size ? 'Add at least one document to start asking.'
        : needsKey ? 'Enter an API key above to start asking.'
          : needsReindex ? 'Re-index your documents to apply the new indexing settings.'
            : 'Enter to send · Shift+Enter for a new line';
}

async function askQuestion(question) {
  if (!question || state.asking) return;
  state.asking = true;
  updateAskState();
  const transcript = $('qa-transcript');
  transcript.hidden = false;
  if (!state.retrying) transcript.append(el('div', { class: 'qa-msg-user', text: question }));
  $('qa-question').value = '';

  const msgId = ++state.messageCount;
  const answerEl = el('div', { class: 'qa-answer qa-streaming' }, el('span', { class: 'qa-typing', text: 'Thinking…' }));
  const bubble = el('div', { class: 'qa-msg-bot' }, answerEl);
  transcript.append(bubble);
  bubble.scrollIntoView({ block: 'nearest' });

  let text = '';
  let sources = [];
  const notes = [];
  let finished = null;
  const body = {
    session_id: state.sessionId, question, history: state.history, ...llmBody(), params: state.settings,
  };
  try {
    await api.ask(body, usingServerKey() ? '' : readKey(), (event, data) => {
      if (event === 'meta') sources = data.sources || [];
      else if (event === 'token') {
        if (!text) answerEl.replaceChildren();
        text += data.text;
        answerEl.textContent = text;
      } else if (event === 'note') notes.push(data.text);
      else if (event === 'done') finished = data;
      else if (event === 'error') throw new api.ApiError(502, data.code, data.message);
    });
  } catch (e) {
    bubble.classList.add('qa-failed');
    if (e instanceof api.ApiError && e.code === 'locked') handleError(e);
    else if (e instanceof api.ApiError && e.code === 'session_expired') handleError(e);
    const retry = el('button', {
      type: 'button', class: 'btn-link',
      text: 'Try again',
      onclick: () => { bubble.remove(); state.retrying = true; askQuestion(question).finally(() => { state.retrying = false; }); },
    });
    answerEl.classList.remove('qa-streaming');
    answerEl.replaceChildren(el('p', { class: 'qa-error', text: e.message || 'Something went wrong.' }), retry);
    if (e instanceof api.ApiError && e.code === 'daily_limit_reached') renderQuota(0);
    state.asking = false;
    updateAskState();
    return;
  }

  answerEl.classList.remove('qa-streaming');
  if (finished && finished.daily_remaining != null) renderQuota(finished.daily_remaining);
  if (finished && finished.not_found) {
    bubble.classList.add('qa-notfound');
    answerEl.replaceChildren(el('p', {},
      el('strong', { text: 'I couldn’t find this in your documents.' }), el('br'),
      el('span', { class: 'qa-help', text: 'Try rephrasing, lowering “Minimum similarity” in Advanced settings, or adding the file that covers it.' })));
  } else {
    answerEl.replaceChildren(...formatAnswer(text, msgId, sources.length));
    for (const note of notes) bubble.append(el('p', { class: 'qa-note' }, icon('info'), note));
    const cited = (finished && finished.cited && finished.cited.length) ? finished.cited : sources.map((s) => s.n);
    const shown = sources.filter((s) => cited.includes(s.n));
    if (shown.length) bubble.append(renderSources(shown, msgId));
  }
  state.history.push({ role: 'user', content: question }, { role: 'assistant', content: text });
  state.history = state.history.slice(-20);
  state.asking = false;
  updateAskState();
  $('qa-question').focus();
}

/** Minimal, safe formatting: paragraphs, "- " bullets, **bold**, and [n] citation chips. */
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
  const blocks = [];
  for (const para of text.trim().split(/\n\s*\n/)) {
    const lines = para.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      blocks.push(el('ul', {}, lines.map((l) => el('li', {}, inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))))));
    } else {
      const p = el('p');
      lines.forEach((l, i) => { if (i) p.append(el('br')); p.append(...inline(l)); });
      blocks.push(p);
    }
  }
  return blocks;
}

function sourceWhere(s) {
  if (s.sheet != null) {
    const rows = s.row_start === s.row_end ? `row ${s.row_start}` : `rows ${s.row_start}–${s.row_end}`;
    return `sheet “${s.sheet}” · ${rows}`;
  }
  if (s.page) return `page ${s.page}`;
  if (s.section) return `“${s.section}”`;
  return '';
}

function renderSources(sources, msgId) {
  const listId = `qa-src-list-${msgId}`;
  const list = el('ol', { id: listId }, sources.map((s) => el('li', { id: `qa-src-${msgId}-${s.n}` },
    el('span', { class: 'qa-cite', text: String(s.n) }),
    el('div', {},
      el('div', { class: 'qa-where' },
        s.folder ? el('span', { class: 'qa-path', text: `${s.folder}/` }) : null,
        s.file_name,
        sourceWhere(s) ? ` · ${sourceWhere(s)}` : '',
        el('span', { class: 'qa-score', text: ` · match ${s.score.toFixed(2)}` })),
      el('blockquote', { text: s.snippet })))));
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
