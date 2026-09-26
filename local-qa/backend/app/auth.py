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


class DailyCounter:
    """Counts events per UTC day (e.g. questions answered on the server's key).

    Kept in memory, so it restarts at zero when the server restarts; it's a guard against
    runaway use, not billing. A limit of 0 means unlimited.
    """

    def __init__(self, limit: int):
        self.limit = limit
        self._day, self._count = None, 0

    def _roll(self):
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if today != self._day:
            self._day, self._count = today, 0

    def remaining(self) -> int | None:
        if not self.limit:
            return None
        self._roll()
        return max(0, self.limit - self._count)

    def take(self) -> bool:
        self._roll()
        if self.limit and self._count >= self.limit:
            return False
        self._count += 1
        return True
