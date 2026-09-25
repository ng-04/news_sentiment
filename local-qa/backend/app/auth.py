"""Passcode gate, signed access tokens, and simple in-memory rate limits."""
import base64
import hashlib
import hmac
import time
from collections import defaultdict, deque


def check_passcode(given: str, expected: str) -> bool:
    if not expected:
        return False
    return hmac.compare_digest(given.encode(), expected.encode())


def issue_token(secret: str, ttl_minutes: int) -> str:
    exp = str(int(time.time()) + ttl_minutes * 60)
    return f"{exp}.{_sign(secret, exp)}"


def verify_token(secret: str, token: str) -> bool:
    try:
        exp, sig = token.split(".", 1)
    except ValueError:
        return False
    return hmac.compare_digest(sig, _sign(secret, exp)) and int(exp) > time.time()


def _sign(secret: str, payload: str) -> str:
    mac = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


class RateLimiter:
    """Sliding-window limiter keyed by an arbitrary string (IP, session id, ...)."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window = limit, window_s
        self._hits: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self._hits[key]
        while q and q[0] <= now - self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True
