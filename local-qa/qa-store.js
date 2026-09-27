// Saves Local Q&A's conversation and document index in this browser (IndexedDB), so a reload
// keeps the chat and doesn't require re-reading files. Nothing leaves the device. If IndexedDB is
// unavailable (private window, blocked storage) every call quietly does nothing.

const DB_NAME = 'localqa';
const STORE = 'kv';

let dbPromise = null;
function db() {
  dbPromise ||= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => { console.warn('Local Q&A: browser storage error', tx.error); resolve(undefined); };
      tx.onabort = () => resolve(undefined);
    } catch (e) {
      console.warn('Local Q&A: could not save to browser storage', e);
      resolve(undefined);
    }
  });
}

export const available = async () => !!(await db());
export const get = (key) => run('readonly', (s) => s.get(key));
export const set = (key, value) => run('readwrite', (s) => s.put(value, key));
export const remove = (key) => run('readwrite', (s) => s.delete(key));

/** Coalesces bursts of saves (e.g. one per indexed file) into one write per key. Pending
 *  writes are flushed when the page is hidden or closed, so nothing is lost on a quick reload. */
const pending = new Map(); // key -> {timer, build}
export function saveSoon(key, build, delay = 400) {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => { pending.delete(key); set(key, build()); }, delay);
  pending.set(key, { timer, build });
}
export function flush() {
  for (const [key, { timer, build }] of pending) {
    clearTimeout(timer);
    set(key, build());
  }
  pending.clear();
}
try {
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
} catch (e) { /* not in a browser */ }
