"""Single source of truth for Local Q&A settings.

User-facing parameters (PARAMS) are served at GET /api/qa/config so the frontend can
build its settings panel from them; server settings come from environment variables.
See local-qa/config.md for the documented meaning of every value.
"""
import os
from dataclasses import dataclass


def _env_list(name: str, default: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, default).split(",") if v.strip()]


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    access_passcode: str
    token_secret: str
    access_token_ttl_minutes: int
    rate_limit_auth_per_15min: int
    allowed_providers: list[str]
    embedding_model: str
    allowed_origins: list[str]
    max_file_mb: int
    max_files: int
    max_total_pages: int
    session_ttl_minutes: int
    rate_limit_ask_per_min: int
    rate_limit_ingest_per_hour: int
    llm_timeout_s: int


def load_settings() -> Settings:
    return Settings(
        access_passcode=os.environ.get("QA_ACCESS_PASSCODE", ""),
        token_secret=os.environ.get("QA_TOKEN_SECRET", ""),
        access_token_ttl_minutes=_env_int("QA_ACCESS_TOKEN_TTL_MINUTES", 240),
        rate_limit_auth_per_15min=_env_int("QA_RATE_LIMIT_AUTH_PER_15MIN", 10),
        allowed_providers=_env_list(
            "QA_ALLOWED_PROVIDERS", "anthropic,openai,gemini,openai_compatible"
        ),
        embedding_model=os.environ.get("QA_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"),
        allowed_origins=_env_list(
            "QA_ALLOWED_ORIGINS", "https://ng-04.github.io,http://localhost:8000"
        ),
        max_file_mb=_env_int("QA_MAX_FILE_MB", 20),
        max_files=_env_int("QA_MAX_FILES", 50),
        max_total_pages=_env_int("QA_MAX_TOTAL_PAGES", 1000),
        session_ttl_minutes=_env_int("QA_SESSION_TTL_MINUTES", 60),
        rate_limit_ask_per_min=_env_int("QA_RATE_LIMIT_ASK_PER_MIN", 10),
        rate_limit_ingest_per_hour=_env_int("QA_RATE_LIMIT_INGEST_PER_HOUR", 20),
        llm_timeout_s=_env_int("QA_LLM_TIMEOUT_S", 60),
    )


# group: "answer" and "retrieval" apply to the next question; "indexing" needs a re-index.
PARAMS: dict[str, dict] = {
    "provider": {"group": "answer", "type": "enum", "default": "anthropic",
                 "values": ["anthropic", "openai", "gemini", "openai_compatible"],
                 "help": "Which LLM service answers."},
    "model": {"group": "answer", "type": "string", "default": "claude-opus-5", "max_length": 100,
              "suggestions": {"anthropic": ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]},
              "help": "Model name exactly as the provider spells it."},
    "base_url": {"group": "answer", "type": "string", "default": "", "max_length": 300,
                 "help": "Only for OpenAI-compatible providers, e.g. https://api.groq.com/openai/v1"},
    "temperature": {"group": "answer", "type": "float", "default": 0.2, "min": 0.0, "max": 1.0,
                    "step": 0.05,
                    "help": "Lower sticks closer to the documents' wording; higher phrases more freely. "
                            "Some models (e.g. newer Claude models) ignore it."},
    "reasoning_effort": {"group": "answer", "type": "enum", "default": "low",
                         "values": ["low", "medium", "high"],
                         "help": "How much the model thinks before answering, on models that support it. "
                                 "Higher is slower and costs more."},
    "max_answer_tokens": {"group": "answer", "type": "int", "default": 800, "min": 100, "max": 2000,
                          "step": 50, "help": "Upper bound on answer length."},
    "answer_style": {"group": "answer", "type": "enum", "default": "concise",
                     "values": ["concise", "detailed", "bullet_points"], "help": "Shape of the answer."},
    "history_turns": {"group": "answer", "type": "int", "default": 4, "min": 0, "max": 10, "step": 1,
                      "help": "Earlier Q&A turns sent for follow-up context."},
    "strict_grounding": {"group": "answer", "type": "bool", "default": True,
                         "help": "Refuse to answer from general knowledge."},
    "top_k": {"group": "retrieval", "type": "int", "default": 5, "min": 1, "max": 15, "step": 1,
              "help": "Number of chunks given to the model as context."},
    "min_similarity": {"group": "retrieval", "type": "float", "default": 0.45, "min": 0.0, "max": 0.9,
                       "step": 0.05, "help": "Drop chunks less similar than this to the question."},
    "diversify": {"group": "retrieval", "type": "bool", "default": True,
                  "help": "Avoid near-duplicate chunks (MMR)."},
    "mmr_lambda": {"group": "retrieval", "type": "float", "default": 0.7, "min": 0.0, "max": 1.0,
                   "step": 0.05, "help": "Relevance (1.0) vs diversity (0.0) when diversifying."},
    "chunk_strategy": {"group": "indexing", "type": "enum", "default": "recursive",
                       "values": ["recursive", "fixed", "by_paragraph", "by_page"],
                       "help": "How text is split into chunks."},
    "chunk_size": {"group": "indexing", "type": "int", "default": 800, "min": 200, "max": 2000,
                   "step": 50, "help": "Characters per chunk."},
    "chunk_overlap": {"group": "indexing", "type": "int", "default": 120, "min": 0, "max": 1000,
                      "step": 10, "help": "Characters shared between neighbouring chunks (max half the chunk size)."},
}

INDEXING_KEYS = [k for k, p in PARAMS.items() if p["group"] == "indexing"]


class ParamError(ValueError):
    pass


def resolve_params(raw: dict | None, keys: list[str] | None = None) -> dict:
    """Fill defaults, clamp numbers into range, and reject unknown enum values."""
    raw = raw or {}
    out = {}
    for key in keys or PARAMS:
        spec = PARAMS[key]
        value = raw.get(key, spec["default"])
        if value is None or value == "":
            value = spec["default"]
        t = spec["type"]
        try:
            if t == "int":
                value = min(max(int(value), spec["min"]), spec["max"])
            elif t == "float":
                value = min(max(float(value), spec["min"]), spec["max"])
            elif t == "bool":
                value = value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes", "on")
            elif t == "string":
                value = str(value).strip()[: spec["max_length"]]
        except (TypeError, ValueError):
            raise ParamError(f"{key} must be a {t}")
        if t == "enum" and value not in spec["values"]:
            raise ParamError(f"{key} must be one of {spec['values']}")
        out[key] = value
    if "chunk_overlap" in out and "chunk_size" in out:
        out["chunk_overlap"] = min(out["chunk_overlap"], out["chunk_size"] // 2)
    return out


def public_config(settings: Settings) -> dict:
    params = {k: dict(v) for k, v in PARAMS.items()}
    params["provider"]["values"] = [p for p in params["provider"]["values"] if p in settings.allowed_providers]
    return {
        "params": params,
        "limits": {
            "max_file_mb": settings.max_file_mb,
            "max_files": settings.max_files,
            "max_total_pages": settings.max_total_pages,
            "allowed_extensions": [".pdf", ".docx"],
        },
    }
