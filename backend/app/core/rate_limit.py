import hashlib
import hmac
import time
from collections import defaultdict, deque

from fastapi import HTTPException
from redis.asyncio import Redis

from app.core.config import settings

WINDOW_SECONDS = 15 * 60
MAX_AUTH_ATTEMPTS = 10
_local: dict[str, deque[float]] = defaultdict(deque)
_local_call_count = 0
_client: Redis | None = None


def _key(scope: str, identity: str) -> str:
    normalized = identity.strip().casefold()
    digest = hmac.new(
        settings.session_pepper_value.encode(),
        f"{scope}\0{normalized}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"gradeflow:auth-rate:v1:{scope}:{digest}"


def _local_increment(key: str, now: float) -> int:
    global _local_call_count
    _local_call_count += 1
    if _local_call_count % 250 == 0:
        for old_key, bucket in list(_local.items()):
            while bucket and now - bucket[0] >= WINDOW_SECONDS:
                bucket.popleft()
            if not bucket:
                _local.pop(old_key, None)
    bucket = _local[key]
    while bucket and now - bucket[0] >= WINDOW_SECONDS:
        bucket.popleft()
    bucket.append(now)
    return len(bucket)


async def _redis_increment(key: str) -> tuple[int, int]:
    global _client
    if _client is None:
        if not settings.rate_limit_url_value:
            raise RuntimeError("shared authentication rate limiter is not configured")
        _client = Redis.from_url(
            settings.rate_limit_url_value,
            decode_responses=False,
            socket_connect_timeout=1,
            socket_timeout=1,
            health_check_interval=30,
        )
    result = await _client.eval(
        "local count=redis.call('INCR',KEYS[1]); "
        "if count==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; "
        "local ttl=redis.call('TTL',KEYS[1]); return {count,ttl}",
        1,
        key,
        WINDOW_SECONDS,
    )
    return int(result[0]), max(int(result[1]), 1)


async def enforce_auth_attempts(scope: str, identity: str) -> None:
    """Enforce an account-scoped limit without persisting the account address."""
    key = _key(scope, identity)
    if settings.rate_limit_url_value:
        try:
            count, retry_after = await _redis_increment(key)
        except Exception as exc:
            if settings.environment.lower() != "development":
                raise HTTPException(
                    503, "Authentication throttling is temporarily unavailable. Retry shortly."
                ) from exc
            count = _local_increment(key, time.monotonic())
            retry_after = WINDOW_SECONDS
    elif settings.environment.lower() == "development":
        count = _local_increment(key, time.monotonic())
        retry_after = WINDOW_SECONDS
    else:
        raise HTTPException(503, "Authentication throttling is not configured.")

    if count > MAX_AUTH_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail="Too many attempts for this account. Wait before trying again.",
            headers={"Retry-After": str(retry_after)},
        )


async def close_rate_limiter() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
