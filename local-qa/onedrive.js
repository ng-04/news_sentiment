// OneDrive / SharePoint access for Local Q&A, entirely in the browser: Microsoft sign-in with
// MSAL.js (popup, auth code + PKCE) and reads through Microsoft Graph. The access token stays in
// this tab's sessionStorage and is sent only to Microsoft; there is no server.

// Application (client) ID of the Azure app registration. It is public, not a secret. Leave it
// empty to show the OneDrive box as "not set up yet". Setup steps: README.md → Local Q&A.
export const MSAL_CLIENT_ID = '';

const MSAL_CDN = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@5.23.0/+esm';
const AUTHORITY = 'https://login.microsoftonline.com/organizations'; // work/school Microsoft 365 accounts
const SCOPES = ['Files.Read.All']; // read-only; also covers folders shared by colleagues or Teams sites
const GRAPH = 'https://graph.microsoft.com/v1.0';
// The sign-in popup lands on this page, which hands the result back to this tab.
const REDIRECT_URI = new URL('auth-redirect.html', import.meta.url).href;

export const isConfigured = () => !!MSAL_CLIENT_ID;

export class OneDriveError extends Error {}

let clientPromise = null;
function msalClient() {
  clientPromise ||= (async () => {
    const msal = await import(MSAL_CDN);
    const app = await msal.createStandardPublicClientApplication({
      auth: { clientId: MSAL_CLIENT_ID, authority: AUTHORITY, redirectUri: REDIRECT_URI },
      cache: { cacheLocation: 'sessionStorage' },
    });
    const existing = app.getAllAccounts()[0];
    if (existing && !app.getActiveAccount()) app.setActiveAccount(existing);
    return { msal, app };
  })().catch((e) => { clientPromise = null; throw e; });
  return clientPromise;
}

function friendly(e) {
  const text = `${e && e.errorCode ? `${e.errorCode} ` : ''}${e && e.message ? e.message : e}`;
  if (/user_cancelled/.test(text)) return new OneDriveError('Sign-in was cancelled.');
  if (/popup_window_error|empty_window_error/.test(text)) {
    return new OneDriveError('The sign-in window was blocked. Allow pop-ups for this site and try again.');
  }
  if (/AADSTS65001|AADSTS90094|consent/i.test(text)) {
    return new OneDriveError('Your organization needs an IT admin to approve this app before you can sign in.');
  }
  if (/AADSTS50011|redirect/i.test(text)) {
    return new OneDriveError('Sign-in isn’t set up for this address yet (redirect URI missing from the app registration).');
  }
  if (e instanceof OneDriveError) return e;
  return new OneDriveError(`Microsoft sign-in failed: ${e && e.message ? e.message : e}`);
}

export async function currentAccount() {
  if (!isConfigured()) return null;
  const { app } = await msalClient();
  return app.getActiveAccount();
}

export async function signIn() {
  try {
    const { app } = await msalClient();
    const result = await app.loginPopup({ scopes: SCOPES, prompt: 'select_account' });
    app.setActiveAccount(result.account);
    return result.account;
  } catch (e) {
    throw friendly(e);
  }
}

/** Forgets the account in this tab (no Microsoft-wide sign-out, so no extra popup). */
export async function signOut() {
  const { app } = await msalClient();
  await app.clearCache({ account: app.getActiveAccount() });
  app.setActiveAccount(null);
}

async function accessToken() {
  const { msal, app } = await msalClient();
  const account = app.getActiveAccount();
  if (!account) throw new OneDriveError('Sign in with Microsoft first.');
  try {
    return (await app.acquireTokenSilent({ scopes: SCOPES, account })).accessToken;
  } catch (e) {
    if (e instanceof msal.InteractionRequiredAuthError) {
      try {
        return (await app.acquireTokenPopup({ scopes: SCOPES, account })).accessToken;
      } catch (e2) {
        throw friendly(e2);
      }
    }
    throw friendly(e);
  }
}

