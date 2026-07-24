#!/usr/bin/env python3
"""Merge per-shard latest quotes and USD/KRW into one R2 API object."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from scripts.collect_close_prices import (
    _decode_history,
    _history_bytes,
    required_r2_environment,
    shard_quote_object_key,
    utc_iso,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "aggregate-output"
COMBINED_OBJECT_NAME = "latest/quotes/all.json.gz"


def combined_object_key(prefix: str) -> str:
    base = f"{prefix.strip('/')}/" if prefix.strip("/") else ""
    return f"{base}{COMBINED_OBJECT_NAME}"


def _read_body(response: dict[str, Any]) -> bytes:
    body = response["Body"]
    if hasattr(body, "read"):
        try:
            return bytes(body.read())
        finally:
            if hasattr(body, "close"):
                body.close()
    return bytes(body)


def load_json_object(
    client: Any,
    bucket: str,
    key: str,
) -> dict[str, Any] | None:
    try:
        response = client.get_object(Bucket=bucket, Key=key)
    except Exception as error:
        response_data = getattr(error, "response", {})
        code = str(response_data.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    return _decode_history(_read_body(response))


def _normalise_closes(
    value: Any,
    limit: int | None = 2,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    by_date: dict[str, float] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        price_date = str(item.get("date", ""))
        try:
            date.fromisoformat(price_date)
            close = float(item.get("close"))
        except (TypeError, ValueError):
            continue
        if close > 0:
            by_date[price_date] = close
    closes = [
        {"date": price_date, "close": by_date[price_date]}
        for price_date in sorted(by_date)
    ]
    return closes[-limit:] if limit is not None else closes


def normalise_quote(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    ticker = str(value.get("ticker", "")).strip().upper()
    name = str(value.get("name", "")).strip()
    country = str(value.get("country", "")).strip().upper()
    asset_type = str(value.get("assetType", "")).strip().upper()
    currency = str(value.get("currency", "")).strip().upper()
    closes = _normalise_closes(value.get("closes"))
    if (
        not ticker
        or not name
        or country not in {"KR", "US"}
        or asset_type not in {"STOCK", "ETF"}
        or currency not in {"KRW", "USD"}
        or not closes
    ):
        return None
    return {
        "ticker": ticker,
        "name": name,
        "country": country,
        "assetType": asset_type,
        "currency": currency,
        "closes": closes,
    }


def normalise_fx(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    closes = _normalise_closes(value.get("closes"), limit=None)
    if not closes:
        return None
    return {
        "pair": "USD/KRW",
        "currency": "KRW",
        "closes": closes,
    }


def build_combined_payload(
    shard_payloads: list[dict[str, Any]],
    usd_krw: dict[str, Any],
    generated_at: str,
    expected_shard_count: int,
) -> dict[str, Any]:
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    available_shards: set[int] = set()
    incomplete_shards: set[int] = set()
    for payload in shard_payloads:
        shard = payload.get("shard")
        shard_index = (
            shard.get("index")
            if isinstance(shard, dict)
            and shard.get("count") == expected_shard_count
            and isinstance(shard.get("index"), int)
            and 0 <= shard["index"] < expected_shard_count
            else None
        )
        if shard_index is None:
            continue
        available_shards.add(shard_index)
        raw_quotes = payload.get("quotes")
        if not isinstance(raw_quotes, list):
            incomplete_shards.add(shard_index)
            continue
        valid_quote_count = 0
        for raw_quote in raw_quotes:
            quote = normalise_quote(raw_quote)
            if quote is not None:
                by_key[(quote["country"], quote["ticker"])] = quote
                valid_quote_count += 1
        expected_quote_count = payload.get("expectedQuoteCount")
        if (
            not isinstance(expected_quote_count, int)
            or expected_quote_count < 0
            or valid_quote_count < expected_quote_count
        ):
            incomplete_shards.add(shard_index)

    quotes = [by_key[key] for key in sorted(by_key)]
    if not quotes:
        raise ValueError("No valid shard quotes are available")
    normalised_rate = normalise_fx(usd_krw)
    if normalised_rate is None:
        raise ValueError("A valid USD/KRW rate is required")
    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "expectedShardCount": expected_shard_count,
        "availableShards": sorted(available_shards),
        "incompleteShards": sorted(incomplete_shards),
        "complete": (
            available_shards == set(range(expected_shard_count))
            and not incomplete_shards
        ),
        "quoteCount": len(quotes),
        "fx": {"usdKrw": normalised_rate},
        "quotes": quotes,
    }


def fetch_usd_krw(today: date) -> dict[str, Any]:
    try:
        import FinanceDataReader as fdr
    except ImportError as error:
        raise RuntimeError("FinanceDataReader is not installed") from error

    frame = fdr.DataReader(
        "USD/KRW",
        (today - timedelta(days=365)).isoformat(),
        (today + timedelta(days=1)).isoformat(),
    )
    if frame is None or frame.empty:
        raise ValueError("No USD/KRW rows returned")
    column = "Close" if "Close" in frame.columns else "Adj Close"
    if column not in frame.columns:
        raise ValueError("USD/KRW response has no close column")
    closes = [
        {
            "date": (
                index.date().isoformat()
                if hasattr(index, "date")
                else str(index)[:10]
            ),
            "close": float(raw_close),
        }
        for index, raw_close in frame[column].dropna().items()
        if float(raw_close) > 0
    ]
    rate = normalise_fx({"closes": closes})
    if rate is None:
        raise ValueError("USD/KRW response has no valid closes")
    return rate


def write_outputs(
    output_dir: Path,
    summary: dict[str, Any],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "run-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "summary.md").write_text(
        "\n".join(
            [
                "## Latest quote aggregation",
                "",
                f"- Quotes: {summary['quoteCount']}",
                (
                    "- Available shards: "
                    f"{summary['availableShardCount']}/"
                    f"{summary['expectedShardCount']}"
                ),
                (
                    "- Incomplete shards: "
                    + (
                        ", ".join(
                            str(value)
                            for value in summary["incompleteShards"]
                        )
                        or "none"
                    )
                ),
                f"- Complete: {str(summary['complete']).lower()}",
                f"- USD/KRW date: {summary['usdKrwAsOf']}",
                f"- R2 object: `{summary['r2Object']}`",
                "",
            ]
        ),
        encoding="utf-8",
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge shard quote snapshots for the Worker API"
    )
    parser.add_argument("--shard-count", type=int, default=8)
    parser.add_argument("--r2-prefix", default="market-data")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.shard_count < 1:
        print("--shard-count must be positive")
        return 1

    try:
        import boto3
    except ImportError:
        print("boto3 is not installed")
        return 1

    try:
        values = required_r2_environment()
        client = boto3.client(
            "s3",
            endpoint_url=(
                "https://"
                f"{values['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
            ),
            aws_access_key_id=values["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )
        bucket = values["R2_BUCKET_NAME"]
        shard_payloads = [
            payload
            for shard_index in range(args.shard_count)
            if (
                payload := load_json_object(
                    client,
                    bucket,
                    shard_quote_object_key(shard_index, args.r2_prefix),
                )
            )
            is not None
        ]
        combined_key = combined_object_key(args.r2_prefix)
        previous = load_json_object(client, bucket, combined_key)
        try:
            usd_krw = fetch_usd_krw(date.today())
        except Exception:
            previous_fx = (previous or {}).get("fx")
            usd_krw = normalise_fx(
                previous_fx.get("usdKrw")
                if isinstance(previous_fx, dict)
                else None
            )
            if usd_krw is None:
                raise
        payload = build_combined_payload(
            shard_payloads,
            usd_krw,
            utc_iso(),
            args.shard_count,
        )
        client.put_object(
            Bucket=bucket,
            Key=combined_key,
            Body=_history_bytes(payload),
            ContentType="application/json",
            ContentEncoding="gzip",
            CacheControl="public, max-age=300",
        )
        summary = {
            "generatedAt": payload["generatedAt"],
            "quoteCount": payload["quoteCount"],
            "availableShardCount": len(payload["availableShards"]),
            "incompleteShards": payload["incompleteShards"],
            "expectedShardCount": payload["expectedShardCount"],
            "complete": payload["complete"],
            "usdKrwAsOf": payload["fx"]["usdKrw"]["closes"][-1]["date"],
            "r2Object": combined_key,
        }
        write_outputs(args.output_dir, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(f"Aggregation failed: {type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
