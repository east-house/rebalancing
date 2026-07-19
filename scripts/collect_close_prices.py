#!/usr/bin/env python3
"""Collect a small closing-price sample and optionally upload it to R2.

The script reads the existing static instrument catalog. It never regenerates
or modifies the catalog. The GitHub Actions test workflow deliberately caps
the sample size so the data-source path can be verified before a full-market
collector is designed.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "public" / "data" / "instruments.json"
DEFAULT_OUTPUT_DIR = ROOT / "action-output"
SEOUL = timezone(timedelta(hours=9), name="KST")
MAX_TEST_INSTRUMENTS = 100

# Keep the first test predictable and include stocks and ETFs in both markets.
PREFERRED_TICKERS = {
    "KR": ("005930", "069500", "000660", "379810", "035420", "005380"),
    "US": ("AAPL", "SPY", "GOOG", "QQQ", "MSFT", "NVDA"),
}


def utc_iso(value: datetime | None = None) -> str:
    current = value or datetime.now(timezone.utc)
    return (
        current.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def load_catalog(path: Path) -> list[dict[str, str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    instruments = payload.get("instruments")
    if not isinstance(instruments, list) or not instruments:
        raise ValueError(f"No instruments found in {path}")

    required = {"ticker", "name", "market", "country", "assetType"}
    valid: list[dict[str, str]] = []
    for item in instruments:
        if not isinstance(item, dict) or not required.issubset(item):
            continue
        valid.append({key: str(item[key]) for key in required})

    if not valid:
        raise ValueError(f"No valid instruments found in {path}")
    return valid


def _preferred_then_remaining(
    instruments: Iterable[dict[str, str]],
    country: str,
    count: int,
) -> list[dict[str, str]]:
    candidates = [item for item in instruments if item["country"] == country]
    by_ticker = {item["ticker"]: item for item in candidates}
    selected = [
        by_ticker[ticker]
        for ticker in PREFERRED_TICKERS[country]
        if ticker in by_ticker
    ][:count]
    selected_tickers = {item["ticker"] for item in selected}

    if len(selected) < count:
        selected.extend(
            item
            for item in candidates
            if item["ticker"] not in selected_tickers
        )
    return selected[:count]


def select_instruments(
    instruments: list[dict[str, str]],
    market: str,
    limit: int,
) -> list[dict[str, str]]:
    if limit < 1:
        raise ValueError("limit must be at least 1")
    if limit > MAX_TEST_INSTRUMENTS:
        raise ValueError(
            f"Test runs are limited to {MAX_TEST_INSTRUMENTS} instruments"
        )

    market = market.upper()
    if market in {"KR", "US"}:
        return _preferred_then_remaining(instruments, market, limit)
    if market != "ALL":
        raise ValueError("market must be one of ALL, KR, or US")

    kr_count = limit // 2
    us_count = limit - kr_count
    selected = [
        *_preferred_then_remaining(instruments, "KR", kr_count),
        *_preferred_then_remaining(instruments, "US", us_count),
    ]

    if len(selected) < limit:
        selected_keys = {
            (item["country"], item["ticker"]) for item in selected
        }
        selected.extend(
            item
            for item in instruments
            if (item["country"], item["ticker"]) not in selected_keys
        )
    return selected[:limit]


def _price_date(value: Any) -> str:
    if hasattr(value, "date"):
        value = value.date()
    return str(value)


def read_close(
    fdr: Any,
    instrument: dict[str, str],
    start: date,
    end: date,
) -> dict[str, Any]:
    frame = fdr.DataReader(
        instrument["ticker"],
        start.isoformat(),
        end.isoformat(),
    )
    if frame is None or frame.empty:
        raise ValueError("No price rows returned")

    column = "Close" if "Close" in frame.columns else "Adj Close"
    if column not in frame.columns:
        raise ValueError(
            f"Close column not returned (columns={list(frame.columns)})"
        )

    closes = frame[column].dropna()
    if closes.empty:
        raise ValueError("No non-null closing price returned")

    last_index = closes.index[-1]
    close = float(closes.iloc[-1])
    return {
        **instrument,
        "close": close,
        "currency": "KRW" if instrument["country"] == "KR" else "USD",
        "priceDate": _price_date(last_index),
        "retrievedAt": utc_iso(),
        "source": "FinanceDataReader",
    }


def collect_quotes(
    instruments: list[dict[str, str]],
    retries: int,
    request_delay: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        import FinanceDataReader as fdr
    except ImportError as error:
        raise RuntimeError(
            "FinanceDataReader is not installed. "
            "Run: pip install finance-datareader"
        ) from error

    seoul_today = datetime.now(SEOUL).date()
    start = seoul_today - timedelta(days=14)
    # Yahoo's period end is exclusive, so include the next calendar day.
    end = seoul_today + timedelta(days=1)
    quotes: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    for position, instrument in enumerate(instruments, start=1):
        ticker = instrument["ticker"]
        print(
            f"[{position}/{len(instruments)}] "
            f"{instrument['country']}:{ticker} {instrument['name']}",
            flush=True,
        )
        last_error: Exception | None = None
        for attempt in range(1, retries + 2):
            try:
                quote = read_close(fdr, instrument, start, end)
                quotes.append(quote)
                print(
                    f"  close={quote['close']} "
                    f"date={quote['priceDate']}",
                    flush=True,
                )
                last_error = None
                break
            except Exception as error:  # Data providers raise varied errors.
                last_error = error
                if attempt <= retries:
                    wait_seconds = min(2**attempt, 8)
                    print(
                        f"  attempt {attempt} failed; "
                        f"retrying in {wait_seconds}s: {error}",
                        flush=True,
                    )
                    time.sleep(wait_seconds)

        if last_error is not None:
            message = f"{type(last_error).__name__}: {last_error}"
            failures.append(
                {
                    **instrument,
                    "error": message[:1000],
                    "failedAt": utc_iso(),
                }
            )
            print(f"  failed: {message}", flush=True)

        if request_delay > 0 and position < len(instruments):
            time.sleep(request_delay)

    return quotes, failures


def json_bytes(payload: Any, *, pretty: bool = True) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    ).encode("utf-8")


def write_outputs(
    output_dir: Path,
    quote_payload: dict[str, Any],
    failure_payload: dict[str, Any],
    summary: dict[str, Any],
) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "quotes": output_dir / "quotes.json",
        "quotes_gzip": output_dir / "quotes.json.gz",
        "failures": output_dir / "failed-tickers.json",
        "summary": output_dir / "run-summary.json",
        "summary_markdown": output_dir / "summary.md",
    }

    quote_data = json_bytes(quote_payload)
    paths["quotes"].write_bytes(quote_data)
    with gzip.open(paths["quotes_gzip"], "wb", compresslevel=9) as archive:
        archive.write(quote_data)
    paths["failures"].write_bytes(json_bytes(failure_payload))
    paths["summary"].write_bytes(json_bytes(summary))
    paths["summary_markdown"].write_text(
        "\n".join(
            [
                "## Closing-price collection test",
                "",
                f"- Run ID: `{summary['runId']}`",
                f"- Requested: {summary['requested']}",
                f"- Succeeded: {summary['succeeded']}",
                f"- Failed: {summary['failed']}",
                f"- Duration: {summary['durationSeconds']} seconds",
                f"- R2 upload: {summary.get('r2', {}).get('status', 'disabled')}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return paths


def required_r2_environment() -> dict[str, str]:
    names = (
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
    )
    values = {name: os.environ.get(name, "").strip() for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(
            "Missing R2 GitHub Actions secrets/variables: "
            + ", ".join(missing)
        )
    return values


def upload_to_r2(
    paths: dict[str, Path],
    summary: dict[str, Any],
    run_id: str,
    prefix: str,
    run_date: str,
) -> dict[str, str]:
    try:
        import boto3
    except ImportError as error:
        raise RuntimeError(
            "boto3 is not installed. Run: pip install boto3"
        ) from error

    values = required_r2_environment()
    prefix = prefix.strip("/")
    base = f"{prefix}/" if prefix else ""
    quote_key = f"{base}quotes/{run_date}/{run_id}/quotes.json.gz"
    latest_key = f"{base}latest/quotes.json.gz"
    summary_key = f"{base}runs/{run_date}/{run_id}.json"
    failures_key = f"{base}runs/{run_date}/{run_id}-failures.json"

    client = boto3.client(
        "s3",
        endpoint_url=(
            f"https://{values['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        ),
        aws_access_key_id=values["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    bucket = values["R2_BUCKET_NAME"]
    quote_data = paths["quotes_gzip"].read_bytes()
    client.put_object(
        Bucket=bucket,
        Key=quote_key,
        Body=quote_data,
        ContentType="application/json",
        ContentEncoding="gzip",
        CacheControl="private, max-age=31536000, immutable",
    )
    client.put_object(
        Bucket=bucket,
        Key=latest_key,
        Body=quote_data,
        ContentType="application/json",
        ContentEncoding="gzip",
        CacheControl="private, no-cache",
    )
    keys = {
        "bucket": bucket,
        "quotes": quote_key,
        "latest": latest_key,
        "summary": summary_key,
        "failures": failures_key,
    }
    summary["r2"] = {"status": "uploaded", **keys}
    paths["summary"].write_bytes(json_bytes(summary))
    client.put_object(
        Bucket=bucket,
        Key=summary_key,
        Body=paths["summary"].read_bytes(),
        ContentType="application/json; charset=utf-8",
        CacheControl="private, no-cache",
    )
    client.put_object(
        Bucket=bucket,
        Key=failures_key,
        Body=paths["failures"].read_bytes(),
        ContentType="application/json; charset=utf-8",
        CacheControl="private, no-cache",
    )
    return keys


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Test closing-price collection from the existing instrument catalog"
        )
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=DEFAULT_CATALOG,
        help="Path to instruments.json",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for test artifacts",
    )
    parser.add_argument(
        "--market",
        choices=("ALL", "KR", "US"),
        default="ALL",
        help="Market sample to collect",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help=f"Number of instruments (maximum {MAX_TEST_INSTRUMENTS})",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=1,
        choices=range(0, 4),
        metavar="{0,1,2,3}",
        help="Retries per ticker",
    )
    parser.add_argument(
        "--request-delay",
        type=float,
        default=0.25,
        help="Delay between tickers in seconds",
    )
    parser.add_argument(
        "--upload-r2",
        action="store_true",
        help="Upload test output to the configured R2 bucket",
    )
    parser.add_argument(
        "--r2-prefix",
        default="test",
        help="R2 object-key prefix",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    started = datetime.now(timezone.utc)
    run_time = datetime.now(SEOUL)
    run_id = (
        f"{run_time.strftime('%Y%m%d-%H%M%S')}-"
        f"{uuid.uuid4().hex[:8]}"
    )

    try:
        catalog = load_catalog(args.catalog)
        selected = select_instruments(catalog, args.market, args.limit)
        if not selected:
            raise RuntimeError("No instruments selected")
        quotes, failures = collect_quotes(
            selected,
            retries=args.retries,
            request_delay=max(args.request_delay, 0),
        )
    except Exception as error:
        print(f"Collector setup failed: {type(error).__name__}: {error}")
        return 1

    finished = datetime.now(timezone.utc)
    duration = round((finished - started).total_seconds(), 2)
    common_meta = {
        "runId": run_id,
        "generatedAt": utc_iso(finished),
        "market": args.market,
        "requested": len(selected),
    }
    quote_payload = {
        "meta": {
            **common_meta,
            "succeeded": len(quotes),
            "failed": len(failures),
        },
        "quotes": quotes,
    }
    failure_payload = {
        "meta": {
            **common_meta,
            "failed": len(failures),
        },
        "failures": failures,
    }
    summary: dict[str, Any] = {
        **common_meta,
        "startedAt": utc_iso(started),
        "finishedAt": utc_iso(finished),
        "succeeded": len(quotes),
        "failed": len(failures),
        "durationSeconds": duration,
        "r2": {"status": "disabled"},
    }
    paths = write_outputs(
        args.output_dir,
        quote_payload,
        failure_payload,
        summary,
    )

    upload_failed = False
    if args.upload_r2:
        try:
            # Add the planned state before uploading the summary itself.
            summary["r2"] = {"status": "uploading"}
            paths = write_outputs(
                args.output_dir,
                quote_payload,
                failure_payload,
                summary,
            )
            keys = upload_to_r2(
                paths,
                summary=summary,
                run_id=run_id,
                prefix=args.r2_prefix,
                run_date=run_time.strftime("%Y-%m-%d"),
            )
            summary["r2"] = {"status": "uploaded", **keys}
            print(
                f"Uploaded test objects to r2://{keys['bucket']}/"
                f"{args.r2_prefix.strip('/')}/",
                flush=True,
            )
        except Exception as error:
            upload_failed = True
            message = f"{type(error).__name__}: {error}"
            summary["r2"] = {
                "status": "failed",
                "error": message[:1000],
            }
            print(f"R2 upload failed: {message}", flush=True)

        # Keep the downloadable Artifact accurate even if the R2 upload failed.
        write_outputs(
            args.output_dir,
            quote_payload,
            failure_payload,
            summary,
        )

    print(
        json.dumps(
            {
                "runId": run_id,
                "requested": len(selected),
                "succeeded": len(quotes),
                "failed": len(failures),
                "durationSeconds": duration,
                "r2Status": summary["r2"]["status"],
                "outputDirectory": str(args.output_dir),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    if upload_failed or not quotes:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
