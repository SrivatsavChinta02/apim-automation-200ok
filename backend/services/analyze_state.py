"""Per-session state for the analyze flow.

Holds a queue of SSE events and a registry of pending confirmations. The
worker thread (running the agentic loop) blocks on `request_confirmation`
when it needs user approval; the user's POST to /confirm sets a threading
Event that unblocks the worker.

This is single-process, single-Flask-instance state. Fine for local dev.
For multi-worker production deployments this would need Redis or similar.
"""
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class PendingConfirmation:
    batch_id: str
    tools: list  # serializable tool descriptors with name, args, mutates, requires_password, preview
    event: threading.Event = field(default_factory=threading.Event)
    result: Optional[dict] = None  # {decision: 'confirm'|'cancel', password?: str}
    created_at: float = field(default_factory=time.time)


@dataclass
class PendingVersionSelection:
    selection_id: str
    api_display_name: str
    versions: list  # list of {id, versionName, revision, isCurrent}
    event: threading.Event = field(default_factory=threading.Event)
    result: Optional[dict] = None  # {version_id: str} or {cancelled: True}
    created_at: float = field(default_factory=time.time)


@dataclass
class AnalyzeSession:
    session_id: str
    event_queue: queue.Queue
    pending: dict  # batch_id -> PendingConfirmation
    pending_versions: dict = field(default_factory=dict)  # selection_id -> PendingVersionSelection
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)


_SESSIONS: dict = {}
_LOCK = threading.Lock()

CONFIRMATION_TIMEOUT_S = 180  # 3 min for user to confirm/cancel
SESSION_IDLE_S = 3600          # 1h before session reclaim


def get_session(session_id: str) -> AnalyzeSession:
    with _LOCK:
        s = _SESSIONS.get(session_id)
        if s is None:
            s = AnalyzeSession(
                session_id=session_id,
                event_queue=queue.Queue(),
                pending={},
                pending_versions={},
            )
            _SESSIONS[session_id] = s
        s.last_active = time.time()
        return s


def request_confirmation(session_id: str, batch_id: str, tools: list) -> dict:
    """Called from the worker thread. Blocks until /confirm resolves it.
    Returns {decision, password?}; on timeout returns {decision: 'cancel', reason: 'timeout'}."""
    session = get_session(session_id)
    pending = PendingConfirmation(batch_id=batch_id, tools=tools)
    session.pending[batch_id] = pending
    # Caller is responsible for emitting the SSE event with batch_id BEFORE calling this.
    if not pending.event.wait(timeout=CONFIRMATION_TIMEOUT_S):
        return {"decision": "cancel", "reason": "timeout"}
    return pending.result or {"decision": "cancel", "reason": "no_result"}


def resolve_confirmation(session_id: str, batch_id: str, decision: str, password: Optional[str] = None) -> bool:
    """Called from the /confirm route. Returns True if pending was found and resolved."""
    session = _SESSIONS.get(session_id)
    if not session:
        return False
    pending = session.pending.get(batch_id)
    if not pending:
        return False
    pending.result = {"decision": decision, "password": password}
    pending.event.set()
    return True


def request_version_selection(session_id: str, selection_id: str, api_display_name: str, versions: list) -> dict:
    """Called from the worker thread. Blocks until /select-version resolves it.
    Returns {version_id: str} or {cancelled: True}; on timeout returns {cancelled: True, reason: 'timeout'}."""
    session = get_session(session_id)
    pending = PendingVersionSelection(selection_id=selection_id, api_display_name=api_display_name, versions=versions)
    session.pending_versions[selection_id] = pending
    # Caller is responsible for emitting the SSE event with selection_id BEFORE calling this.
    if not pending.event.wait(timeout=CONFIRMATION_TIMEOUT_S):
        return {"cancelled": True, "reason": "timeout"}
    return pending.result or {"cancelled": True, "reason": "no_result"}


def resolve_version_selection(session_id: str, selection_id: str, version_id: str) -> bool:
    """Called from the /select-version route. Returns True if pending was found and resolved."""
    session = _SESSIONS.get(session_id)
    if not session:
        return False
    pending = session.pending_versions.get(selection_id)
    if not pending:
        return False
    pending.result = {"version_id": version_id}
    pending.event.set()
    return True


def end_session(session_id: str):
    with _LOCK:
        _SESSIONS.pop(session_id, None)


def reap_idle_sessions():
    """Best-effort cleanup. Call periodically."""
    now = time.time()
    with _LOCK:
        stale = [sid for sid, s in _SESSIONS.items() if now - s.last_active > SESSION_IDLE_S]
        for sid in stale:
            _SESSIONS.pop(sid, None)
