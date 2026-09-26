import json
import time

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import auth
from app.llm.base import Event, LLMError
from tests.conftest import PASSCODE, FakeEmbedder


class FakeAdapter:
    """Stands in for a provider: records the request and answers citing excerpt 1."""

    calls = []
    reply = "The Q2 revenue target was 48 crore rupees [1]."
    error = None

    async def stream(self, req):
        FakeAdapter.calls.append(req)
        if FakeAdapter.error:
            raise FakeAdapter.error
        for word in FakeAdapter.reply.split(" "):
            yield Event("token", word + " ")


@pytest.fixture
def client(settings, monkeypatch):
    FakeAdapter.calls, FakeAdapter.error = [], None
    FakeAdapter.reply = "The Q2 revenue target was 48 crore rupees [1]."
    monkeypatch.setattr(main, "get_adapter", lambda provider: FakeAdapter())
    c = TestClient(main.create_app(settings, FakeEmbedder()))
    token = c.post("/api/qa/auth", json={"passcode": PASSCODE}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {token}"
    return c


def new_session(client):
    return client.post("/api/qa/session").json()["session_id"]


def ingest(client, sid, files, params=None):
    return client.post("/api/qa/ingest", data={"session_id": sid, "params": json.dumps(params or {})},
                       files=[("files", f) for f in files])


def ask(client, sid, question, **extra):
    body = {"session_id": sid, "question": question, "provider": "anthropic", "model": "claude-opus-5", **extra}
    return client.post("/api/qa/ask", json=body, headers={"X-LLM-Key": "sk-ant-test"})


def sse_events(resp):
    events = []
    for block in resp.text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.split("\n"))
        events.append((lines["event"], json.loads(lines["data"])))
    return events


# ---------------------------------------------------------------- access

def test_everything_is_locked_without_token(settings):
    c = TestClient(main.create_app(settings, FakeEmbedder()))
    assert c.get("/api/qa/health").status_code == 200
    r = c.post("/api/qa/session")
    assert r.status_code == 401 and r.json()["code"] == "locked"
    c.headers["Authorization"] = "Bearer 9999999999.forged"
    assert c.post("/api/qa/session").status_code == 401


def test_wrong_passcode_and_rate_limit(settings):
    settings = settings.__class__(**{**settings.__dict__, "rate_limit_auth_per_15min": 2})
    c = TestClient(main.create_app(settings, FakeEmbedder()))
    assert c.post("/api/qa/auth", json={"passcode": "nope"}).json()["code"] == "wrong_passcode"
    c.post("/api/qa/auth", json={"passcode": "nope"})
    assert c.post("/api/qa/auth", json={"passcode": PASSCODE}).status_code == 429


def test_tokens_expire():
    token = auth.issue_token("s", ttl_minutes=0)
    time.sleep(1.1)
    assert not auth.verify_token("s", token)
    assert auth.verify_token("s", auth.issue_token("s", 5))
    assert not auth.verify_token("other", auth.issue_token("s", 5))


def test_unconfigured_server_refuses_unlock(settings):
    settings = settings.__class__(**{**settings.__dict__, "access_passcode": ""})
    c = TestClient(main.create_app(settings, FakeEmbedder()))
    assert c.post("/api/qa/auth", json={"passcode": ""}).status_code == 503


# ---------------------------------------------------------------- ingest

def test_ingest_reports_per_file_status(client, report_pdf, policy_docx):
    sid = new_session(client)
    r = ingest(client, sid, [("report.pdf", report_pdf), ("policy.docx", policy_docx),
                             ("notes.txt", b"hello"), ("broken.pdf", b"%PDF-garbage")])
    files = {f["name"]: f for f in r.json()["files"]}
    assert files["report.pdf"]["status"] == "ready" and files["report.pdf"]["pages"] == 3
    assert files["policy.docx"]["status"] == "ready" and files["policy.docx"]["chunks"] >= 2
    assert files["notes.txt"]["status"] == "failed"
    assert files["broken.pdf"]["status"] == "failed"


