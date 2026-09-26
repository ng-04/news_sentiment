# Local Q&A — Backend

A new, separately hosted service. It is needed because the site itself is static on
GitHub Pages and the site owner's LLM API key must stay server-side.

## Stack (proposed)

| Concern | Choice | Why |
|---|---|---|
| Language / framework | Python 3.12 + FastAPI | Best PDF/DOCX parsing and embedding libraries; async; easy SSE. |
| PDF parsing | `pypdf` (fallback `pdfplumber`) | Page-level text, so citations can give page numbers. |
| DOCX parsing | `python-docx` | Paragraphs, headings and tables; headings are used as section labels. |
| XLSX parsing | `openpyxl` (read-only, saved values) | Sheet by sheet; the first non-empty row is the header, and each data row becomes `Header: value; …` so it stands alone. |
| Embeddings | `fastembed` (ONNX) with `BAAI/bge-small-en-v1.5`, run locally | No per-call cost and no document text sent to a third party. Unlike `sentence-transformers` + PyTorch, it fits in Render's small-instance RAM. |
| Vector index | In-memory FAISS (or NumPy cosine similarity) per session | Enough for v1's size limits and needs no database. |
| LLM | Provider adapters: `anthropic` (official SDK), `openai` (official SDK), `gemini` (`google-genai`), and `openai_compatible` (OpenAI SDK with a custom `base_url`) | Which key answers is set by `QA_KEY_MODE`: the site owner's Anthropic key (`server`, the demo), a key the user sends with each request (`user`), or the owner's key unless the user sends one (`both`). Every adapter has the same interface. |
| Streaming protocol | SSE events: `meta` (sources), `token`, `note` (caveats such as "temperature ignored"), `done` (`not_found`, `cited`), `error` | The first LLM event is fetched before the response starts, so key and model errors come back as normal HTTP errors. |
| Hosting | Render web service (Docker) | Auto-deploys from `main`. Free-tier instances sleep when idle, which costs about 30s on the first request and wipes in-memory sessions. |

## Pipeline

1. **Ingest.** Receive files, check type, size and count limits, then parse:
   - PDF: text per page. A page with no extractable text is flagged (likely scanned).
   - DOCX: paragraphs and tables in order, keeping the nearest heading as the section label.
   - XLSX/XLSM: one unit per data row, with its sheet name and row number. Blank rows are
     skipped; formulas are read as their last saved values.
   Each file also keeps the folder path the client sent for it (cleaned: no `..`, no leading `/`).
2. **Chunk.** Split using the configured strategy (`recursive` by default), chunk size and
   overlap. Spreadsheets are packed row by row instead: rows are never split, chunks never
   span sheets, and each chunk records its row range. Each chunk keeps
   `{file_id, file_name, folder, page | section | sheet + row_start..row_end, chunk_index, text}`.
3. **Embed** the chunks in batches and add them to the session's index.
4. **Ask.**
   1. Embed the question. If there is chat history, blend in the previous user question
      (75/25), so follow-ups like "what about last year?" still find the right passages.
      This avoids an extra LLM call.
   2. Search with the query vector and retrieve the `top_k` chunks at or above `min_similarity`.
      Use MMR when `diversify` is on.
   3. If nothing passes the threshold, return "not found in your documents" without
      calling the LLM.
   4. Otherwise, send the numbered chunks and the question to the LLM with a grounding
      system prompt: answer only from the context, cite as `[n]`, and say so if the
      answer isn't there.
   5. Return the answer and the source list (the chunks that were actually cited).

## API

All endpoints are under `/api/qa`. Every endpoint except `GET /health` and `POST /auth`
requires `Authorization: Bearer <access_token>`. A session is identified by an opaque
`session_id` that the server issues and the browser keeps in `sessionStorage`.

| Method & path | Body / params | Returns |
|---|---|---|
| `POST /auth` | `{passcode}` | `{access_token, expires_in}` on success, `401` on a wrong passcode. Rate-limited per IP. |
| `GET /config` | — | Defaults, min/max and allowed values for every parameter (see config.md). |
| `POST /session` | — | `{session_id}` |
| `POST /ingest` | multipart: `session_id`, `files[]`, `paths` (JSON list of folder paths, parallel to `files`), indexing params | Per file: `{file_id, name, folder, pages, chunks, status, error?}` |
| `DELETE /documents/{file_id}` | `session_id` | `204` |
| `DELETE /documents` | `session_id` | `204` (clears the index) |
| `POST /reindex` | `session_id`, indexing params | The same shape as `/ingest`. Re-chunks the stored raw text; files are not uploaded again. |
| `POST /test-llm` | header `X-LLM-Key`; `{provider, model, base_url?}` | `{ok, server_key}`. Skips the call when the server key would be used. |
| `POST /ask` | header `X-LLM-Key` (user/both modes); body `{session_id, question, history[], provider, model, base_url?, answer params, retrieval params}` | SSE: `meta` (sources with `folder`, `page`/`section`/`sheet`, `row_start`, `row_end`), `token`…, `note`…, then `done` `{not_found, cited, daily_remaining}` |
| `GET /health` | — | `200` |