async function graph(pathOrUrl) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : GRAPH + pathOrUrl;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.ok) return res.json();
  if (res.status === 404) throw new OneDriveError('That folder or link wasn’t found. Check the path or share link.');
  if (res.status === 401 || res.status === 403) {
    throw new OneDriveError('You don’t have access to that folder with this Microsoft account.');
  }
  if (res.status === 429) throw new OneDriveError('Microsoft is rate-limiting requests. Wait a minute and try again.');
  throw new OneDriveError(`Microsoft Graph error ${res.status}.`);
}

/** Graph "sharing URL" encoding: u! + unpadded base64url of the link. */
function shareId(link) {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(link)));
  return `u!${b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

async function resolveItem(input) {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return graph(`/shares/${shareId(value)}/driveItem`);
  const path = value.replace(/^\/+|\/+$/g, '');
  if (!path) return graph('/me/drive/root');
  return graph(`/me/drive/root:/${path.split('/').map(encodeURIComponent).join('/')}`);
}

// A shortcut or shared item points at another drive; follow it.
const target = (item) => (item.remoteItem
  ? { driveId: item.remoteItem.parentReference.driveId, id: item.remoteItem.id, folder: item.remoteItem.folder, file: item.remoteItem.file }
  : { driveId: item.parentReference && item.parentReference.driveId, id: item.id, folder: item.folder, file: item.file });

/**
 * Walks a OneDrive folder (share link or path) and every subfolder. Returns
 * {files: [{name, folder, size, read}], skipped: [{name, folder, reason}], truncated}.
 * `folder` starts with the chosen folder's own name, e.g. "Board Reports/2026/Q2".
 */
export async function listFolder(input, { isSupported, maxFiles, maxFileBytes, onProgress = () => {} }) {
  const root = await resolveItem(input);
  const rootTarget = target(root);
  const rootName = root.root ? 'OneDrive' : root.name;
  const files = [];
  const skipped = [];
  let truncated = false;

  const addFile = (item, folder, t) => {
    if (!isSupported(item.name)) { skipped.push({ name: item.name, folder, reason: 'unsupported file type' }); return; }
    if (item.size > maxFileBytes) { skipped.push({ name: item.name, folder, reason: 'too large' }); return; }
    if (files.length >= maxFiles) { truncated = true; return; }
    const driveId = t.driveId;
    const id = t.id;
    let downloadUrl = item['@microsoft.graph.downloadUrl'];
    files.push({
      name: item.name, folder, size: item.size,
      // downloadUrl is a short-lived pre-authenticated link that browsers can fetch directly
      // (Graph's /content endpoint redirects in a way browsers block). Refresh it if it expired.
      read: async () => {
        let res = downloadUrl ? await fetch(downloadUrl) : null;
        if (!res || !res.ok) {
          downloadUrl = (await graph(`/drives/${driveId}/items/${id}`))['@microsoft.graph.downloadUrl'];
          res = await fetch(downloadUrl);
        }
        if (!res.ok) throw new OneDriveError(`download failed (${res.status})`);
        return res.arrayBuffer();
      },
    });
  };

  if (!rootTarget.folder) { // a link or path to a single file
    addFile(root, '', rootTarget);
    return { files, skipped, truncated };
  }

  const queue = [{ ...rootTarget, path: rootName }];
  while (queue.length && !truncated) {
    const dir = queue.shift();
    onProgress({ folder: dir.path, found: files.length });
    let next = `/drives/${dir.driveId}/items/${dir.id}/children?$top=200`;
    while (next) {
      const page = await graph(next);
      for (const child of page.value) {
        const t = target(child);
        if (t.folder) queue.push({ ...t, path: `${dir.path}/${child.name}` });
        else if (t.file) addFile(child, dir.path, t);
      }
      next = page['@odata.nextLink'] || null;
    }
  }
  return { files, skipped, truncated };
}