def test_oversized_file_is_rejected(client, settings):
    sid = new_session(client)
    big = b"0" * (settings.max_file_mb * 1024 * 1024 + 1)
    assert ingest(client, sid, [("big.pdf", big)]).json()["files"][0]["error"].startswith("larger than")


def test_expired_session(client, report_pdf):
    r = ingest(client, "no-such-session", [("report.pdf", report_pdf)])
    assert r.status_code == 404 and r.json()["code"] == "session_expired"


# ---------------------------------------------------------------- ask

def test_ask_cites_correct_file_and_page(client, report_pdf, policy_docx):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf), ("policy.docx", policy_docx)])
    r = ask(client, sid, "What was the Q2 revenue target?")
    assert r.status_code == 200
    events = sse_events(r)
    kinds = [e[0] for e in events]
    assert kinds[0] == "meta" and kinds[-1] == "done"
    top = events[0][1]["sources"][0]
    assert (top["file_name"], top["page"]) == ("report.pdf", 2)
    assert events[-1][1] == {"not_found": False, "cited": [1], "daily_remaining": None}
    answer = "".join(d["text"] for k, d in events if k == "token")
    assert "48 crore" in answer

    req = FakeAdapter.calls[0]
    assert req.api_key == "sk-ant-test" and req.model == "claude-opus-5"
    assert "48 crore" in req.messages[-1]["content"]  # retrieved excerpt reached the prompt
    assert '<excerpt n="1" source="report.pdf, page 2">' in req.messages[-1]["content"]


def test_no_matching_chunks_skips_llm(client, report_pdf):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf)])
    r = ask(client, sid, "zebra giraffe safari", params={"min_similarity": 0.5})
    events = sse_events(r)
    assert events[-1][1]["not_found"] is True
    assert FakeAdapter.calls == []


def test_retrieval_params_are_applied(client, report_pdf, policy_docx):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf), ("policy.docx", policy_docx)])
    events = sse_events(ask(client, sid, "revenue target", params={"top_k": 1, "min_similarity": 0}))
    assert len(events[0][1]["sources"]) == 1


def test_history_is_trimmed_to_history_turns(client, report_pdf):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf)])
    history = [{"role": r, "content": f"turn {i}"} for i in range(6) for r in ("user", "assistant")]
    ask(client, sid, "revenue target?", history=history, params={"history_turns": 2})
    assert len(FakeAdapter.calls[0].messages) == 5  # 2 turns (4 messages) + the question


def test_llm_errors_become_http_errors(client, report_pdf):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf)])
    FakeAdapter.error = LLMError("invalid_api_key", "The Anthropic API key was rejected.", 401)
    r = ask(client, sid, "revenue target?")
    assert r.status_code == 401 and r.json()["code"] == "invalid_api_key"


def test_missing_key_and_model(client, report_pdf):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf)])
    r = client.post("/api/qa/ask", json={"session_id": sid, "question": "revenue?", "provider": "anthropic",
                                         "model": "claude-opus-5"})
    assert r.json()["code"] == "invalid_api_key"
    assert ask(client, sid, "revenue?", model="").json()["code"] == "invalid_model"


@pytest.mark.parametrize("url", ["http://api.example.com/v1", "https://127.0.0.1/v1",
                                 "https://localhost/v1", "https://169.254.169.254/latest"])
def test_compatible_base_url_blocks_internal_hosts(client, report_pdf, url):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf)])
    r = ask(client, sid, "revenue target?", provider="openai_compatible", model="m", base_url=url)
    assert r.status_code == 400 and r.json()["code"] == "base_url_not_allowed"


# ---------------------------------------------------------------- re-index / delete

