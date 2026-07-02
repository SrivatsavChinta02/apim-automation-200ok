import logging
import os
import re
import sys
from logging.handlers import RotatingFileHandler

from pythonjsonlogger import jsonlogger


class _FlushingStreamHandler(logging.Handler):
    """Writes directly to file descriptor 1 (stdout) at emit time, bypassing
    any per-thread sys.stdout replacement that Werkzeug debug mode + colorama
    may have wrapped around the original stream. Resolving stdout at emit
    time (not __init__) is what makes Windows PowerShell consistently show
    request-time log lines, not just startup lines."""

    def emit(self, record):
        try:
            msg = self.format(record) + "\n"
            try:
                os.write(1, msg.encode("utf-8", errors="replace"))
            except OSError:
                # If fd 1 is closed/invalid, fall back to sys.__stdout__.
                sys.__stdout__.write(msg)
                sys.__stdout__.flush()
        except Exception:
            self.handleError(record)

# JSON format used for the rotating file (machine-readable for tooling).
JSON_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(request_id)s %(message)s"

# ANSI escape sequences (color/style codes). Werkzeug embeds these in its
# startup banner — they look like garbage in our JSON output and in any
# non-ANSI-aware terminal.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class _StripAnsiFilter(logging.Filter):
    """Strip ANSI escape codes from log messages before formatting."""

    def filter(self, record):
        if isinstance(record.msg, str) and "\x1b[" in record.msg:
            record.msg = _ANSI_RE.sub("", record.msg)
        return True


# `extra={...}` fields we want to surface inline on stdout. JSON file already
# captures everything; this list keeps the human terminal scannable without
# requiring devs to grep the .log file for the query body.
_HUMAN_EXTRA_KEYS = (
    "query", "intent", "template", "missing", "invalid",
    "error", "api_id", "backend_id", "src", "dest", "env",
    "status", "attempt", "max_attempts", "path", "label", "will_retry",
    "debug_xml",
)


class _HumanFormatter(logging.Formatter):
    """One-line, scannable terminal output. Compact request_id, padded fields."""

    def format(self, record):
        rid = getattr(record, "request_id", "-")
        short_rid = rid[:8] if rid and rid != "-" else "-"
        ts = self.formatTime(record, "%H:%M:%S")
        name = record.name if len(record.name) <= 28 else "…" + record.name[-27:]
        msg = record.getMessage()
        extras = []
        for key in _HUMAN_EXTRA_KEYS:
            val = getattr(record, key, None)
            if val is None or val == "" or val == [] or val == {}:
                continue
            extras.append(f"{key}={val!r}")
        if extras:
            msg = f"{msg} | {' '.join(extras)}"
        return f"{ts} {record.levelname:<7} {name:<28} [{short_rid}] {msg}"


def configure_logging():
    """Configure root logger once. Idempotent: safe to call repeatedly."""
    log_dir = os.environ.get("LOG_DIR", "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "apim-admin.log")

    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    root.setLevel(level)

    # File handler: structured JSON for grepping/tooling later.
    file_handler = RotatingFileHandler(
        log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(jsonlogger.JsonFormatter(JSON_LOG_FORMAT))
    file_handler.setLevel(level)
    root.addHandler(file_handler)

    # Stream handler: writes directly to fd 1 at emit time. See
    # _FlushingStreamHandler docstring for why this dance is necessary on
    # Windows / Werkzeug debug.
    stream_handler = _FlushingStreamHandler()
    stream_handler.setFormatter(_HumanFormatter())
    stream_handler.setLevel(level)
    root.addHandler(stream_handler)

    # Inject g.request_id into every record (or '-' outside a request).
    # Local import to avoid circular at module load.
    from utils.request_context import RequestIdFilter
    rid_filter = RequestIdFilter()
    ansi_filter = _StripAnsiFilter()
    for h in (file_handler, stream_handler):
        h.addFilter(rid_filter)
        h.addFilter(ansi_filter)

    # Quiet down chatty third-party loggers. None of these add signal during
    # normal use; their noise drowns out the messages we actually wrote.
    for noisy, lvl in {
        "urllib3":              logging.WARNING,
        "werkzeug":             logging.INFO,    # keep access lines
        "werkzeug._reloader":   logging.ERROR,   # suppress watchdog spam
        "watchdog":             logging.ERROR,
        "httpx":                logging.WARNING,
        "httpcore":             logging.WARNING,
        "anthropic":            logging.WARNING,
        "anthropic._base_client": logging.WARNING,
        "msal":                 logging.WARNING,
        "msal.authority":       logging.WARNING,
        "msal.application":     logging.WARNING,
    }.items():
        logging.getLogger(noisy).setLevel(lvl)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
