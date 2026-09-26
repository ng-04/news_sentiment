// Backend client for the Local Q&A tool: JSON calls, multipart uploads, and the SSE answer stream.

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
// A ?qa_api= override is honoured only on localhost, so a crafted link can't send a
// visitor's passcode to some other server.
const override = isLocal ? new URLSearchParams(location.search).get('qa_api') : null;
export const API_BASE = override || (isLocal ? 'http://localhost:8765' : 'https://local-qa-api.onrender.com');
const PREFIX = `${API_BASE}/api/qa`;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function storage(kind) {
  return {
    get(key) {
      try { return window[kind].getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try {
        if (value == null) window[kind].removeItem(key);
        else window[kind].setItem(key, value);
      } catch (e) { /* storage blocked: the tool still works for this page view */ }
    },
  };
}
export const session = storage('sessionStorage');
export const local = storage('localStorage');

// The free Render plan sleeps when idle; the first request can take up to a minute.
let slowHandler = () => {};
export function onSlowRequest(fn) { slowHandler = fn; }

async function request(path, { method = 'GET', json, form, headers = {}, raw = false, timeoutMs = 90000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const slow = setTimeout(() => slowHandler(true), 4000);
  const allHeaders = { ...headers };
  const token = session.get('localqa.token');
  if (token) allHeaders.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    allHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  let res;
  try {
    res = await fetch(PREFIX + path, { method, headers: allHeaders, body, signal: controller.signal });
  } catch (e) {
    throw new ApiError(0, 'unreachable',
      "Couldn't reach the Q&A server. It may still be starting up, or it isn't deployed yet.");
  } finally {
    clearTimeout(timeout);
    clearTimeout(slow);
    slowHandler(false);
  }
  if (!res.ok) {
    let detail = {};
    try { detail = await res.json(); } catch (e) { /* not JSON */ }
    throw new ApiError(res.status, detail.code || 'error', detail.message || `Request failed (${res.status}).`);
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

export async function unlock(passcode) {
  const { access_token: token } = await request('/auth', { method: 'POST', json: { passcode } });
  session.set('localqa.token', token);
}

export const getConfig = () => request('/config');
export const newSession = () => request('/session', { method: 'POST' });
export const removeDocument = (sessionId, fileId) =>
  request(`/documents/${encodeURIComponent(fileId)}?session_id=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
export const clearDocuments = (sessionId) =>
  request(`/documents?session_id=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
export const reindex = (sessionId, params) =>
  request('/reindex', { method: 'POST', json: { session_id: sessionId, params }, timeoutMs: 300000 });
export const testKey = (llm, apiKey) =>
  request('/test-llm', { method: 'POST', json: llm, headers: { 'X-LLM-Key': apiKey } });

/** items: [{file: File, folder: string}] */
export function ingest(sessionId, items, params) {
  const form = new FormData();
  form.append('session_id', sessionId);
  form.append('params', JSON.stringify(params));
  form.append('paths', JSON.stringify(items.map((i) => i.folder)));
  items.forEach((i) => form.append('files', i.file, i.file.name));
  return request('/ingest', { method: 'POST', form, timeoutMs: 300000 });
}

/** Streams an answer; calls onEvent(name, data) for meta, token, note, done and error events. */
export async function ask(body, apiKey, onEvent) {
  const headers = apiKey ? { 'X-LLM-Key': apiKey } : {};
  const res = await request('/ask', { method: 'POST', json: body, headers, raw: true, timeoutMs: 120000 });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      onEvent(event, data ? JSON.parse(data) : {});
    }
  }
}
