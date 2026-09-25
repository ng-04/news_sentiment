# Local Q&A — Frontend

Static HTML/CSS/JS added to the existing site, the same way the sentiment tool is built:
no framework and no build step, with ES modules loaded from `index.html`.

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
│   — or —  [ Upload PDF / DOCX ]  (drag & drop zone)     │
│                                                         │
│   Indexed documents (5)                     [Clear all] │
│   ✓ Q2-report.pdf      42 pages   118 chunks            │
│   ✓ policy.docx        —          23 chunks             │
│   ⚠ scan.pdf           no extractable text              │
│                                                         │
│ 2. Ask                                                  │
│   ┌───────────────────────────────────────────────────┐ │
│   │ chat transcript (user / bot bubbles)              │ │
│   │ bot answer … [1] [2]                              │ │
│   │   ▸ Sources: [1] Q2-report.pdf p.14  [2] …        │ │
│   └───────────────────────────────────────────────────┘ │
│   [ Ask a question about your documents…      ] [Ask]   │
│                                                         │
│ ▸ Advanced settings (collapsed by default)              │
└─────────────────────────────────────────────────────────┘
```

## Access and API key (shown before anything else)

| ID | Requirement |
|---|---|
| F0a | **Passcode screen.** Until the user unlocks the tool, the section shows only a passcode field and an **Unlock** button. The passcode is sent to `POST /auth`. On success, the returned access token is stored in `sessionStorage`. A wrong passcode shows an inline error. Nothing else in the section is usable before unlocking. |
| F0b | **Provider and key.** After unlocking, the user picks a **Provider** (Anthropic, OpenAI, Google Gemini, OpenAI-compatible), enters a **Model** (free text, pre-filled with a suggestion where one is known), and pastes an **API key** into a password-type input with a link to that provider's key page. For *OpenAI-compatible*, a **Base URL** field appears (e.g. `https://api.groq.com/openai/v1`). The provider, model and base URL are saved like the other settings. The key is kept in `sessionStorage` by default. A **Remember on this device** checkbox moves it to `localStorage`, and a **Forget key** button clears it from both. |
| F0c | The key is sent only in the `X-LLM-Key` header of `/ask` calls, with the provider, model and base URL in the body. A **Test key** button calls `/test-llm` to check them. Indexing doesn't need it, so users can add documents before entering a key. |
| F0d | A short note explains that the key goes through our server to the chosen provider for each question, is never stored server-side, and that usage is billed to the user's own account with that provider. |

## Documents panel

| ID | Requirement |
|---|---|
| F1 | **Sign in with Microsoft** uses MSAL.js (auth code + PKCE) with the delegated, read-only scope `Files.Read`. The token stays in the browser and is never sent to our backend. |
| F2 | The folder field accepts a OneDrive **share link** or a **path** such as `/Documents/Reports`. **Load** lists the folder through Microsoft Graph and keeps only `.pdf` and `.docx` files. |
| F3 | The listed files are downloaded through Graph and sent to the backend `/ingest` endpoint in batches, with a progress bar that shows *n of N files*. |
| F4 | Upload works through a file input (`accept=".pdf,.docx"`, multiple) and drag and drop. The UI rejects other types and files over the size limit (see config) before uploading. |
| F5 | The indexed-document list shows each file's name, page count, chunk count and status (indexing / ready / failed with a reason). Each file can be removed individually, and **Clear all** removes everything. |
| F6 | The **Ask** box stays disabled until at least one document is ready **and** an API key has been entered. |

## Chat panel

| ID | Requirement |
|---|---|
| F7 | The chat transcript alternates user and bot messages. Enter sends the question and Shift+Enter adds a new line. |
| F8 | Bot answers stream in token by token if the backend streams (SSE). Otherwise a typing indicator shows until the answer arrives. |
| F9 | Inline citation markers `[1]` link to a **Sources** list under the answer. Each source shows the file name, page or section, and an expandable snippet of the retrieved chunk. |
| F10 | A "not found in your documents" answer is styled differently from a normal answer. |
| F10b | `note` events from the backend (e.g. "claude-opus-5 doesn't support temperature, so that setting was ignored", or "answer cut off at the length limit") appear as a small muted line under the answer. |
| F11 | The last N turns (see config) are sent with each question so follow-up questions work. |
| F12 | Errors (backend down or cold-starting, rate limit, expired access token, invalid or out-of-credit API key) are shown inline with a retry action and never fail silently. |

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