def test_changed_indexing_params_require_reindex(client, report_pdf, policy_docx):
    sid = new_session(client)
    ingest(client, sid, [("report.pdf", report_pdf)])
    r = ingest(client, sid, [("policy.docx", policy_docx)], params={"chunk_size": 400})
    assert r.status_code == 409 and r.json()["code"] == "reindex_required"
    assert ask(client, sid, "revenue?", params={"chunk_size": 400}).status_code == 409

    r = client.post("/api/qa/reindex", json={"session_id": sid, "params": {"chunk_size": 400}})
    assert r.status_code == 200 and r.json()["files"][0]["status"] == "ready"
    assert ingest(client, sid, [("policy.docx", policy_docx)], params={"chunk_size": 400}).status_code == 200


def test_delete_and_clear(client, report_pdf, policy_docx):
    sid = new_session(client)
    files = ingest(client, sid, [("report.pdf", report_pdf), ("policy.docx", policy_docx)]).json()["files"]
    report_id = next(f["file_id"] for f in files if f["name"] == "report.pdf")
    assert client.delete(f"/api/qa/documents/{report_id}", params={"session_id": sid}).status_code == 204
    events = sse_events(ask(client, sid, "revenue target", params={"min_similarity": 0}))
    assert all(s["file_name"] == "policy.docx" for s in events[0][1]["sources"])

    client.delete("/api/qa/documents", params={"session_id": sid})
    assert ask(client, sid, "revenue").json()["code"] == "no_documents"


def test_config_is_served(client):
    cfg = client.get("/api/qa/config").json()
    assert cfg["params"]["temperature"]["default"] == 0.2
    assert cfg["limits"]["allowed_extensions"] == [".pdf", ".docx", ".xlsx", ".xlsm"]
    assert cfg["keys"] == {"mode": "user", "server_key": False, "server_models": ["claude-opus-5", "claude-haiku-4-5"],
                           "user_keys": True, "daily_remaining": None}


# ---------------------------------------------------------------- folders and spreadsheets

def test_folder_paths_and_sheets_reach_sources_and_prompt(client, report_pdf, sales_xlsx):
    sid = new_session(client)
    r = client.post("/api/qa/ingest", data={"session_id": sid, "paths": json.dumps(["Board/2026/Q2", "Board/Finance"])},
                    files=[("files", ("report.pdf", report_pdf)), ("files", ("sales.xlsx", sales_xlsx))])
    assert [f["folder"] for f in r.json()["files"]] == ["Board/2026/Q2", "Board/Finance"]

    events = sse_events(ask(client, sid, "South region Q2 revenue", params={"min_similarity": 0}))
    sources = events[0][1]["sources"]
    xl = next(s for s in sources if s["file_name"] == "sales.xlsx" and s["sheet"] == "Revenue")
    assert xl["folder"] == "Board/Finance" and xl["row_start"] >= 2
    assert all(s["folder"] == "Board/2026/Q2" for s in sources if s["file_name"] == "report.pdf")
    prompt = FakeAdapter.calls[0].messages[-1]["content"]
    assert 'source="Board/Finance/sales.xlsx, sheet &quot;Revenue&quot;, rows' in prompt
    assert 'source="Board/2026/Q2/report.pdf, page' in prompt


def test_bad_paths_field(client, report_pdf):
    sid = new_session(client)
    r = client.post("/api/qa/ingest", data={"session_id": sid, "paths": "{not json"},
                    files=[("files", ("report.pdf", report_pdf))])
    assert r.status_code == 400


# ---------------------------------------------------------------- key modes and daily cap

