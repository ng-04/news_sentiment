# Local Q&A — Goal

## Summary

Local Q&A is the second tool on the site. It is a retrieval-augmented generation (RAG)
chatbot. The user points it at a OneDrive folder (including all its subfolders) and/or
uploads files, and it answers questions using only what is in those PDF, Word and Excel
files. Each answer cites where it came from: the folder path, the file, and the page,
section or sheet.

## Who it's for

People who have a folder tree of reports, notes, policies, papers or spreadsheets and want
to ask questions like "What was the Q2 revenue target?" without opening every file.

## Core requirements

| # | Requirement |
|---|---|
| G1 | The user gives a OneDrive folder location. The bot reads every supported file (`.pdf`, `.docx`, `.xlsx`, `.xlsm`) in that folder **and in all of its subfolders, at any depth**. |
| G2 | The user can also upload supported files directly, with or without a OneDrive folder. Dropping a whole folder keeps its subfolder paths. |
| G3 | The bot answers natural-language questions using only the indexed files. |
| G4 | Every answer cites its sources with the **folder location** (path relative to the chosen OneDrive folder, e.g. `Board Reports/2026/Q2/`), the file name, and the location inside the file: page for PDFs, heading for Word, sheet and row range for Excel. |
| G5 | If the files don't contain the answer, the bot says so instead of guessing. |
| G6 | Advanced users can change answer and retrieval parameters (temperature, chunk size, overlap, top-k, and so on). Defaults work without any tuning. |
| G7 | The tool fits into the existing site: a tile on the "Pick a tool" grid, the same styling, and dark mode. |
| G8 | Excel files are read sheet by sheet. Each row keeps its column headers (e.g. `Region: South, Q2 revenue: 12.4`), so answers can quote cell values and cite the sheet and rows. |
| G9 | Which LLM API key is used is **configurable at deployment** (see Decisions). The demo uses the site owner's Claude API key, held on the server, so users don't need a key. |
| G10 | When the server's own key is in use, the operator can set a daily question cap so the key can't be run up by heavy use. |

## Out of scope for v1

- File types other than PDF, Word (`.docx`) and Excel (`.xlsx`, `.xlsm`): no legacy `.doc`/`.xls`, PPTX, CSV, images, or OCR of scanned PDFs.
- Formulas are read as their last saved values; charts, images and pivot-table layouts in spreadsheets are ignored.
- Writing back to OneDrive. Access is read-only.
- Multi-user accounts and indexes that persist across sessions.

## Success criteria

- A folder tree of about 20 typical documents across a few subfolders (under 200 pages in
  total) is indexed in under a minute.
- A question on an indexed set gets a cited answer in under 10 seconds, and the citation
  shows the folder path, file and page, section or sheet.
- A question answered from a spreadsheet cites the right sheet and rows.
- A question whose answer isn't in the files gets a clear "not found in your documents".
- Changing a parameter visibly changes the behavior. For example, lower top-k gives fewer
  cited sources, and higher temperature gives looser wording on models that support it.
- The demo works end to end with no API key entered by the user.

## Architecture at a glance

```
Browser (GitHub Pages)                    Backend (new, separately hosted)
┌──────────────────────────┐              ┌────────────────────────────────┐
│ Local Q&A section        │  files +     │ /ingest  parse → chunk → embed │
│  • OneDrive folder picker│  folder paths│ /ask     retrieve → LLM → cite │
│    (walks subfolders)    ├─────────────►│ /config  defaults + limits     │
│  • File / folder upload  │  question    │ vector index per session       │
│  • Chat + sources        │◄─────────────┤ passcode check                 │
│  • Settings panel        │  answer      │ LLM key: server or user        │
└──────────────────────────┘              └────────────────────────────────┘
```

A backend is required because parsing and embedding are more reliable server-side, the
passcode must be checked on the server, the server's API key must never reach the browser,
and most LLM APIs don't accept direct calls from arbitrary websites. OneDrive files and
uploaded files go through the **same ingestion path**: the frontend walks the OneDrive
folder tree, downloads each supported file, and sends it to `/ingest` along with its
relative folder path, the same way it sends uploads.

## Decisions

| Topic | Decision |
|---|---|
| OneDrive in v1 (2026-09-26) | **Upload-first.** Users download their OneDrive folder as a .zip (or pick the synced folder) and upload it; folder paths are kept. Direct OneDrive sign-in below is deferred: it needs an Azure app registration, and a public link can't list a work/school folder without one. |
| OneDrive location (deferred) | A **cloud folder** in a **work/school Microsoft 365** account, read after sign-in (share link or path), including all subfolders. Read-only `Files.Read.All`, so folders shared from colleagues or Teams sites work too. Some organizations require an IT admin to approve the app once. |
| File types | PDF, Word (`.docx`) and Excel (`.xlsx`, `.xlsm`). Excel was added on 2026-09-25. |
| Citations | Folder path relative to the chosen folder + file name + page, heading, or sheet and rows. |
| LLM key (updated 2026-09-25) | **Configurable per deployment** with `QA_KEY_MODE`: <br>• `server`: one key held on the server (`ANTHROPIC_API_KEY`), used for every question; users see no key field. <br>• `user`: each user enters their own key for any supported provider (Anthropic, OpenAI, Gemini, OpenAI-compatible), as before. <br>• `both`: the server key by default, with users allowed to switch to their own. |
| Demo setup | `QA_KEY_MODE=server` with the site owner's Claude API key, default model `claude-opus-5`. Locally the key lives in a git-ignored `.env` file; on Render it's a secret environment variable. It is never committed, logged or sent to the browser. |
| Hosting | The backend runs on **Render** (free/starter tier), deployed from this repo with a Dockerfile. The frontend stays on GitHub Pages. |
| Access | A **passcode gate** in every mode. With a server key it's the main thing protecting the owner's API budget, together with per-session rate limits and the daily question cap (G10). |
| Persistence | Per-session, in memory only (v1). |

## Original open decisions (resolved above)

1. **What "OneDrive file location" means.** Option A is a OneDrive cloud folder (share
   link or path), read with Microsoft sign-in. Option B is a locally synced OneDrive
   folder on disk (e.g. `C:\Users\me\OneDrive\Reports`). This spec assumes A. Option B
   would need a browser folder picker (Chrome/Edge only) or a backend running on the
   user's own machine.
2. **LLM provider and who pays.** First resolved as bring-your-own key per user. On
   2026-09-25 it changed to configurable, with the demo using the owner's Claude key.
3. **Backend hosting.** Where the backend runs (Render, Railway, Azure, a local machine, …).
4. **Persistence.** Whether indexes are kept per session only (default) or saved per user.
5. **Access control.** Whether the tool is public or restricted, given that every question
   costs API money.
