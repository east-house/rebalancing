"""Read-only, full-universe endpoint and availability-time observations."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import gzip
import hashlib
import json
import math
import os
import time
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile, ZIP_DEFLATED

import pandas as pd

from .io_utils import write_json
from .price_observation import utc_stamp
from .report_time import KST, expected_market_date, korean_today, report_context
from .support import _download_yahoo_frame, fetch_sp500_snapshot
from .us_market_report import load_config


def raw_readiness(body, session):
    """Inspect raw OHLC independently of the production adjusted-price parser."""
    payload = json.loads(body)["chart"]["result"][0]
    quote = payload["indicators"]["quote"][0]
    rows = []
    for i, stamp in enumerate(payload.get("timestamp") or []):
        if pd.Timestamp(stamp, unit="s", tz="UTC").date().isoformat() != session:
            continue
        values = {key: quote.get(key, [])[i] if i < len(quote.get(key, [])) else None
                  for key in ["open", "high", "low", "close"]}
        rows.append(values)
    complete = any(all(isinstance(v, (int, float)) and math.isfinite(v) for v in row.values()) for row in rows)
    return complete, rows


def summarize_pair(rows):
    by_server = {"query1" if "query1.finance" in row["url"] else "query2": row for row in rows}
    if len(by_server) != 2:
        return {"classification": "missing_observation", "servers": by_server}
    values = list(by_server.values())
    skew = abs((datetime.fromisoformat(values[0]["startedAt"]) - datetime.fromisoformat(values[1]["startedAt"])).total_seconds())
    if any(row.get("rawReady") and not row["parserReady"] for row in values):
        kind = "raw_complete_parser_failed"
    elif any(row.get("status") != 200 or row.get("rawReady") is None for row in values):
        kind = "transport_or_invalid_response"
    elif skew > 5:
        kind = "comparison_time_skew"
    elif values[0]["rawReady"] != values[1]["rawReady"]:
        kind = "endpoint_readiness_difference"
    elif all(row["rawReady"] and row["parserReady"] for row in values):
        kind = "both_ready"
    elif all(row["parserReady"] for row in values):
        kind = "parser_ready_raw_incomplete"
    else:
        kind = "both_incomplete"
    return {"classification": kind, "requestStartSkewSeconds": skew, "servers": by_server}


def timing_report(observations, minimum_sessions=10):
    sessions = {}
    for row in observations:
        sessions.setdefault(row["marketSessionDate"], []).append(row)
    days = []
    for session, rows in sorted(sessions.items()):
        rows.sort(key=lambda row: row["startedAt"])
        successes = [row for row in rows if row["allBothReady"]]
        first = successes[0] if successes else None
        failures_before = [row for row in rows if not row["allBothReady"] and
                           (first is None or row["finishedAt"] < first["startedAt"])]
        later_failure = any(not row["allBothReady"] and row["startedAt"] > first["finishedAt"] for row in rows) if first else False
        symbol_timing = {}
        for symbol in sorted({symbol for row in rows for symbol in row.get("symbolObservations", {})}):
            samples = sorted([row["symbolObservations"][symbol] for row in rows if symbol in row.get("symbolObservations", {})], key=lambda sample: sample["observedAt"])
            first_ready = next((sample["observedAt"] for sample in samples if sample["bothReady"]), None)
            missing = [sample["observedAt"] for sample in samples if not sample["bothReady"] and (first_ready is None or sample["observedAt"] < first_ready)]
            symbol_timing[symbol] = {"firstReadyObservedAt": first_ready,
                                     "lastNotReadyBeforeFirstReady": missing[-1] if missing else None,
                                     "regressedAfterReady": any(not sample["bothReady"] and sample["observedAt"] > first_ready for sample in samples) if first_ready else False}
        days.append({"marketSessionDate": session, "observations": len(rows),
                     "symbols": symbol_timing,
                     "lastNotReadyObservedAt": failures_before[-1]["finishedAt"] if failures_before else None,
                     "firstAllReadyObservedAt": first["finishedAt"] if first else None,
                     "firstAllReadyKst": datetime.fromisoformat(first["finishedAt"]).astimezone(KST).isoformat() if first else None,
                     "minutesAfterClose": first["minutesAfterCloseAtFinish"] if first else None,
                     "regressedAfterReady": later_failure,
                     "maxObservationGapMinutes": max([(datetime.fromisoformat(b["startedAt"]) - datetime.fromisoformat(a["startedAt"])).total_seconds() / 60 for a, b in zip(rows, rows[1:])], default=None)})
    ready_days = [day for day in days if day["firstAllReadyObservedAt"]]
    sufficient = len(ready_days) >= minimum_sessions and len(ready_days) == len(days) and not any(day["regressedAfterReady"] for day in days)
    candidate = math.ceil(max(day["minutesAfterClose"] for day in ready_days) + 30) if sufficient else None
    latest_close = max((row["dataCutoffAt"] for row in observations), default=None)
    candidate_kst = ((datetime.fromisoformat(latest_close) + timedelta(minutes=candidate)).astimezone(KST).strftime("%H:%M")
                     if candidate is not None and latest_close else None)
    return {"sessions": days, "observedSessions": len(days), "fullyReadySessions": len(ready_days),
            "minimumSessionsForCandidate": minimum_sessions, "provisionalMinutesAfterClose": candidate,
            "provisionalKstTimeUsingLatestSessionClose": candidate_kst,
            "interpretation": "Observed upper bound plus 30 minutes, not a guarantee. Sparse/late scheduler observations cannot locate the exact availability time.",
            "status": "provisional_candidate" if sufficient else "insufficient_or_unstable_evidence"}


def observe(symbols, session, directory):
    deadline = time.monotonic() + 900
    start, end = session - pd.offsets.Day(10), session + pd.offsets.Day(1)
    def request(symbol, attempt):
        if time.monotonic() >= deadline:
            return
        try:
            _download_yahoo_frame(symbol, start, end,
                                  timeout=20, max_retries=2, expected_latest=session,
                                  single_attempt=attempt, diagnostics_dir=directory)
        except Exception:
            pass  # Each HTTP/parse outcome is captured independently by the adapter.

    # Two pairs at a time, at most four HTTP requests. A pair shares identical parameters.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for offset in range(0, len(symbols), 2):
            if time.monotonic() >= deadline:
                break
            futures = [pool.submit(request, symbol, attempt) for symbol in symbols[offset:offset + 2] for attempt in [1, 2]]
            for future in futures:
                future.result()
            if offset % 100 == 0:
                print(f"Observed endpoint pairs: {min(offset + 2, len(symbols))}/{len(symbols)}", flush=True)
    by_symbol = {symbol: [] for symbol in symbols}
    for path in directory.glob("*.json"):
        row = json.loads(path.read_text())
        row["rawReady"] = None
        try:
            raw = gzip.decompress((directory / row["rawFile"]).read_bytes())
            row["rawReady"], row["rawTargetRows"] = raw_readiness(raw, str(session.date()))
        except Exception as error:
            row["rawInspectionError"] = str(error)
        by_symbol[row["symbol"]].append(row)
    return {symbol: summarize_pair(rows) for symbol, rows in by_symbol.items()}


def upload_and_history(snapshot, output, client, bucket):
    prefix = "price-diagnostics/observations/"
    identity = snapshot["observationId"]
    archive = output / "raw-responses.zip"
    with ZipFile(archive, "w", ZIP_DEFLATED) as zipped:
        for path in (output / "raw").iterdir():
            zipped.write(path, path.name)
        zipped.writestr("summary.json", json.dumps(snapshot))
    client.put_object(Bucket=bucket, Key=f"price-diagnostics/raw/{identity}.zip", Body=archive.read_bytes(), ContentType="application/zip")
    snapshot["rawArchiveKey"] = f"price-diagnostics/raw/{identity}.zip"
    key = f"{prefix}{snapshot['marketSessionDate']}/{identity}.json"
    compact = {key: value for key, value in snapshot.items() if key != "checks"}
    client.put_object(Bucket=bucket, Key=key, Body=json.dumps(compact).encode(), ContentType="application/json")
    earliest = (datetime.fromisoformat(snapshot["startedAt"]) - timedelta(days=45)).date().isoformat()
    history = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            if item["Key"][len(prefix):len(prefix) + 10] < earliest:
                continue
            response = client.get_object(Bucket=bucket, Key=item["Key"])
            try:
                history.append(json.loads(response["Body"].read()))
            finally:
                response["Body"].close()
    return history


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("action-output/price-diagnostics"))
    parser.add_argument("--upload-r2", action="store_true")
    args = parser.parse_args()
    started = utc_stamp()
    day = korean_today(datetime.fromisoformat(started))
    session = expected_market_date(day)
    args.output.mkdir(parents=True, exist_ok=True)
    if session.date() != day - timedelta(days=1):
        write_json({"status": "skipped_no_new_us_session", "reportDateKst": str(day)}, args.output / "summary.json")
        return
    config = load_config(Path("config/market-report.yaml"))
    universe = fetch_sp500_snapshot(pd.Timestamp(day))
    symbols = set(universe.ticker.astype(str))
    for key in ["indices", "risk_assets", "sector_proxies"]:
        symbols.update(map(str, config[key].values()))
    for theme in config["themes"].values():
        symbols.update(map(str, theme["members"]))
        symbols.add(str(theme["proxy"]))
    symbols.add(str(config.get("portfolio_report", {}).get("benchmark", "IVV")))
    identity = f"{os.environ.get('GITHUB_RUN_ID', 'local')}-{uuid4().hex}"
    raw_dir = args.output / "raw"
    raw_dir.mkdir()
    checks = observe(sorted(symbols), session, raw_dir)
    finished = utc_stamp()
    context = report_context(day)
    count = sum(row["classification"] == "both_ready" for row in checks.values())
    snapshot = {"schemaVersion": 1, "observationId": identity, **context,
                "runId": os.environ.get("GITHUB_RUN_ID", "local"),
                "startedAt": started, "finishedAt": finished,
                "startedAtKst": datetime.fromisoformat(started).astimezone(KST).isoformat(),
                "finishedAtKst": datetime.fromisoformat(finished).astimezone(KST).isoformat(),
                "scheduledCron": os.environ.get("DIAGNOSTIC_SCHEDULE", "manual"),
                "scheduleNote": "Actual observation times, not guaranteed cron start times; scheduledFor is the report slot, not this diagnostic trigger.",
                "minutesAfterCloseAtFinish": (datetime.fromisoformat(finished) - datetime.fromisoformat(context["dataCutoffAt"])).total_seconds() / 60,
                "requested": len(symbols), "bothReady": count, "allBothReady": count == len(symbols),
                "classifications": dict(Counter(row["classification"] for row in checks.values())),
                "symbolObservations": {symbol: {"bothReady": row["classification"] == "both_ready",
                                                "observedAt": max((server["finishedAt"] for server in row["servers"].values()), default=finished)} for symbol, row in checks.items()},
                "universeSha256": hashlib.sha256(json.dumps(sorted(symbols)).encode()).hexdigest(),
                "codeSha": os.environ.get("GITHUB_SHA", "local"), "checks": checks}
    history = [snapshot]
    write_json(snapshot, args.output / "summary.json")
    if args.upload_r2:
        from .publish_market_report_web import _r2_client
        history = upload_and_history(snapshot, args.output, _r2_client(), os.environ["R2_BUCKET_NAME"])
    timing = timing_report(history)
    write_json(snapshot, args.output / "summary.json")
    write_json(timing, args.output / "timing-report.json")
    summary = (f"## Price availability diagnostics\n\nObserved KST: {snapshot['startedAtKst']} to {snapshot['finishedAtKst']}\n\n"
               f"US session: {session.date()}; both endpoints ready: {count}/{len(symbols)}\n\n"
               f"Timing evidence: {timing['fullyReadySessions']}/{timing['observedSessions']} sessions; "
               f"status: {timing['status']}; provisional minutes after US close: {timing['provisionalMinutesAfterClose']}; "
               f"provisional KST time: {timing['provisionalKstTimeUsingLatestSessionClose']}\n\n"
               "See summary.json for all symbols/raw evidence and timing-report.json for daily availability bounds. This job does not publish reports.\n")
    (args.output / "SUMMARY.md").write_text(summary, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            stream.write(summary)
    print(summary)
    if any(row["classification"] == "missing_observation" for row in checks.values()):
        raise RuntimeError("Diagnostic evidence is incomplete")


if __name__ == "__main__":
    main()
