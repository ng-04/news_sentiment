"""Local Q&A API: passcode gate, document ingestion, and grounded question answering."""
import asyncio
import json
import re
import secrets
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import auth
from .config import INDEXING_KEYS, ParamError, Settings, load_settings, public_config, resolve_params
from .index import Embedder
from .ingest import SUPPORTED_EXTENSIONS, ParseError, chunk_file, expand_zip, normalize_folder, parse_file
from .llm.base import NOT_FOUND_SENTENCE, LLMError, LLMRequest, build_prompt, check_base_url, get_adapter
from .sessions import Session, SessionStore, StoredFile


class APIError(HTTPException):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(status_code=status, detail={"code": code, "message": message})


class AuthBody(BaseModel):
    passcode: str = Field(max_length=200)


class SessionBody(BaseModel):
    session_id: str


class Turn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=8000)


class LLMBody(BaseModel):
    provider: str
    model: str = ""
    base_url: str = ""


class AskBody(LLMBody):
    session_id: str
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = []
    params: dict = {}


class ReindexBody(SessionBody):
    params: dict = {}


def create_app(settings: Settings | None = None, embedder: Embedder | None = None) -> FastAPI:
    settings = settings or load_settings()
    embedder = embedder or Embedder(settings.embedding_model)
    store = SessionStore(settings.session_ttl_minutes)
    auth_limit = auth.RateLimiter(settings.rate_limit_auth_per_15min, 15 * 60)
    ingest_limit = auth.RateLimiter(settings.rate_limit_ingest_per_hour, 3600)
    ask_limit = auth.RateLimiter(settings.rate_limit_ask_per_min, 60)
    server_quota = auth.DailyCounter(settings.daily_question_limit)
    configured = bool(settings.access_passcode and settings.token_secret)

    app = FastAPI(title="Local Q&A", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-LLM-Key"],
    )

    @app.exception_handler(HTTPException)
    async def _http_error(_, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse(detail, status_code=exc.status_code)

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    def require_access(authorization: str = Header("")):
        token = authorization.removeprefix("Bearer ").strip()
        if not configured or not auth.verify_token(settings.token_secret, token):
            raise APIError(401, "locked", "Enter the passcode to continue.")

    def get_session(session_id: str) -> Session:
        session = store.get(session_id)
        if not session:
            raise APIError(404, "session_expired", "Your session expired. Please add your documents again.")
        return session

    def params_or_400(raw: dict, keys=None) -> dict:
        try:
            return resolve_params(raw, keys)
        except ParamError as e:
            raise APIError(400, "invalid_param", str(e))

    # ------------------------------------------------------------ open endpoints

    open_routes = APIRouter(prefix="/api/qa")

    @open_routes.get("/health")
    async def health():
        return {"ok": True}

    @open_routes.post("/auth")
    async def unlock(body: AuthBody, request: Request):
        if not configured:
            raise APIError(503, "not_configured", "The server has no passcode configured yet.")
        if not auth_limit.allow(client_ip(request)):
            raise APIError(429, "rate_limited", "Too many attempts. Wait a few minutes and try again.")
        if not auth.check_passcode(body.passcode, settings.access_passcode):
            raise APIError(401, "wrong_passcode", "That passcode isn't right.")
        return {"access_token": auth.issue_token(settings.token_secret, settings.access_token_ttl_minutes),
                "expires_in": settings.access_token_ttl_minutes * 60}

    # ------------------------------------------------------------ gated endpoints

    api = APIRouter(prefix="/api/qa", dependencies=[Depends(require_access)])

    @api.get("/config")
    async def config():
        cfg = public_config(settings)
        cfg["keys"]["daily_remaining"] = server_quota.remaining() if cfg["keys"]["server_key"] else None
        return cfg

    @api.post("/session")
    async def new_session():
        return {"session_id": store.create().session_id}

    @api.post("/ingest")
    async def ingest(request: Request, session_id: str = Form(...), params: str = Form("{}"),
                     paths: str = Form("[]"), files: list[UploadFile] = File(...)):
        """`paths` is an optional JSON list, parallel to `files`, of each file's folder
        relative to the folder the user chose (e.g. "2026/Q2"); "" means the top level."""
        if not ingest_limit.allow(client_ip(request)):
            raise APIError(429, "rate_limited", "Too many uploads this hour. Try again later.")
        session = get_session(session_id)
        indexing = params_or_400(_json_or_400(params), INDEXING_KEYS)
        folders = _json_or_400(paths, list)
        async with session.lock:
            if session.files and session.indexing_params != indexing:
                raise APIError(409, "reindex_required",
                               "Indexing settings changed. Re-index your documents before adding more.")
            session.indexing_params = indexing
            results = []
            for i, upload in enumerate(files):
                folder = normalize_folder(str(folders[i])) if i < len(folders) and folders[i] else ""
                if (upload.filename or "").lower().endswith(".zip"):
                    results.extend(await _ingest_zip(session, upload, folder, indexing))
                else:
                    results.append(await _ingest_one(session, upload, folder, indexing))
        return {"files": results}

    def _failed(name: str, folder: str, reason: str) -> dict:
        return {"file_id": None, "name": name, "folder": folder, "pages": None,
                "chunks": 0, "status": "failed", "error": reason}

    async def _ingest_zip(session: Session, upload: UploadFile, folder: str, indexing: dict) -> list[dict]:
        name = (upload.filename or "upload.zip").rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:200]
        limit = settings.max_zip_mb * 1024 * 1024
        data = await upload.read(limit + 1)
        if len(data) > limit:
            return [_failed(name, folder, f"zip larger than {settings.max_zip_mb} MB")]
        room = max(0, settings.max_files - len(session.files))
        try:
            entries, skipped = await asyncio.to_thread(
                expand_zip, name, data, settings.max_file_mb * 1024 * 1024, room,
                settings.max_total_pages * 2 * 1024 * 1024)
        except ParseError as e:
            return [_failed(name, folder, str(e))]
        results = [await _ingest_bytes(session, base, normalize_folder(f"{folder}/{sub}" if folder else sub),
                                       content, indexing) for base, sub, content in entries]
        for path, reason in skipped:
            sub_folder, _, base = path.rpartition("/")
            results.append(_failed(base, normalize_folder(f"{folder}/{sub_folder}" if folder else sub_folder), reason))
        return results

    async def _ingest_one(session: Session, upload: UploadFile, folder: str, indexing: dict) -> dict:
        name = (upload.filename or "file").rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:200]
        if not name.lower().endswith(SUPPORTED_EXTENSIONS):
            return _failed(name, folder, "unsupported file type (only .pdf, .docx, .xlsx, .xlsm and .zip)")
        limit = settings.max_file_mb * 1024 * 1024
        data = await upload.read(limit + 1)
        if len(data) > limit:
            return _failed(name, folder, f"larger than {settings.max_file_mb} MB")
        return await _ingest_bytes(session, name, folder, data, indexing)

    async def _ingest_bytes(session: Session, name: str, folder: str, data: bytes, indexing: dict) -> dict:
        fail = lambda reason: _failed(name, folder, reason)
        if len(session.files) >= settings.max_files:
            return fail(f"file limit reached ({settings.max_files} per session)")
        try:
            parsed = await asyncio.to_thread(parse_file, name, data)
        except ParseError as e:
            return fail(str(e))
        parsed.folder = folder
        if session.page_equivalents + parsed.page_equivalent > settings.max_total_pages:
            return fail(f"would exceed the {settings.max_total_pages}-page limit for this session")
        file_id = secrets.token_urlsafe(8)
        chunks = chunk_file(file_id, parsed, indexing["chunk_strategy"],
                            indexing["chunk_size"], indexing["chunk_overlap"])
        vectors = await asyncio.to_thread(embedder.embed_passages, [c.text for c in chunks])
        session.index.add(chunks, vectors)
        session.files[file_id] = StoredFile(file_id=file_id, parsed=parsed, chunks=len(chunks))
        return _file_result(session.files[file_id])

    @api.post("/reindex")
    async def reindex(body: ReindexBody):
        session = get_session(body.session_id)
        indexing = params_or_400(body.params, INDEXING_KEYS)
        async with session.lock:
            session.index = type(session.index)()
            session.indexing_params = indexing
            results = []
            for f in session.files.values():
                chunks = chunk_file(f.file_id, f.parsed, indexing["chunk_strategy"],
                                    indexing["chunk_size"], indexing["chunk_overlap"])
                session.index.add(chunks, await asyncio.to_thread(embedder.embed_passages,
                                                                  [c.text for c in chunks]))
                f.chunks = len(chunks)
                results.append(_file_result(f))
        return {"files": results}

    @api.delete("/documents/{file_id}", status_code=204)
    async def delete_document(file_id: str, session_id: str):
        session = get_session(session_id)
        async with session.lock:
            if session.files.pop(file_id, None):
                session.index.remove_file(file_id)
        return Response(status_code=204)

    @api.delete("/documents", status_code=204)
    async def clear_documents(session_id: str):
        session = get_session(session_id)
        async with session.lock:
            session.files.clear()
            session.index = type(session.index)()
            session.indexing_params = None
        return Response(status_code=204)

    def _use_server_key(x_llm_key: str) -> bool:
        if settings.key_mode == "server":
            return True
        if settings.key_mode == "user":
            return False
        return not x_llm_key.strip()  # "both": the server key unless the user brought one

    async def _llm_request(body: LLMBody, x_llm_key: str, answer: dict, system: str, messages: list[dict],
                           max_tokens: int | None = None) -> tuple[LLMRequest, bool]:
        """Build the provider request. Returns it plus whether it runs on the server's key."""
        common = dict(system=system, messages=messages, temperature=answer["temperature"],
                      max_tokens=max_tokens or answer["max_answer_tokens"],
                      effort=answer["reasoning_effort"], timeout_s=settings.llm_timeout_s)
        if _use_server_key(x_llm_key):
            if not settings.server_api_key:
                raise APIError(503, "not_configured", "The server has no API key configured yet.")
            model = body.model.strip() or settings.server_models[0]
            if model not in settings.server_models:
                raise APIError(400, "invalid_model",
                               f"Choose one of: {', '.join(settings.server_models)}.")
            return LLMRequest(provider="anthropic", model=model, api_key=settings.server_api_key,
                              **common), True

        if body.provider not in settings.allowed_providers:
            raise APIError(400, "invalid_provider", "That provider isn't enabled on this server.")
        if not x_llm_key.strip():
            raise APIError(401, "invalid_api_key", "Enter an API key for the selected provider.")
        model = body.model.strip()[:100]
        if not model:
            raise APIError(400, "invalid_model", "Enter a model name.")
        base_url = None
        if body.provider == "openai_compatible":
            if not body.base_url.strip():
                raise APIError(400, "base_url_not_allowed", "Enter the provider's base URL.")
            try:
                base_url = await check_base_url(body.base_url.strip())
            except LLMError as e:
                raise APIError(e.status, e.code, e.message)
        return LLMRequest(provider=body.provider, model=model, api_key=x_llm_key.strip(),
                          base_url=base_url, **common), False

    @api.post("/test-llm")
    async def test_llm(body: LLMBody, x_llm_key: str = Header("")):
        if _use_server_key(x_llm_key):
            return {"ok": True, "server_key": True}  # nothing for the user to test
        req, _ = await _llm_request(body, x_llm_key, resolve_params({}), "Reply with the single word OK.",
                                    [{"role": "user", "content": "Say OK."}], max_tokens=16)
        try:
            async for _ in get_adapter(req.provider).stream(req):
                pass
        except LLMError as e:
            raise APIError(e.status, e.code, e.message)
        return {"ok": True, "server_key": False}

    @api.post("/ask")
    async def ask(body: AskBody, x_llm_key: str = Header("")):
        session = get_session(body.session_id)
        if not ask_limit.allow(session.session_id):
            raise APIError(429, "rate_limited", "Too many questions in a minute. Slow down a little.")
        p = params_or_400(body.params)
        if not session.files:
            raise APIError(400, "no_documents", "Add at least one document first.")
        indexing = {k: p[k] for k in INDEXING_KEYS}
        if body.params and any(k in body.params for k in INDEXING_KEYS) and indexing != session.indexing_params:
            raise APIError(409, "reindex_required", "Indexing settings changed. Re-index to apply them.")

        history = [t.model_dump() for t in body.history][-2 * p["history_turns"]:] if p["history_turns"] else []
        query_vec = await asyncio.to_thread(_query_vector, embedder, body.question, history)
        hits = session.index.search(query_vec, p["top_k"], p["min_similarity"], p["diversify"], p["mmr_lambda"])
        sources = [_source(n, h) for n, h in enumerate(hits, start=1)]

        if not hits:
            async def not_found():
                yield _sse("meta", {"sources": []})
                yield _sse("token", {"text": NOT_FOUND_SENTENCE})
                yield _sse("done", {"not_found": True, "cited": []})
            return StreamingResponse(not_found(), media_type="text/event-stream")

        system, messages = build_prompt(body.question, hits, history, p["answer_style"], p["strict_grounding"])
        req, on_server_key = await _llm_request(body, x_llm_key, p, system, messages)
        if on_server_key and server_quota.remaining() == 0:
            raise APIError(429, "daily_limit_reached",
                           "Today's question limit for this site has been reached. Try again tomorrow.")
        events = get_adapter(req.provider).stream(req)
        # Pull the first event before responding, so key/model errors come back as a normal
        # HTTP error instead of a half-open stream.
        try:
            first = await anext(events, None)
        except LLMError as e:
            raise APIError(e.status, e.code, e.message)
        if on_server_key:
            server_quota.take()  # counted only once the provider accepted the request

        async def stream():
            answer = []
            yield _sse("meta", {"sources": sources})
            try:
                event = first
                while event is not None:
                    if event.kind == "token":
                        answer.append(event.text)
                    yield _sse(event.kind, {"text": event.text})
                    event = await anext(events, None)
            except LLMError as e:
                yield _sse("error", {"code": e.code, "message": e.message})
                return
            text = "".join(answer).strip()
            cited = sorted({int(n) for n in re.findall(r"\[(\d+)\]", text) if 1 <= int(n) <= len(sources)})
            yield _sse("done", {"not_found": text.startswith(NOT_FOUND_SENTENCE[:-1]), "cited": cited,
                                "daily_remaining": server_quota.remaining() if on_server_key else None})

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    app.include_router(open_routes)
    app.include_router(api)
    return app


