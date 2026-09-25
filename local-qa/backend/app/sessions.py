"""Per-session document stores, kept only in memory and dropped after an idle TTL."""
import asyncio
import secrets
import time
from dataclasses import dataclass, field

from .index import VectorIndex
from .ingest import ParsedFile


@dataclass
class StoredFile:
    file_id: str
    parsed: ParsedFile  # raw text kept so /reindex can re-chunk without a re-upload
    chunks: int


@dataclass
class Session:
    session_id: str
    files: dict[str, StoredFile] = field(default_factory=dict)
    index: VectorIndex = field(default_factory=VectorIndex)
    indexing_params: dict | None = None  # params the current index was built with
    last_used: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def page_equivalents(self) -> int:
        return sum(f.parsed.page_equivalent for f in self.files.values())


class SessionStore:
    def __init__(self, ttl_minutes: int):
        self.ttl = ttl_minutes * 60
        self._sessions: dict[str, Session] = {}

    def create(self) -> Session:
        self.sweep()
        s = Session(session_id=secrets.token_urlsafe(24))
        self._sessions[s.session_id] = s
        return s

    def get(self, session_id: str) -> Session | None:
        self.sweep()
        s = self._sessions.get(session_id)
        if s:
            s.last_used = time.monotonic()
        return s

    def sweep(self):
        cutoff = time.monotonic() - self.ttl
        for sid in [sid for sid, s in self._sessions.items() if s.last_used < cutoff]:
            del self._sessions[sid]