def server_client(settings, monkeypatch, **overrides):
    fields = {**settings.__dict__, "key_mode": "server", "server_api_key": "sk-ant-server", **overrides}
    monkeypatch.setattr(main, "get_adapter", lambda provider: FakeAdapter())
    c = TestClient(main.create_app(settings.__class__(**fields), FakeEmbedder()))
    token = c.post("/api/qa/auth", json={"passcode": PASSCODE}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {token}"
    return c


def test_server_mode_uses_server_key_and_ignores_user_input(settings, monkeypatch, report_pdf):
    c = server_client(settings, monkeypatch)
    sid = new_session(c)
    ingest(c, sid, [("report.pdf", report_pdf)])
    body = {"session_id": sid, "question": "revenue target?", "provider": "openai", "model": ""}
    r = c.post("/api/qa/ask", json=body, headers={"X-LLM-Key": "sk-user"})
    assert r.status_code == 200
    req = FakeAdapter.calls[-1]
    assert (req.provider, req.api_key, req.model) == ("anthropic", "sk-ant-server", "claude-opus-5")
    cfg = c.get("/api/qa/config").json()["keys"]
    assert cfg["server_key"] is True and cfg["user_keys"] is False
    assert "sk-ant-server" not in json.dumps(c.get("/api/qa/config").json())


def test_server_mode_limits_models(settings, monkeypatch, report_pdf):
    c = server_client(settings, monkeypatch)
    sid = new_session(c)
    ingest(c, sid, [("report.pdf", report_pdf)])
    r = c.post("/api/qa/ask", json={"session_id": sid, "question": "revenue target?", "model": "gpt-9", "provider": "anthropic"})
    assert r.status_code == 400 and r.json()["code"] == "invalid_model"
    c.post("/api/qa/ask", json={"session_id": sid, "question": "revenue target?", "model": "claude-haiku-4-5", "provider": "anthropic"})
    assert FakeAdapter.calls[-1].model == "claude-haiku-4-5"


def test_server_mode_without_key_is_not_configured(settings, monkeypatch, report_pdf):
    c = server_client(settings, monkeypatch, server_api_key="")
    sid = new_session(c)
    ingest(c, sid, [("report.pdf", report_pdf)])
    r = c.post("/api/qa/ask", json={"session_id": sid, "question": "revenue target?", "provider": "anthropic"})
    assert r.status_code == 503 and r.json()["code"] == "not_configured"


def test_both_mode_prefers_user_key_when_given(settings, monkeypatch, report_pdf):
    c = server_client(settings, monkeypatch, key_mode="both")
    sid = new_session(c)
    ingest(c, sid, [("report.pdf", report_pdf)])
    c.post("/api/qa/ask", json={"session_id": sid, "question": "revenue target?", "provider": "anthropic", "model": "claude-opus-5"})
    assert FakeAdapter.calls[-1].api_key == "sk-ant-server"
    c.post("/api/qa/ask", json={"session_id": sid, "question": "revenue target?", "provider": "openai", "model": "some-model"},
           headers={"X-LLM-Key": "sk-user"})
    assert (FakeAdapter.calls[-1].provider, FakeAdapter.calls[-1].api_key) == ("openai", "sk-user")


def test_daily_cap_counts_only_answered_server_questions(settings, monkeypatch, report_pdf):
    c = server_client(settings, monkeypatch, daily_question_limit=2)
    sid = new_session(c)
    ingest(c, sid, [("report.pdf", report_pdf)])
    ask_ = lambda q: c.post("/api/qa/ask", json={"session_id": sid, "question": q, "provider": "anthropic"})

    assert sse_events(ask_("zebra giraffe safari"))[-1][1]["not_found"] is True  # no LLM call: not counted
    FakeAdapter.error = LLMError("llm_error", "boom", 502)
    assert ask_("revenue target?").status_code == 502  # provider failed: not counted
    FakeAdapter.error = None
    assert sse_events(ask_("revenue target?"))[-1][1]["daily_remaining"] == 1
    assert sse_events(ask_("revenue target?"))[-1][1]["daily_remaining"] == 0
    r = ask_("revenue target?")
    assert r.status_code == 429 and r.json()["code"] == "daily_limit_reached"
    assert c.get("/api/qa/config").json()["keys"]["daily_remaining"] == 0
