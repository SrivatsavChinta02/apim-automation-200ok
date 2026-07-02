import logging
import uuid

from flask import g, request


REQUEST_ID_HEADER = "X-Request-ID"


def install(app):
    """Register before_request / after_request hooks."""

    @app.before_request
    def _assign_request_id():
        incoming = request.headers.get(REQUEST_ID_HEADER, "").strip()
        g.request_id = incoming if _is_valid_uuid(incoming) else str(uuid.uuid4())

    @app.after_request
    def _attach_request_id(response):
        rid = getattr(g, "request_id", None)
        if rid:
            response.headers[REQUEST_ID_HEADER] = rid
        return response


def _is_valid_uuid(s: str) -> bool:
    try:
        uuid.UUID(s)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


class RequestIdFilter(logging.Filter):
    """Inject g.request_id into every log record. Outside a request, sets '-'."""
    def filter(self, record):
        try:
            record.request_id = g.request_id  # type: ignore[attr-defined]
        except (RuntimeError, AttributeError):
            record.request_id = "-"
        return True
