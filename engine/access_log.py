from __future__ import annotations

import logging
import re

_SIGNED_QUERY_RE = re.compile(r"([?&](?:expires|signature)=)[^&\s\"'<>]+", re.IGNORECASE)


def redact_signed_url_query(value: str) -> str:
    """Strip HMAC media tokens from text destined for production log sinks."""
    return _SIGNED_QUERY_RE.sub(r"\1[redacted]", value)


class RedactSignedMediaAccessLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = redact_signed_url_query(message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


def install_uvicorn_access_log_redaction() -> None:
    logging.getLogger("uvicorn.access").addFilter(RedactSignedMediaAccessLogFilter())