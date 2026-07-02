"""Per-session in-memory cache for read tools."""
import hashlib
import json
import threading
import time

# Key = (session_id, tool_name, args_hash) -> (timestamp, result)
_CACHE: dict[tuple[str, str, str], tuple[float, object]] = {}
_LOCK = threading.Lock()
_DEFAULT_TTL_S = 60


def _hash_args(args: dict) -> str:
    return hashlib.sha256(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()[:16]


def get(session_id: str, tool_name: str, args: dict, ttl: int = _DEFAULT_TTL_S):
    key = (session_id, tool_name, _hash_args(args))
    with _LOCK:
        entry = _CACHE.get(key)
        if entry and time.time() - entry[0] < ttl:
            return entry[1]
    return None


def put(session_id: str, tool_name: str, args: dict, result):
    key = (session_id, tool_name, _hash_args(args))
    with _LOCK:
        _CACHE[key] = (time.time(), result)


def invalidate_session(session_id: str):
    with _LOCK:
        keys = [k for k in _CACHE if k[0] == session_id]
        for k in keys:
            del _CACHE[k]


def invalidate_tool_for_env(session_id: str, tool_name: str, env: str):
    """Used by mutating tools (Phase 3B) to invalidate read-tool caches that overlap."""
    with _LOCK:
        # Brute-force: drop all entries for the tool in this session — the cache
        # is small per session so this is cheaper than scanning args.
        keys = [k for k in _CACHE if k[0] == session_id and k[1] == tool_name]
        for k in keys:
            del _CACHE[k]
