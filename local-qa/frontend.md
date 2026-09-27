# Local Q&A — Frontend

Static HTML/CSS/JS added to the existing site, the same way the sentiment tool is built:
no framework and no build step, with ES modules loaded from `index.html`.

> **v1 is browser-only** (see goal.md). `local-qa/engine.js` does the work that backend.md
> describes, in the browser: pdf.js, mammoth and SheetJS read files, JSZip unpacks zips,
> Transformers.js runs `bge-small-en-v1.5` for embeddings, and the official `@anthropic-ai/sdk`
> (browser mode) streams answers. `local-qa/qa.js` is the UI. Libraries load from jsDelivr and
> the SheetJS CDN, pinned to exact versions; the embedding model is served from this site
> (`local-qa/models/`, Transformers.js 3.8.1 for reliable local loading). **OneDrive (F1–F3) is in
> v1, browser-only:** `local-qa/onedrive.js` signs in with MSAL.js 5 (popup landing on
> `local-qa/auth-redirect.html`, which calls `broadcastResponseToMainFrame()`), then walks the folder
> through Graph (`/me/drive/root:/{path}` or `/shares/u!{base64url}/driveItem`, `children` with
> `@odata.nextLink` paging, following `remoteItem` shortcuts) and downloads each file from its
> pre-authenticated `@microsoft.graph.downloadUrl`. Folder paths start with the chosen folder's
> name. Where this spec mentions the passcode (F0a), the site key or backend calls, v1 doesn't
> have them: the page shows a
> **Claude API key** field (kept in `sessionStorage`, or `localStorage` with "Remember") and a
> model picker (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`). "Test key" makes a
> 5-token call to `claude-haiku-4-5`.

## Placement

- Replace the "Tool Two" placeholder tile in `#tools` with a live **Local Q&A** tile
  linking to `#local-qa`.
- Add `<section id="local-qa" class="section">` after `#sentiment`.
- Reuse the existing tokens, buttons, cards and dark-mode handling in `styles.css`. Add
  only Q&A-specific rules, grouped under a `/* Local Q&A */` comment.
- New modules go in `local-qa/`: `qa.js` (section controller), `onedrive.js` (sign-in and
  listing), `qa-api.js` (backend calls) and `qa-settings.js` (settings panel).

## Layout

```
┌─ Local Q&A ─────────────────────────────────────────────┐
│ 1. Add documents                                        │
│   [ Sign in with Microsoft ]  Folder: [____________] [Load]
│   — or —  [ Upload files or a folder ] (drag & drop)    │
│                                                         │
│   Indexed documents (7 in 4 folders)        [Clear all] │
│   ▸ Board Reports/2026/Q2/                              │
│     ✓ Q2-report.pdf    42 pages   118 chunks            │
│     ⚠ scan.pdf         no extractable text              │
│   ▸ Board Reports/Finance/                              │
│     ✓ revenue.xlsx     2 sheets · 64 rows · 6 chunks    │
│                                                         │
│ 2. Ask                                                  │
│   ┌───────────────────────────────────────────────────┐ │
│   │ chat transcript (user / bot bubbles)              │ │
│   │ bot answer … [1] [2]                              │ │
│   │   ▸ Sources: [1] Board Reports/2026/Q2/Q2-report.pdf p.14 … │
│   └───────────────────────────────────────────────────┘ │
│   [ Ask a question about your documents…      ] [Ask]   │
│                                                         │
│ ▸ Advanced settings (collapsed by default)              │
└─────────────────────────────────────────────────────────┘
```

## Access and API key (shown before anything else)

What the key UI shows depends on `keys.mode` from `GET /config` (see config.md):

- `server` (the demo): no key field at all. A bar reads "Claude, on this site's API key", with a
  **Model** picker limited to `keys.server_models` and "*N* questions left today" from
  `keys.daily_remaining` (updated from each answer's `done` event). F0b–F0d don't apply.
- `user`: the provider/key setup in F0b–F0d.
- `both`: the server bar by default, plus a "Use my own key" link that opens F0b.

| ID | Requirement |
|---|---|
| F0a | **Passcode screen.** Until the user unlocks the tool, the section shows only a passcode field and an **Unlock** button. The passcode is sent to `POST /auth`. On success, the returned access token is stored in `sessionStorage`. A wrong passcode shows an inline error. Nothing else in the section is usable before unlocking. |
| F0b | **Provider and key.** After unlocking, the user picks a **Provider** (Anthropic, OpenAI, Google Gemini, OpenAI-compatible), enters a **Model** (free text, pre-filled with a suggestion where one is known), and pastes an **API key** into a password-type input with a link to that provider's key page. For *OpenAI-compatible*, a **Base URL** field appears (e.g. `https://api.groq.com/openai/v1`). The provider, model and base URL are saved like the other settings. The key is kept in `sessionStorage` by default. A **Remember on this device** checkbox moves it to `localStorage`, and a **Forget key** button clears it from both. |
| F0c | The key is sent only in the `X-LLM-Key` header of `/ask` calls, with the provider, model and base URL in the body. A **Test key** button calls `/test-llm` to check them. Indexing doesn't need it, so users can add documents before entering a key. |
| F0d | A short note explains that the key goes through our server to the chosen provider for each question, is never stored server-side, and that usage is billed to the user's own account with that provider. |

## Documents panel

> **v1:** F1–F3 run in the browser (see the note at the top); files, folders and .zip downloads also work without signing in.

| ID | Requirement |
|---|---|
| F1 | **Sign in with Microsoft** uses MSAL.js (auth code + PKCE) against the work/school authority (`organizations`), with the delegated, read-only scope `Files.Read.All`. That scope is needed because work folders are often shared from a colleague's OneDrive or a Teams/SharePoint site. The token stays in the browser and is never sent to our backend. If the user's organization requires admin approval, the sign-in error says so plainly. |
| F2 | The folder field accepts a OneDrive **share link** (resolved with Graph `/shares/{id}/driveItem`) or a **path** such as `/Documents/Reports`. **Load** walks the folder **and every subfolder**, following Graph paging, and keeps `.pdf`, `.docx`, `.xlsx` and `.xlsm` files. It stops at the session's file limit and says how many files were skipped. |
| F3 | The files are downloaded through Graph and sent to `/ingest` in small batches, each with its folder path relative to the chosen folder's parent (so the chosen folder's name is included, e.g. `Board Reports/2026/Q2`). A progress bar shows *n of N files*. |
| F4 | Upload works through a file input (`accept=".pdf,.docx,.xlsx,.xlsm"`, multiple), a folder picker (`webkitdirectory`), and drag and drop of files or whole folders (`webkitGetAsEntry`). Folder uploads keep their relative paths. The UI rejects other types and oversized files before uploading. |
| F5 | The indexed-document list is grouped by folder path. Each file shows its name, pages (PDF) or sheets and rows (Excel), chunk count and status (indexing / ready / failed with a reason). Files can be removed individually, and **Clear all** removes everything. |
| F6 | The **Ask** box stays disabled until at least one document is ready and, in `user` mode, an API key has been entered. |

## Chat panel

| ID | Requirement |
|---|---|
| F7 | The chat transcript alternates user and bot messages. Enter sends the question and Shift+Enter adds a new line. |
| F8 | Bot answers stream in token by token if the backend streams (SSE). Otherwise a typing indicator shows until the answer arrives. |
| F9 | Inline citation markers `[1]` link to a **Sources** list under the answer. Each source shows the **folder path**, file name, and page (PDF), section (Word) or sheet and row range (Excel), plus an expandable snippet of the retrieved chunk. |
| F10 | A "not found in your documents" answer is styled differently from a normal answer. |
| F10b | `note` events from the backend (e.g. "claude-opus-5 doesn't support temperature, so that setting was ignored", or "answer cut off at the length limit") appear as a small muted line under the answer. |
| F11 | The last N turns (see config) are sent with each question so follow-up questions work. |
| F12 | Errors (backend down or cold-starting, rate limit, daily limit reached, expired access token, invalid or out-of-credit API key) are shown inline with a retry action and never fail silently. Because the free Render plan sleeps, the first request after idle shows "Waking the server up, this can take up to a minute…" rather than an error. |

## Memory (G11)

| ID | Requirement |
|---|---|
| M1 | The conversation (questions, answers, sources, notes, chart proposals and charts) is saved in IndexedDB after every turn and restored when the page opens. Follow-up memory (`history_turns`) keeps working across reloads. |
| M2 | Indexed documents are saved too: file records (name, folder, pages/sheets), parsed text units, chunks and their 384-dimension vectors, plus the indexing settings they were built with. On load they are restored without re-reading files, and the list shows them as ready. |
| M3 | **Clear chat** (next to the Ask heading) deletes the saved conversation. **Clear all** in Documents also deletes the saved documents. A line under the privacy note says what is stored on this device. |
| M4 | If IndexedDB is unavailable (private window, blocked storage) the tool still works for the tab, just without saving; nothing breaks. |

## Charts (G12)

| ID | Requirement |
|---|---|
| C1 | Claude gets a `propose_chart` tool. When a question asks for a chart, graph, plot or visual comparison, it calls the tool instead of drawing anything itself. The system prompt lists the indexed spreadsheets (file, folder, sheet, column headers, row count) so it can point at real columns. |
| C2 | Two data sources. **Spreadsheet:** Claude gives the file, sheet, category column, one or more value columns, aggregation (`sum`, `average`, `count`, `min`, `max`, `none`) and optional filters; the page computes the values from every row of that sheet. **Excerpts:** Claude gives labels and values quoted from retrieved passages, each value with its excerpt number. |
| C3 | The proposal is shown as a table before anything is drawn: a settings table (chart type, X axis, Y values, aggregation, source) and the exact data table to be plotted (up to 50 rows shown). Buttons: **Plot chart** and **Cancel**. To change the plan, the user replies in the chat and Claude proposes again. |
| C4 | After **Plot chart**, a bar, line or pie chart is drawn in the answer, styled with the site's tokens and dark mode, with the source line (e.g. `Board Reports/Finance/Revenue.xlsx · sheet "Revenue" · rows 2–40`) and **Download PNG** / **Download CSV**. Excerpt-based charts are labelled "figures quoted from the documents". |
| C5 | Tool inputs are validated in the browser (known chart type, existing sheet and columns, numeric values, at most 50 categories and 6 series); an invalid proposal becomes a plain message asking the user to rephrase. |

## Advanced settings panel

| ID | Requirement |
|---|---|
| F13 | A collapsible "Advanced settings" section, closed by default. |
| F14 | Each parameter in [config.md](config.md) marked *user-facing* gets a control: a slider for numbers and a select for enums, with a one-line explanation and its current value. |
| F15 | **Reset to defaults** is available. Settings are saved in `localStorage` (inside try/catch) so they persist for that browser. |
| F16 | Parameters are grouped. **Answer** parameters (temperature, max length, style) apply to the next question. **Indexing** parameters (chunk size, overlap, strategy) need a re-index, so changing one shows "Re-index to apply" with a button. |
| F17 | Slider ranges and defaults come from the backend `GET /config`, so the UI and server can't disagree. |

## Non-functional

- Works on mobile at phone width (16px gutter, no horizontal scroll), matching the rest of the site.
- Dark mode uses the existing `data-theme` mechanism.
- Accessibility: labelled controls, `aria-live="polite"` on the chat transcript, and full keyboard use.
- The backend base URL lives in one constant in `qa-api.js`.
