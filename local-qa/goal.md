# Local Q&A — Goal

## Summary

Local Q&A is the second tool on the site. It is a retrieval-augmented generation (RAG)
chatbot. The user points it at a OneDrive folder and/or uploads files, and it answers
questions using only what is in those PDF and DOCX files. Each answer cites the file and
page or section it came from.

## Who it's for

People who have a folder of reports, notes, policies or papers and want to ask questions
like "What was the Q2 revenue target?" without reading every file.

## Core requirements

| # | Requirement |
|---|---|
| G1 | The user gives a OneDrive folder location, and the bot reads every `.pdf` and `.docx` file in it. |
| G2 | The user can also upload `.pdf` / `.docx` files directly, with or without a OneDrive folder. |
| G3 | The bot answers natural-language questions using only the indexed files. |
| G4 | Every answer cites its sources (file name + page for PDFs, or heading/paragraph for DOCX). |
| G5 | If the files don't contain the answer, the bot says so instead of guessing. |
| G6 | Advanced users can change answer and retrieval parameters (temperature, chunk size, overlap, top-k, and so on). Defaults work without any tuning. |
| G7 | The tool fits into the existing site: a tile on the "Pick a tool" grid, the same styling, and dark mode. |

## Out of scope for v1

- File types other than PDF and DOCX (no XLSX, PPTX, images or OCR of scanned PDFs).
- Writing back to OneDrive. Access is read-only.
- Multi-user accounts and indexes that persist across sessions (see open decisions).
- Recursing into subfolders. v1 reads only the top level unless we decide otherwise.

## Success criteria

- A folder of about 20 typical documents (under 200 pages in total) is indexed in under a minute.
- A question on an indexed set gets a cited answer in under 10 seconds.
- A question whose answer isn't in the files gets a clear "not found in your documents".
- Changing a parameter visibly changes the behavior. For example, lower top-k gives fewer
  cited sources, and higher temperature gives looser wording.

## Architecture at a glance

```
Browser (GitHub Pages)                    Backend (new, separately hosted)
┌──────────────────────────┐              ┌───────────────────────────────┐
│ Local Q&A section        │  files       │ /ingest  parse → chunk → embed │
│  • OneDrive folder picker├─────────────►│ /ask     retrieve → LLM → cite │
│  • File upload           │  question    │ /config  defaults + limits     │
│  • Chat + sources        │◄─────────────┤ vector index per session       │
│  • Settings panel        │  answer      │ passcode check, BYO API key    │
└──────────────────────────┘              └───────────────────────────────┘
```

A backend is required because parsing and embedding are more reliable server-side, the
passcode must be checked on the server, and most LLM APIs don't accept direct calls from
arbitrary websites. OneDrive files and uploaded files
go through the **same ingestion path**: the frontend fetches OneDrive files and sends
them to `/ingest` the same way it sends uploads.

## Decisions

| Topic | Decision |
|---|---|
| OneDrive location | A **cloud folder** read after Microsoft sign-in (share link or path). Read-only `Files.Read`. |
| LLM and cost | **Any provider, chosen by the user**: Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible API (Groq, Mistral, OpenRouter, DeepSeek, Together, …) via a custom base URL. **Each user enters their own API key** in the UI. The backend uses it only for that request and never stores or logs it. |
| Hosting | The backend runs on **Render** (free/starter tier), deployed from this repo with a Dockerfile. The frontend stays on GitHub Pages. |
| Access | **Passcode gate *and* bring-your-own key.** The passcode keeps strangers off the server, and the user's key pays for answers. Users must enter a secret passcode (set by the operator on the server) before they can use the tool. |
| Persistence | Per-session, in memory only (v1). |

## Original open decisions (resolved above)

1. **What "OneDrive file location" means.** Option A is a OneDrive cloud folder (share
   link or path), read with Microsoft sign-in. Option B is a locally synced OneDrive
   folder on disk (e.g. `C:\Users\me\OneDrive\Reports`). This spec assumes A. Option B
   would need a browser folder picker (Chrome/Edge only) or a backend running on the
   user's own machine.
2. **LLM provider and who pays.** The spec assumes Claude via the Anthropic API, with a
   key held on the backend.
3. **Backend hosting.** Where the backend runs (Render, Railway, Azure, a local machine, …).
4. **Persistence.** Whether indexes are kept per session only (default) or saved per user.
5. **Access control.** Whether the tool is public or restricted, given that every question
   costs API money.
