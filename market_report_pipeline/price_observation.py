"""Preserve provider evidence without changing report collection decisions."""

from datetime import datetime, timezone
import gzip
import hashlib
import json
import logging
import os
from pathlib import Path
from uuid import uuid4


def utc_stamp():
    return datetime.now(timezone.utc).isoformat()


def save_observation(directory, *, symbol, url, params, expected, started, response,
                     ready, error, attempt):
    directory = directory or os.environ.get("PRICE_DIAGNOSTICS_DIR")
    if not directory:
        return
    try:
        target = Path(directory)
        target.mkdir(parents=True, exist_ok=True)
        identity = uuid4().hex
        raw = response.content if response is not None else None
        row = {"schemaVersion": 1, "symbol": symbol, "url": url, "params": params,
               "expectedSession": str(expected.date()) if expected is not None else None,
               "startedAt": started, "finishedAt": utc_stamp(), "attempt": attempt,
               "parserReady": ready, "error": error, "codeSha": os.environ.get("GITHUB_SHA", "local"),
               "runId": os.environ.get("GITHUB_RUN_ID", "local"),
               "status": response.status_code if response is not None else None,
               "responseUrl": response.url if response is not None else None,
               "headers": {k: v for k, v in response.headers.items()
                           if k.lower() in {"date", "age", "cache-control", "content-type", "etag", "via", "server", "retry-after"}} if response is not None else {}}
        if raw is not None:
            row["rawFile"] = identity + ".body.gz"
            row["rawSha256"] = hashlib.sha256(raw).hexdigest()
            (target / row["rawFile"]).write_bytes(gzip.compress(raw))
        (target / (identity + ".json")).write_text(json.dumps(row, ensure_ascii=False, default=str), encoding="utf-8")
    except Exception:
        # A diagnostic storage failure must not turn valid prices into a collection failure.
        logging.getLogger(__name__).exception("PRICE_DIAGNOSTIC_WRITE_FAILED")