## Data handling and security

- Raw text and embeddings stay **in memory per session** and are deleted after
  `session_ttl_minutes` of inactivity or on **Clear all**. Nothing is written to disk
  beyond temporary upload buffers.
- OneDrive tokens never reach the backend. The browser downloads the files and uploads
  them here.
- CORS allows only the site origin (`https://ng-04.github.io`) plus localhost for development.
- Rate limits apply per IP and per session (see config), and the server re-checks
  every parameter's bounds even though the UI already enforces them.
- **Passcode gate.** The passcode is set in `QA_ACCESS_PASSCODE` and compared in
  constant time. On success the server issues a short-lived signed token (HMAC with
  `QA_TOKEN_SECRET`, TTL `QA_ACCESS_TOKEN_TTL_MINUTES`). Failed attempts are rate-limited
  per IP.
- **The site owner's key** (`ANTHROPIC_API_KEY`) is read from the environment: a git-ignored
  `backend/.env` locally, a secret environment variable on Render. It is never returned by
  any endpoint, logged, or included in error messages.
- **Daily cap.** In `server`/`both` modes, questions answered on the owner's key are counted
  per UTC day against `QA_DAILY_QUESTION_LIMIT`. A question is counted only once the provider
  accepts it; "not found" answers (no LLM call) and failed calls don't count. The count is in
  memory, so it resets when the server restarts. Set an Anthropic console spend limit as the
  hard backstop.
- **User API keys.** The key is read from the `X-LLM-Key` header, used for that one
  provider call, and then discarded. It is never stored, cached, logged or included in
  error messages; the logging middleware redacts that header. HTTPS only.
- Document text is sent to the LLM provider only when a question is asked, and only the
  retrieved chunks. The UI should say this.

## Error handling

| Case | Behavior |
|---|---|
| Unsupported, oversized or too many files | `400`/`413` with a per-file reason, and the other files still ingest. |
| PDF with no text (scanned) | Ingested with status `failed: no extractable text`. |
| Encrypted PDF / corrupt DOCX | Per-file `failed` with the reason. |
| LLM timeout or 5xx | One retry with backoff, then `502` with a user-readable message. |
| Missing, invalid or out-of-credit API key | `401`/`402` with code `invalid_api_key` / `api_key_no_credit`, normalized across providers, with the key redacted. |
| Custom base URL is not `https`, or resolves to a private, loopback, link-local or otherwise non-public address | `400 base_url_not_allowed` (SSRF protection). Known limit: a DNS answer that changes between the check and the connection (rebinding) isn't caught. The passcode gate limits who can try. |
| Unknown model for the chosen provider | `400 invalid_model`, passed through from the provider. |
| Access token missing or expired | `401` with code `locked`. The frontend shows the passcode screen again. |
| Owner's key missing in `server` mode | `503 not_configured`. |
| Daily cap reached | `429 daily_limit_reached`. |
| Model not in `QA_SERVER_MODELS` when using the owner's key | `400 invalid_model` listing the allowed models. |
| Session expired | `404` with code `session_expired`. The frontend starts a new session and asks the user to re-add files. |

## Testing

- Unit tests: parsers (sample PDF/DOCX/XLSX fixtures), the chunker (sizes, overlap,
  boundaries, spreadsheet rows), folder-path cleaning, and the retrieval threshold logic.
- Key modes: which key and model each mode uses, `not_configured`, and the daily cap
  (not counting not-found answers or failed calls).
- An API test that ingests two fixtures, asks a question whose answer is known, and
  checks that the cited file and page are correct.
- A "not found" test that checks the LLM is not called when retrieval returns nothing.

## Layout

```
local-qa/backend/
  app/main.py        FastAPI app, routes, CORS
  app/ingest.py      parsing + chunking
  app/index.py       embeddings + vector search
  app/llm/           prompt building + provider adapters
    base.py, anthropic.py, openai.py, gemini.py, compatible.py
  app/config.py      loads defaults/limits (single source of truth)
  tests/
  requirements.txt
  .env.example       template for local secrets (copy to .env, which is git-ignored)
  Dockerfile
render.yaml          (repo root) Render blueprint for the backend service
```
