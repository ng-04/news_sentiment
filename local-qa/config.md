# Local Q&A — Configuration

The single source of truth for every tunable value. The backend loads this schema in
`app/config.py` and serves it at `GET /api/qa/config`, and the frontend builds the
settings panel from that response.

**User-facing** parameters appear in the Advanced settings panel. **Server** parameters
are set by the operator through environment variables and are never exposed.

## User-facing: answer generation (apply to the next question)

| Key | Default | Range / values | What it does |
|---|---|---|---|
| `temperature` | `0.2` | 0.0 – 1.0 | Lower values stick closely to the documents' wording. Higher values give freer phrasing. **Not every model accepts it.** Claude Opus 4.7+, Opus 5 and Sonnet 5 reject it; Haiku 4.5 and the 4.5/4.6 models accept it. OpenAI reasoning models reject it too. Where it's unsupported it's left out and the answer carries a note saying so. |
| `reasoning_effort` | `low` | `low`, `medium`, `high` | How much the model thinks before answering. Currently applied to Claude models that support effort (Opus 4.5+, Sonnet 4.6+, Sonnet 5). `low` keeps Q&A fast and cheap. |
| `max_answer_tokens` | `800` | 100 – 2000 | Upper bound on answer length. |
| `answer_style` | `concise` | `concise`, `detailed`, `bullet_points` | Adds a style instruction to the system prompt. |
| `provider` | `anthropic` | `anthropic`, `openai`, `gemini`, `openai_compatible` | Which LLM service answers. |
| `model` | `claude-opus-5` | Free text, up to 100 characters | The model name as the provider spells it. For Anthropic the UI suggests `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4-5`; for other providers the user types it. |
| `base_url` | — | `https` URL, only when `provider = openai_compatible` | For example Groq, Mistral, OpenRouter, DeepSeek or Together endpoints. |
| `history_turns` | `4` | 0 – 10 | How many earlier Q&A turns are sent for follow-up context. |
| `strict_grounding` | `true` | boolean | When on, the bot refuses to answer from general knowledge. |

## User-facing: retrieval (apply to the next question)

| Key | Default | Range / values | What it does |
|---|---|---|---|
| `top_k` | `5` | 1 – 15 | Number of chunks given to the LLM as context. |
| `min_similarity` | `0.45` | 0.0 – 0.9 | Chunks below this cosine similarity are dropped. Higher values give fewer but more relevant sources. The default is tuned for `bge-small-en-v1.5`, where unrelated text scores about 0.35–0.40 and real matches 0.6 or more. |
| `diversify` | `true` | boolean | Uses MMR to avoid returning near-duplicate chunks. |
| `mmr_lambda` | `0.7` | 0.0 – 1.0 | Relevance vs. diversity balance when `diversify` is on. |

## User-facing: indexing (need a re-index)

| Key | Default | Range / values | What it does |
|---|---|---|---|
| `chunk_strategy` | `recursive` | `recursive`, `fixed`, `by_paragraph`, `by_page` | How text is split. `recursive` splits on paragraphs, then sentences, then words. |
| `chunk_size` | `800` | 200 – 2000 (characters) | Smaller chunks give precise but narrow context. Larger chunks give broader context with more noise. |
| `chunk_overlap` | `120` | 0 – 50% of `chunk_size` | Characters shared between neighboring chunks so ideas aren't cut in half. |

## Server-only (environment variables)

| Env var | Default | Purpose |
|---|---|---|
| `QA_ACCESS_PASSCODE` | — (required) | The secret passcode users must enter. Set it in the Render dashboard and never commit it. |
| `QA_TOKEN_SECRET` | — (required) | Random string used to sign access tokens. |
| `QA_ACCESS_TOKEN_TTL_MINUTES` | `240` | How long an unlock lasts. |
| `QA_RATE_LIMIT_AUTH_PER_15MIN` | `10` | Passcode attempts per IP. |
| `QA_ALLOWED_PROVIDERS` | `anthropic,openai,gemini,openai_compatible` | Providers users may pick. |
| `QA_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | Local embedding model. |
| `QA_EMBEDDING_CACHE` | fastembed default (`/opt/models` in Docker) | Where the embedding model is stored. The Docker image downloads it at build time. |
| `QA_ALLOWED_ORIGINS` | `https://ng-04.github.io,http://localhost:8000` | CORS. |
| `QA_MAX_FILE_MB` | `20` | Per-file size limit. |
| `QA_MAX_FILES` | `50` | Files per session. |
| `QA_MAX_TOTAL_PAGES` | `1000` | Pages per session. |
| `QA_SESSION_TTL_MINUTES` | `60` | Idle time before a session's index is deleted. |
| `QA_RATE_LIMIT_ASK_PER_MIN` | `10` | Questions per minute per session. |
| `QA_RATE_LIMIT_INGEST_PER_HOUR` | `20` | Ingest calls per hour per IP. |
| `QA_LLM_TIMEOUT_S` | `60` | LLM request timeout. |

## Frontend constants

| Where | Key | Value |
|---|---|---|
| `local-qa/qa-api.js` | `API_BASE` | Backend URL (decided at deploy time). |
| `local-qa/onedrive.js` | `MSAL_CLIENT_ID` | Azure app registration client ID (public, not a secret). |
| `local-qa/onedrive.js` | `MSAL_AUTHORITY` | `https://login.microsoftonline.com/common` (personal and work accounts). |
| `local-qa/onedrive.js` | `GRAPH_SCOPES` | `["Files.Read"]` |
| `localStorage` | `localqa.settings` | The user's saved overrides of the user-facing parameters. |
| `sessionStorage` | `localqa.token` | Access token from `/auth`. |
| `sessionStorage` / `localStorage` | `localqa.apiKey` | The user's LLM API key. Kept in `localStorage` only when "Remember on this device" is checked. |

## Validation rules

- The server clamps every numeric value to its range and rejects enum values it doesn't know.
- `chunk_overlap` must be less than `chunk_size`. The server clamps it to `chunk_size / 2`.
- `provider` must be in `QA_ALLOWED_PROVIDERS`. `base_url` is required for `openai_compatible` and ignored otherwise.
- `temperature` is sent only where the model accepts it. The Anthropic adapter uses a list of known models; the OpenAI adapters retry once without it if the provider rejects it. Either way a `note` event tells the user.
- Models that may think before answering get 4,000 extra tokens on top of `max_answer_tokens`, because thinking counts against the same limit and would otherwise cut off the answer.
- A request whose indexing parameters differ from the ones the index was built with gets
  `409 reindex_required`.