def _query_vector(embedder: Embedder, question: str, history: list[dict]) -> np.ndarray:
    """Embed the question; blend in the previous user question so follow-ups like
    "what about last year?" still retrieve the right passages."""
    q = embedder.embed_query(question)
    previous = next((t["content"] for t in reversed(history) if t["role"] == "user"), None)
    if previous:
        q = 0.75 * q + 0.25 * embedder.embed_query(previous)
        q = q / (np.linalg.norm(q) or 1)
    return q


def _source(n: int, hit) -> dict:
    c = hit.chunk
    return {"n": n, "file_id": c.file_id, "file_name": c.file_name, "folder": c.folder, "page": c.page,
            "section": c.section, "sheet": c.sheet, "row_start": c.row_start, "row_end": c.row_end,
            "score": round(hit.score, 3), "snippet": c.text}


def _file_result(f: StoredFile) -> dict:
    return {"file_id": f.file_id, "name": f.parsed.name, "folder": f.parsed.folder, "pages": f.parsed.pages,
            "chunks": f.chunks, "status": "ready", "error": None}


def _json_or_400(raw: str, kind: type = dict):
    try:
        value = json.loads(raw) if raw else kind()
    except json.JSONDecodeError:
        raise APIError(400, "invalid_param", "form fields params and paths must be JSON")
    if not isinstance(value, kind):
        raise APIError(400, "invalid_param", f"expected a JSON {'object' if kind is dict else 'list'}")
    return value


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# Local development reads secrets (ANTHROPIC_API_KEY, QA_ACCESS_PASSCODE, ...) from a
# git-ignored backend/.env; on Render they come from the service's environment instead.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
app = create_app()
